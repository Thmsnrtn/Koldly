/**
 * Stripe Billing Service
 *
 * Handles: checkout sessions, customer portal, webhooks, invoices, subscription management.
 * Plans: starter ($29), growth ($79), scale ($199)
 */

const Stripe = require('stripe');

class StripeService {
  constructor(pool) {
    this.pool = pool;
    this.stripe = process.env.STRIPE_SECRET_KEY
      ? new Stripe(process.env.STRIPE_SECRET_KEY)
      : null;

    // Plan → Stripe price ID mapping (set these in env vars)
    this.priceMap = {
      starter: process.env.STRIPE_PRICE_STARTER || null,
      growth: process.env.STRIPE_PRICE_GROWTH || null,
      scale: process.env.STRIPE_PRICE_SCALE || null
    };

    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;
  }

  /**
   * Create or retrieve Stripe customer for a user
   */
  async getOrCreateCustomer(userId) {
    if (!this.stripe) throw new Error('Stripe not configured');

    const user = await this.pool.query(
      'SELECT id, email, name, stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );
    if (user.rows.length === 0) throw new Error('User not found');
    const u = user.rows[0];

    if (u.stripe_customer_id) {
      return u.stripe_customer_id;
    }

    // Create new customer
    const customer = await this.stripe.customers.create({
      email: u.email,
      name: u.name || undefined,
      metadata: { user_id: String(u.id) }
    });

    await this.pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, userId]
    );

    return customer.id;
  }

  /**
   * Create a Stripe Checkout session for subscription
   */
  async createCheckoutSession(userId, plan) {
    if (!this.stripe) throw new Error('Stripe not configured');

    const priceId = this.priceMap[plan];
    if (!priceId) throw new Error(`Unknown plan: ${plan}`);

    const customerId = await this.getOrCreateCustomer(userId);
    const appUrl = process.env.APP_URL || 'https://koldly.com';

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${appUrl}/billing?canceled=true`,
      metadata: { user_id: String(userId), plan },
      subscription_data: {
        metadata: { user_id: String(userId), plan }
      }
    });

    return { url: session.url, session_id: session.id };
  }

  /**
   * Create a Stripe Customer Portal session
   */
  async createPortalSession(userId) {
    if (!this.stripe) throw new Error('Stripe not configured');

    const customerId = await this.getOrCreateCustomer(userId);
    const appUrl = process.env.APP_URL || 'https://koldly.com';

    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/billing`
    });

    return { url: session.url };
  }

  /**
   * Get invoices for a user
   */
  async getInvoices(userId, limit = 10) {
    if (!this.stripe) return [];

    const user = await this.pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );
    if (!user.rows[0]?.stripe_customer_id) return [];

    const invoices = await this.stripe.invoices.list({
      customer: user.rows[0].stripe_customer_id,
      limit
    });

    return invoices.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      amount: inv.amount_paid / 100,
      currency: inv.currency,
      status: inv.status,
      created: new Date(inv.created * 1000).toISOString(),
      pdf_url: inv.invoice_pdf,
      hosted_url: inv.hosted_invoice_url
    }));
  }

  /**
   * Get current subscription details
   */
  async getSubscription(userId) {
    const user = await this.pool.query(`
      SELECT subscription_plan, subscription_status, subscription_expires_at,
             stripe_customer_id, stripe_subscription_id
      FROM users WHERE id = $1
    `, [userId]);

    if (user.rows.length === 0) throw new Error('User not found');
    const u = user.rows[0];

    const planDetails = {
      free: { name: 'Free', price: 0, prospects: 25, campaigns: 1 },
      starter: { name: 'Starter', price: 29, prospects: 100, campaigns: 1 },
      growth: { name: 'Growth', price: 79, prospects: 500, campaigns: 5 },
      scale: { name: 'Scale', price: 199, prospects: 2000, campaigns: -1 }
    };

    const plan = u.subscription_plan || 'free';
    return {
      plan,
      details: planDetails[plan] || planDetails.free,
      status: u.subscription_status || 'inactive',
      expires_at: u.subscription_expires_at,
      has_stripe: !!u.stripe_customer_id
    };
  }

  // ---- Webhook handling ----

  /**
   * Verify and parse a Stripe webhook event
   */
  verifyWebhook(rawBody, signature) {
    if (!this.stripe || !this.webhookSecret) {
      throw new Error('Stripe webhooks not configured');
    }
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  /**
   * Process a webhook event (with dedup)
   */
  async processWebhookEvent(event) {
    // Dedup check
    const existing = await this.pool.query(
      'SELECT id FROM stripe_events WHERE id = $1',
      [event.id]
    );
    if (existing.rows.length > 0) {
      console.log(`[Stripe] Duplicate event ${event.id}, skipping`);
      return { skipped: true };
    }

    // Record event
    await this.pool.query(
      'INSERT INTO stripe_events (id, event_type) VALUES ($1, $2)',
      [event.id, event.type]
    );

    // Handle event types
    switch (event.type) {
      case 'checkout.session.completed':
        return this._handleCheckoutCompleted(event.data.object);
      case 'invoice.paid':
        return this._handleInvoicePaid(event.data.object);
      case 'customer.subscription.updated':
        return this._handleSubscriptionUpdated(event.data.object);
      case 'customer.subscription.deleted':
        return this._handleSubscriptionDeleted(event.data.object);
      case 'invoice.payment_failed':
        return this._handlePaymentFailed(event.data.object);
      default:
        console.log(`[Stripe] Unhandled event type: ${event.type}`);
        return { handled: false };
    }
  }

  async _handleCheckoutCompleted(session) {
    const userId = session.metadata?.user_id;
    const plan = session.metadata?.plan;
    if (!userId || !plan) return;

    await this.pool.query(`
      UPDATE users SET
        subscription_plan = $1,
        subscription_status = 'active',
        stripe_subscription_id = $2,
        subscription_updated_at = NOW()
      WHERE id = $3
    `, [plan, session.subscription, userId]);

    console.log(`[Stripe] User #${userId} subscribed to ${plan}`);
    return { handled: true, action: 'subscription_created' };
  }

  async _handleInvoicePaid(invoice) {
    const customerId = invoice.customer;
    const user = await this.pool.query(
      'SELECT id FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );
    if (user.rows.length === 0) return;

    // Extend subscription expiry
    const periodEnd = invoice.lines?.data?.[0]?.period?.end;
    if (periodEnd) {
      await this.pool.query(`
        UPDATE users SET
          subscription_status = 'active',
          subscription_expires_at = to_timestamp($1),
          subscription_updated_at = NOW()
        WHERE stripe_customer_id = $2
      `, [periodEnd, customerId]);
    }

    console.log(`[Stripe] Invoice paid for customer ${customerId}`);
    return { handled: true, action: 'invoice_paid' };
  }

  async _handleSubscriptionUpdated(subscription) {
    const userId = subscription.metadata?.user_id;
    if (!userId) return;

    const plan = subscription.metadata?.plan || 'starter';
    const status = subscription.status === 'active' ? 'active' : subscription.status;

    await this.pool.query(`
      UPDATE users SET
        subscription_plan = $1,
        subscription_status = $2,
        subscription_updated_at = NOW()
      WHERE id = $3
    `, [plan, status, userId]);

    console.log(`[Stripe] Subscription updated for user #${userId}: ${plan} (${status})`);
    return { handled: true, action: 'subscription_updated' };
  }

  async _handleSubscriptionDeleted(subscription) {
    const userId = subscription.metadata?.user_id;
    if (!userId) return;

    await this.pool.query(`
      UPDATE users SET
        subscription_plan = 'free',
        subscription_status = 'canceled',
        stripe_subscription_id = NULL,
        subscription_updated_at = NOW()
      WHERE id = $1
    `, [userId]);

    console.log(`[Stripe] Subscription canceled for user #${userId}`);
    return { handled: true, action: 'subscription_canceled' };
  }

  async _handlePaymentFailed(invoice) {
    const customerId = invoice.customer;
    const user = await this.pool.query(
      'SELECT id, email FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );
    if (user.rows.length === 0) return;

    const userId = user.rows[0].id;

    await this.pool.query(`
      UPDATE users SET
        subscription_status = 'past_due',
        subscription_updated_at = NOW()
      WHERE stripe_customer_id = $1
    `, [customerId]);

    // Start dunning sequence (Day 0 immediate notification)
    try {
      const DecisionQueueService = require('./decision-queue-service');
      const dq = new DecisionQueueService(this.pool);

      // Day 0: Immediate payment failed notification (Gate 1)
      await dq.enqueue(
        `Dunning Day 0: Payment failed for ${user.rows[0].email}`,
        'revenue', 'high', 1,
        { action_type: 'dunning_day0', user_id: userId, email: user.rows[0].email, template: 'payment_failed_day0' },
        'system'
      );

      // Record retention actions for future dunning steps
      await this.pool.query(
        "INSERT INTO retention_actions (user_id, action_type, trigger_reason, metadata) VALUES ($1, 'dunning_day0', 'Payment failed', $2)",
        [userId, JSON.stringify({ customer_id: customerId, invoice_id: invoice.id })]
      );

      console.log(`[Stripe] Dunning sequence started for user #${userId}`);
    } catch (dunningErr) {
      console.error('[Stripe] Dunning sequence creation failed:', dunningErr.message);
    }

    console.log(`[Stripe] Payment failed for customer ${customerId}, status set to past_due`);
    return { handled: true, action: 'payment_failed' };
  }

  // ---- Dunning sequence continuation ----

  /**
   * Process pending dunning actions. Called daily by scheduler.
   * Sends Day 3, Day 7, Day 14 dunning emails.
   */
  async processDunningSequence() {
    const DecisionQueueService = require('./decision-queue-service');
    const dq = new DecisionQueueService(this.pool);

    // Day 3: Gentle reminder
    const day3 = await this.pool.query(`
      SELECT ra.user_id, u.email FROM retention_actions ra
      JOIN users u ON ra.user_id = u.id
      WHERE ra.action_type = 'dunning_day0'
        AND ra.created_at <= NOW() - INTERVAL '3 days'
        AND u.subscription_status = 'past_due'
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra2
          WHERE ra2.user_id = ra.user_id AND ra2.action_type = 'dunning_day3'
        )
    `);

    for (const user of day3.rows) {
      await dq.enqueue(
        `Dunning Day 3: Reminder for ${user.email}`,
        'revenue', 'high', 1,
        { action_type: 'dunning_day3', user_id: user.user_id, email: user.email, template: 'payment_failed_day3' },
        'system'
      );
      await this.pool.query(
        "INSERT INTO retention_actions (user_id, action_type, trigger_reason) VALUES ($1, 'dunning_day3', 'Day 3 dunning reminder')",
        [user.user_id]
      );
    }

    // Day 7: Urgent notice
    const day7 = await this.pool.query(`
      SELECT ra.user_id, u.email FROM retention_actions ra
      JOIN users u ON ra.user_id = u.id
      WHERE ra.action_type = 'dunning_day0'
        AND ra.created_at <= NOW() - INTERVAL '7 days'
        AND u.subscription_status = 'past_due'
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra2
          WHERE ra2.user_id = ra.user_id AND ra2.action_type = 'dunning_day7'
        )
    `);

    for (const user of day7.rows) {
      await dq.enqueue(
        `Dunning Day 7: Urgent for ${user.email}`,
        'revenue', 'high', 2,
        { action_type: 'dunning_day7', user_id: user.user_id, email: user.email, template: 'payment_failed_day7' },
        'system'
      );
      await this.pool.query(
        "INSERT INTO retention_actions (user_id, action_type, trigger_reason) VALUES ($1, 'dunning_day7', 'Day 7 dunning urgent')",
        [user.user_id]
      );
    }

    // Day 14: Final notice + downgrade
    const day14 = await this.pool.query(`
      SELECT ra.user_id, u.email FROM retention_actions ra
      JOIN users u ON ra.user_id = u.id
      WHERE ra.action_type = 'dunning_day0'
        AND ra.created_at <= NOW() - INTERVAL '14 days'
        AND u.subscription_status = 'past_due'
        AND NOT EXISTS (
          SELECT 1 FROM retention_actions ra2
          WHERE ra2.user_id = ra.user_id AND ra2.action_type = 'dunning_day14'
        )
    `);

    for (const user of day14.rows) {
      // Downgrade to free
      await this.pool.query(
        "UPDATE users SET subscription_plan = 'free', subscription_status = 'canceled' WHERE id = $1",
        [user.user_id]
      );
      await dq.enqueue(
        `Dunning Day 14: Downgraded ${user.email} to free`,
        'revenue', 'high', 2,
        { action_type: 'dunning_day14', user_id: user.user_id, email: user.email, template: 'payment_failed_day14' },
        'system'
      );
      await this.pool.query(
        "INSERT INTO retention_actions (user_id, action_type, trigger_reason) VALUES ($1, 'dunning_day14', 'Day 14 final notice + downgrade')",
        [user.user_id]
      );
    }

    return { day3: day3.rows.length, day7: day7.rows.length, day14: day14.rows.length };
  }

  // ---- Revenue metrics ----

  /**
   * Calculate real MRR from active subscriptions in the database
   */
  async calculateMRR() {
    const planPrices = { starter: 29, growth: 79, scale: 199 };

    const result = await this.pool.query(`
      SELECT subscription_plan, COUNT(*) as count
      FROM users
      WHERE subscription_status = 'active'
        AND subscription_plan IN ('starter', 'growth', 'scale')
      GROUP BY subscription_plan
    `);

    let mrr = 0;
    const breakdown = {};
    for (const row of result.rows) {
      const planMRR = (planPrices[row.subscription_plan] || 0) * parseInt(row.count);
      breakdown[row.subscription_plan] = { count: parseInt(row.count), mrr: planMRR };
      mrr += planMRR;
    }

    return { mrr, breakdown };
  }
}

module.exports = StripeService;
