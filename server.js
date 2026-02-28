const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { initializeScheduler } = require('./lib/scheduler');
const EmailService = require('./lib/email-service');
const WebhookService = require('./lib/webhook-service');
const SlackService = require('./lib/slack-service');
const AuthService = require('./lib/auth-service');
const OAuthService = require('./lib/oauth-service');
const CampaignSendingService = require('./lib/campaign-sending-service');
const ProofService = require('./lib/proof-service');
const ProspectDiscoveryService = require('./lib/prospect-discovery-service');
const EmailGenerationService = require('./lib/email-generation-service');
const ApprovalService = require('./lib/approval-service');
const ReplyResponseService = require('./lib/reply-response-service');
const StripeService = require('./lib/stripe-service');
const EcosystemService = require('./lib/ecosystem-service');
const DecisionQueueService = require('./lib/decision-queue-service');
const RetentionService = require('./lib/retention-service');
const SupportService = require('./lib/support-service');
const ProductIntelligenceService = require('./lib/product-intelligence-service');
const MarketingService = require('./lib/marketing-service');
const OnboardingService = require('./lib/onboarding-service');
const auditLogger = require('./lib/audit-logger');
const RetryService = require('./lib/retry-service');
const idempotencyService = require('./lib/idempotency');
const { registerInboxRoutes } = require('./lib/inbox-routes');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// Initialize app
const app = express();
const port = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Use verify-full for production SSL (instead of deprecated 'require')
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  // CRITICAL: Set connection timeout to prevent hanging on Neon cold-start
  connectionTimeoutMillis: 10000,
  // Connection pool configuration for production stability
  min: 2,
  max: 10,
  idleTimeoutMillis: 30000
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"],
    }
  }
}));

// CORS Configuration
const allowedOrigins = [
  'https://koldly.com',
  'https://www.koldly.com',
  process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : undefined
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Stripe webhook needs raw body for signature verification — must be before json parser
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripeService.verifyWebhook(req.body, sig);
    const result = await stripeService.processWebhookEvent(event);
    res.json({ received: true, ...result });
  } catch (err) {
    console.error('[Stripe Webhook] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Inbound email webhook (SES/Mailgun) — needs raw JSON parsing
app.post('/api/webhooks/inbound', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const provider = process.env.COLD_ESP_PROVIDER || 'unknown';
    let fromEmail, subject, body, toEmail, messageId;

    if (provider === 'mailgun') {
      // Mailgun inbound format
      fromEmail = req.body.sender || req.body.from;
      subject = req.body.subject;
      body = req.body['stripped-text'] || req.body['body-plain'] || '';
      toEmail = req.body.recipient;
      messageId = req.body['Message-Id'];
    } else if (provider === 'ses') {
      // SES inbound format (SNS notification)
      const message = typeof req.body.Message === 'string' ? JSON.parse(req.body.Message) : req.body;
      const mail = message.mail || {};
      const content = message.content || '';
      fromEmail = mail.source || mail.commonHeaders?.from?.[0];
      subject = mail.commonHeaders?.subject;
      toEmail = mail.destination?.[0];
      messageId = mail.messageId;
      body = content;
    } else {
      // Generic format
      fromEmail = req.body.from || req.body.sender;
      subject = req.body.subject;
      body = req.body.text || req.body.body || '';
      toEmail = req.body.to || req.body.recipient;
      messageId = req.body.message_id;
    }

    if (!fromEmail) {
      return res.status(400).json({ error: 'No sender email found in payload' });
    }

    console.log(`[Inbound] Reply from ${fromEmail}: "${subject}"`);

    // Match to a prospect by email
    const prospectMatch = await pool.query(`
      SELECT p.id as prospect_id, p.campaign_id, c.user_id
      FROM prospects p
      JOIN campaigns c ON c.id = p.campaign_id
      WHERE p.email = $1 OR EXISTS (
        SELECT 1 FROM generated_emails ge WHERE ge.recipient_email = $1 AND ge.campaign_id = p.campaign_id
      )
      ORDER BY p.created_at DESC LIMIT 1
    `, [fromEmail.toLowerCase()]);

    if (prospectMatch.rows.length > 0) {
      const match = prospectMatch.rows[0];

      // Store in prospect_reply_inbox
      await pool.query(`
        INSERT INTO prospect_reply_inbox (prospect_id, campaign_id, from_email, subject, body, received_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT DO NOTHING
      `, [match.prospect_id, match.campaign_id, fromEmail, subject || '(no subject)', body]);

      // Trigger AI categorization in background
      replyResponseService.categorizeReply(match.prospect_id, match.user_id).catch(err => {
        console.error('[Inbound] Categorization failed:', err.message);
      });

      console.log(`[Inbound] Reply matched to prospect ${match.prospect_id}, campaign ${match.campaign_id}`);
    } else {
      console.log(`[Inbound] No prospect match for ${fromEmail}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Inbound Webhook] Error:', err.message);
    res.status(500).json({ error: 'Failed to process inbound email' });
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Request timeout middleware - prevent hanging requests
// Set reasonable timeouts based on endpoint type
app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth/')) {
    // Auth endpoints: 12 seconds (includes SMTP delays)
    res.setTimeout(12000, () => {
      console.error(`[Timeout] Auth endpoint timeout: ${req.method} ${req.path}`);
      res.status(408).json({ error: 'Request timeout. Please try again.' });
    });
  } else if (req.path.startsWith('/api/analytics')) {
    // Analytics can take longer (30 seconds)
    res.setTimeout(30000, () => {
      console.error(`[Timeout] Analytics endpoint timeout: ${req.method} ${req.path}`);
      res.status(408).json({ error: 'Analytics query timed out. Please try again.' });
    });
  } else if (req.path.startsWith('/api/')) {
    // Standard API endpoints: 15 seconds
    res.setTimeout(15000, () => {
      console.error(`[Timeout] API endpoint timeout: ${req.method} ${req.path}`);
      res.status(408).json({ error: 'Request timeout. Please try again.' });
    });
  }
  next();
});

// Trust proxy for correct client IP in production
app.set('trust proxy', 1);

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30
});

// Aggressive rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  message: 'Too many login/signup attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 password reset attempts per hour
  message: 'Too many password reset attempts. Please try again later.'
});

// ============================================
// INTERNAL API ROUTES (Ecosystem — before rate limiter)
// ============================================

const ecosystemAuth = ecosystemService.middleware();

app.get('/internal/health', ecosystemAuth, (req, res) => {
  res.json({ status: 'ok', service: 'koldly', timestamp: new Date().toISOString() });
});

app.post('/internal/campaign/create', ecosystemAuth, async (req, res) => {
  try {
    const { program, prospects, config } = req.body;
    if (!program) return res.status(400).json({ error: 'program is required' });
    const result = await ecosystemService.createProgramCampaign(program, prospects || [], config || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Internal API] Campaign create error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/internal/campaign/:campaignId/status', ecosystemAuth, async (req, res) => {
  try {
    const status = await ecosystemService.getCampaignStatus(parseInt(req.params.campaignId));
    if (!status) return res.status(404).json({ error: 'Campaign not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/internal/operator/dashboard-data', ecosystemAuth, async (req, res) => {
  try {
    const data = await ecosystemService.getDashboardData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rate limiter — skip for ecosystem-authenticated requests
app.use('/api/', (req, res, next) => {
  if (req.ecosystemAuthenticated) return next();
  apiLimiter(req, res, next);
});

// ============================================
// PAGE VIEW TRACKING MIDDLEWARE
// ============================================
// CRITICAL: Must come BEFORE express.static() to track page views

app.use(async (req, res, next) => {
  const isPageView = !req.path.startsWith('/api') &&
                     !req.path.startsWith('/images') &&
                     !req.path.startsWith('/css') &&
                     !req.path.startsWith('/js') &&
                     !req.path.startsWith('/health') &&
                     !req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|css|js)$/i) &&
                     req.method === 'GET';

  if (isPageView) {
    // Capture tracking data
    const userAgent = req.headers['user-agent'] || null;
    const referrer = req.headers['referer'] || null;

    // Generate or retrieve session ID from cookie
    let sessionId = req.cookies?.analytics_session;
    if (!sessionId) {
      sessionId = crypto.randomBytes(16).toString('hex');
      res.cookie('analytics_session', sessionId, {
        maxAge: 30 * 60 * 1000, // 30 minutes
        httpOnly: true,
        sameSite: 'lax'
      });
    }

    // Fire and forget - don't await to avoid slowing page loads
    trackEvent('page_view', null, { path: req.path }, {
      user_agent: userAgent,
      referrer: referrer,
      session_id: sessionId
    }).catch(err => console.error('Page view tracking failed:', err.message));
  }
  next();
});

// IMPORTANT: Serve static files AFTER tracking middleware
app.use(express.static('public', {
  dotfiles: 'deny',
  index: ['index.html'],
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// Initialize services
const authService = new AuthService(pool);
const oauthService = new OAuthService(pool);
const emailService = new EmailService(pool);
const campaignSendingService = new CampaignSendingService(pool);
const proofService = new ProofService(pool);
const discoveryService = new ProspectDiscoveryService(pool);
const emailGenService = new EmailGenerationService(pool);
const approvalService = new ApprovalService(pool);
const replyResponseService = new ReplyResponseService(pool);
const stripeService = new StripeService(pool);
const ecosystemService = new EcosystemService(pool);
const decisionQueueService = new DecisionQueueService(pool);
const retentionService = new RetentionService(pool);
const supportService = new SupportService(pool);
const productIntelService = new ProductIntelligenceService(pool);
const marketingService = new MarketingService(pool);
const onboardingServiceAuto = new OnboardingService(pool);
const webhookService = new WebhookService();
const slackService = new SlackService();

// Register inbox routes
registerInboxRoutes(app, pool, authService);

// ============================================
// ANALYTICS TRACKING HELPER
// ============================================

async function trackEvent(eventType, userId = null, metadata = {}, options = {}) {
  try {
    const { user_agent, referrer, session_id } = options;

    await pool.query(`
      INSERT INTO analytics_events (event_type, user_id, metadata, user_agent, referrer, session_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      eventType,
      userId,
      JSON.stringify(metadata),
      user_agent || null,
      referrer || null,
      session_id || null
    ]);

    // Console logging for Render
    console.log(JSON.stringify({
      event: 'analytics_event',
      timestamp: new Date().toISOString(),
      event_type: eventType,
      user_id: userId,
      metadata: metadata,
      user_agent: user_agent || null,
      referrer: referrer || null,
      session_id: session_id || null
    }));
  } catch (err) {
    console.error('[analytics] Tracking error:', err.message);
  }
}

// ============================================
// AUTHENTICATION MIDDLEWARE (Server-side)
// ============================================

function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.auth_token;

    if (!token) {
      return res.status(401).redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).redirect(`/login?message=Session+expired&redirect=${encodeURIComponent(req.originalUrl)}`);
    }

    req.userId = decoded.userId;

    // Gate: redirect to onboarding if not completed (skip for onboarding page itself and API routes)
    if (req.path !== '/onboarding' && !req.path.startsWith('/api/')) {
      pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [decoded.userId])
        .then(result => {
          if (result.rows[0] && !result.rows[0].onboarding_completed) {
            return res.redirect('/onboarding');
          }
          next();
        })
        .catch(() => next());
      return;
    }

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(401).redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
}

// ============================================
// PUBLIC ROUTES
// ============================================

app.get('/health', async (req, res) => {
  const startTime = Date.now();
  const response = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };

  // Optional: check database connectivity if ?check=db is passed
  if (req.query.check === 'db') {
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      client.release();
      response.database = 'connected';
      response.dbLatency = Date.now() - startTime;
    } catch (error) {
      console.error('[Health] Database check failed:', error.message);
      response.database = 'disconnected';
      response.error = error.message;
      return res.status(503).json(response);
    }
  }

  res.json(response);
});

// ============================================
// HTML FILE CACHE (read once at startup, serve from memory)
// ============================================
const htmlCache = new Map();
function loadHtml(filename) {
  const filePath = path.join(__dirname, 'public', filename);
  try {
    htmlCache.set(filename, fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[Cache] Failed to load ${filename}:`, err.message);
  }
}
function serveHtml(filename) {
  return (req, res) => {
    const cached = htmlCache.get(filename);
    if (cached) {
      res.type('html').send(cached);
    } else {
      // Fallback to disk read (shouldn't happen in production)
      res.type('html').send(fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8'));
    }
  };
}
// Pre-load all HTML pages into cache
['proof.html', 'demo.html', 'onboarding.html', 'pricing.html', 'settings.html',
 'dashboard.html', 'campaigns.html', 'analytics.html', 'integrations.html',
 'campaign-sending.html', 'inbox.html', 'admin-metrics.html', 'login.html',
 'signup.html', 'forgot-password.html', 'reset-password.html', 'terms.html',
 'privacy.html', 'billing.html', 'queue.html', 'pipeline.html', 'operator.html',
 '404.html'
].forEach(loadHtml);

// Serve HTML pages from cache
app.get('/proof', serveHtml('proof.html'));
app.get('/demo', serveHtml('demo.html'));
app.get('/onboarding', serveHtml('onboarding.html'));
app.get('/pricing', serveHtml('pricing.html'));
app.get('/settings', requireAuth, serveHtml('settings.html'));
app.get('/dashboard', requireAuth, serveHtml('dashboard.html'));
app.get('/campaigns', requireAuth, serveHtml('campaigns.html'));
app.get('/analytics', requireAuth, serveHtml('analytics.html'));
app.get('/integrations', requireAuth, serveHtml('integrations.html'));
app.get('/campaign-sending', requireAuth, serveHtml('campaign-sending.html'));
app.get('/inbox', requireAuth, serveHtml('inbox.html'));
app.get('/admin/metrics', requireAuth, serveHtml('admin-metrics.html'));
app.get('/operator', requireAuth, serveHtml('operator.html'));

// Proof/Demo API endpoint
app.post('/api/proof', async (req, res) => {
  try {
    const { company_name, contact_name } = req.body;

    if (!company_name) {
      return res.status(400).json({ error: 'company_name is required' });
    }

    // Generate sample email
    const sampleEmail = await proofService.generateSampleEmail(company_name, contact_name);

    // Get campaign metrics
    const metrics = await proofService.getCampaignMetrics();

    res.json({
      success: true,
      sample_email: sampleEmail,
      metrics: metrics
    });
  } catch (err) {
    console.error('Error in /api/proof:', err);
    res.status(500).json({
      error: 'Failed to generate proof',
      message: err.message
    });
  }
});

// ============================================
// AUTH ROUTES
// ============================================

app.post('/api/auth/signup', authLimiter, [
  body('email').isEmail().trim().toLowerCase(),
  body('password').isLength({ min: 10 }),
  body('name').optional().isString().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, password, name } = req.body;
    const user = await authService.signup(email, password, name);
    const token = authService.generateToken(user.id);

    // Audit log signup
    auditLogger.logSignup(user.id, email, req);

    // Track signup event
    trackEvent('signup', user.id, { email: user.email }).catch(err =>
      console.error('Signup tracking failed:', err.message)
    );

    // Send welcome email via Postmark (transactional)
    try {
      await emailService.sendTransactionalEmail(
        user.email,
        'Welcome to Koldly! 🚀',
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF6B35;">Welcome to Koldly!</h2>
          <p>Hi${user.name ? ' ' + user.name : ''},</p>
          <p>Thanks for signing up. Koldly helps you find prospects and write personalized outreach with AI.</p>
          <p><strong>Next step:</strong> Complete your onboarding to set up your first campaign.</p>
          <a href="${process.env.APP_URL || 'https://koldly.com'}/onboarding" style="display: inline-block; padding: 12px 24px; background: #FF6B35; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0;">Start Onboarding →</a>
          <p style="color: #666; font-size: 14px;">Need help? Reply to this email or contact <a href="mailto:support@koldly.com" style="color: #FF6B35;">support@koldly.com</a>.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">You're receiving this because you signed up for Koldly.</p>
        </div>`
      );
    } catch (welcomeErr) {
      console.error('Welcome email failed:', welcomeErr.message);
    }

    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Signup error:', err);
    const message = err.message || 'Signup failed';
    res.status(400).json({ error: message });
  }
});

app.post('/api/auth/login', authLimiter, [
  body('email').isEmail().trim().toLowerCase(),
  body('password').exists()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const { email, password } = req.body;
    const user = await authService.login(email, password);
    const token = authService.generateToken(user.id);

    // Audit log successful login
    auditLogger.logLogin(user.id, true, req);

    // Track login event
    trackEvent('login', user.id, { email: user.email }).catch(err =>
      console.error('Login tracking failed:', err.message)
    );

    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

// Token verification endpoint
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await authService.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json({ success: true, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Forgot password - request reset
app.post('/api/auth/forgot-password', passwordResetLimiter, [
  body('email').isEmail().trim().toLowerCase()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Don't reveal validation errors - always show success for security
      return res.json({ success: true, message: 'If an account exists with that email, you will receive a password reset link.' });
    }

    const { email } = req.body;
    const resetData = await authService.generatePasswordResetToken(email);

    // Always return success even if email doesn't exist (security best practice)
    if (!resetData) {
      return res.json({ success: true, message: 'If an account exists with that email, you will receive a password reset link.' });
    }

    // Send reset email via Postmark
    const resetUrl = `${process.env.APP_URL || 'https://koldly.com'}/reset-password?token=${resetData.token}`;

    try {
      await emailService.sendTransactionalEmail(
        resetData.email,
        'Reset Your Koldly Password',
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF6B35;">Reset Your Password</h2>
          <p>You requested a password reset for your Koldly account.</p>
          <p>Click the button below to reset your password:</p>
          <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #FF6B35; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0;">Reset Password</a>
          <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
          <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">If the button doesn't work, copy and paste this link:<br>${resetUrl}</p>
        </div>`
      );
    } catch (emailErr) {
      console.error('Failed to send reset email:', emailErr);
      // Still return success - don't reveal email sending failures
    }

    res.json({ success: true, message: 'If an account exists with that email, you will receive a password reset link.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json({ success: true, message: 'If an account exists with that email, you will receive a password reset link.' });
  }
});

// Verify reset token (for displaying the reset form)
app.get('/api/auth/reset-password/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const tokenData = await authService.verifyPasswordResetToken(token);

    if (!tokenData) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    res.json({ success: true, email: tokenData.email });
  } catch (err) {
    console.error('Token verification error:', err);
    res.status(400).json({ error: 'Invalid or expired reset token' });
  }
});

// Reset password with token
app.post('/api/auth/reset-password', passwordResetLimiter, [
  body('token').notEmpty(),
  body('password').isLength({ min: 10 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const { token, password } = req.body;
    await authService.resetPassword(token, password);

    res.json({ success: true, message: 'Password reset successful. You can now log in with your new password.' });
  } catch (err) {
    console.error('Password reset error:', err);
    res.status(400).json({ error: err.message || 'Failed to reset password' });
  }
});

// ============================================
// OAUTH ROUTES
// ============================================

// Auth config endpoint - tells frontend which auth methods are available
app.get('/api/auth/config', (req, res) => {
  res.json({
    googleOAuth: !!process.env.GOOGLE_OAUTH_CLIENT_ID
  });
});

// Google OAuth - start auth flow
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    const referrer = req.get('Referer') || '';
    const page = referrer.includes('/login') ? '/login' : '/signup';
    return res.redirect(`${page}?error=${encodeURIComponent('Google sign-in is temporarily unavailable. Please use email to sign up.')}`);
  }
  const authUrl = oauthService.getGoogleAuthUrl();
  res.redirect(authUrl);
});

// Google OAuth - callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error('OAuth error:', error, error_description);
      return res.redirect(`/login?error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
      return res.redirect('/login?error=No authorization code');
    }

    // Handle Google OAuth callback
    const user = await oauthService.handleGoogleCallback(code);

    if (!user) {
      return res.redirect('/login?error=Failed to authenticate with Google');
    }

    // Generate token
    const token = authService.generateToken(user.id);

    // Check if email is verified (should be for Google OAuth)
    const isVerified = await oauthService.isEmailVerified(user.id);

    // Check if onboarding is completed
    const onboardingCheck = await pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [user.id]);
    const onboardingDone = onboardingCheck.rows[0]?.onboarding_completed;
    const destination = onboardingDone ? '/dashboard' : '/onboarding';
    res.redirect(`${destination}?token=${token}&email=${encodeURIComponent(user.email)}&verified=${isVerified ? '1' : '0'}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`/login?error=${encodeURIComponent(err.message)}`);
  }
});

// ============================================
// EMAIL VERIFICATION ROUTES
// ============================================

// Send verification email
app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Resend verification email
    const { token: verificationToken, email } = await oauthService.resendVerificationEmail(decoded.userId);

    // Send verification email via Postmark
    const verifyUrl = `${process.env.APP_URL || 'https://koldly.com'}/verify-email?token=${verificationToken}`;

    try {
      await emailService.sendTransactionalEmail(
        email,
        'Verify Your Koldly Email Address',
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF6B35;">Verify Your Email</h2>
          <p>Click the link below to verify your email address:</p>
          <p><a href="${verifyUrl}" style="background: #FF6B35; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Verify Email</a></p>
          <p>Or paste this link: ${verifyUrl}</p>
          <p style="color: #888; font-size: 12px;">This link expires in 24 hours.</p>
        </div>`,
        `Verify your email: ${verifyUrl}`
      );
    } catch (err) {
      console.error('Failed to send verification email:', err);
      // Still return success - email might have sent
    }

    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    console.error('Verification email error:', err);
    res.status(400).json({ error: err.message || 'Failed to send verification email' });
  }
});

// Verify email with token
app.post('/api/auth/verify-email', [
  body('token').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const { token } = req.body;
    const userId = await oauthService.verifyEmailToken(token);

    // Generate new auth token
    const authToken = authService.generateToken(userId);

    res.json({ success: true, token: authToken, message: 'Email verified successfully' });
  } catch (err) {
    console.error('Email verification error:', err);
    res.status(400).json({ error: err.message || 'Invalid or expired token' });
  }
});

// Verify email page
app.get('/verify-email', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Email - Koldly</title>
      <style>
        body {
          font-family: 'DM Sans', sans-serif;
          background: #0A0A0A;
          color: #F5F5F5;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 20px;
        }
        .container {
          max-width: 400px;
          text-align: center;
        }
        h1 { font-size: 24px; margin-bottom: 16px; }
        p { color: #888; margin-bottom: 20px; }
        .spinner {
          border: 3px solid rgba(255,107,53,0.1);
          border-top: 3px solid #FF6B35;
          border-radius: 50%;
          width: 40px;
          height: 40px;
          animation: spin 1s linear infinite;
          margin: 30px auto;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Verifying Your Email</h1>
        <p>Please wait...</p>
        <div class="spinner"></div>
      </div>
      <script>
        const params = new URLSearchParams(window.location.search);
        const token = params.get('token');

        if (!token) {
          document.querySelector('.container').innerHTML = '<h1>Invalid Link</h1><p>The verification link is missing or invalid.</p><p><a href="/dashboard" style="color: #FF6B35;">Go to Dashboard</a></p>';
        } else {
          fetch('/api/auth/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          })
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              localStorage.setItem('auth_token', data.token);
              document.querySelector('.container').innerHTML = '<h1>✓ Email Verified</h1><p>Your email has been verified. Redirecting...</p>';
              setTimeout(() => { window.location.href = '/dashboard'; }, 2000);
            } else {
              throw new Error(data.error);
            }
          })
          .catch(err => {
            document.querySelector('.container').innerHTML = '<h1>Verification Failed</h1><p>' + err.message + '</p><p><a href="/dashboard" style="color: #FF6B35;">Go to Dashboard</a></p>';
          });
        }
      </script>
    </body>
    </html>
  `);
});

// Serve login and signup pages (from cache)
app.get('/login', serveHtml('login.html'));
app.get('/signup', serveHtml('signup.html'));
app.get('/forgot-password', serveHtml('forgot-password.html'));
app.get('/reset-password', serveHtml('reset-password.html'));

// Legal pages
app.get('/terms', serveHtml('terms.html'));
app.get('/privacy', serveHtml('privacy.html'));

// Billing page (protected)
app.get('/billing', requireAuth, serveHtml('billing.html'));

// Protected: Approval Queue (primary screen)
app.get('/queue', requireAuth, serveHtml('queue.html'));

// Protected: Pipeline View
app.get('/pipeline', requireAuth, serveHtml('pipeline.html'));

// ============================================
// BILLING API ROUTES (Protected)
// ============================================

// Get user's current plan
app.get('/api/billing/plan', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const subscription = await stripeService.getSubscription(user.id);
    res.json({ success: true, ...subscription });
  } catch (err) {
    console.error('Plan fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch plan information' });
  }
});

// Create checkout session
app.post('/api/billing/checkout', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { plan } = req.body;
    if (!['starter', 'growth', 'scale'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const session = await stripeService.createCheckoutSession(user.id, plan);

    // Track billing checkout event
    trackEvent('billing_checkout', user.id, { plan }).catch(() => {});

    res.json({ success: true, ...session });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Stripe customer portal URL
app.get('/api/billing/portal', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const session = await stripeService.createPortalSession(user.id);
    res.json({ success: true, portalUrl: session.url });
  } catch (err) {
    console.error('Portal URL error:', err);
    // Fallback for users without Stripe
    res.json({ success: true, portalUrl: '/pricing' });
  }
});

// Get invoices
app.get('/api/billing/invoices', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const invoices = await stripeService.getInvoices(user.id);
    res.json({ success: true, invoices });
  } catch (err) {
    console.error('Invoices fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Get usage metrics for billing page
app.get('/api/billing/usage', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const AIService = require('./lib/ai-service');
    const aiService = new AIService(pool);
    const budget = await aiService.checkBudget(user.id);

    // Get prospect count this month
    const prospectResult = await pool.query(`
      SELECT COUNT(*) as count FROM prospects
      WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)
        AND created_at >= DATE_TRUNC('month', NOW())
    `, [user.id]);

    // Get plan limits
    const planLimits = {
      free:    { prospects: 25,   campaigns: 1  },
      starter: { prospects: 100,  campaigns: 1  },
      growth:  { prospects: 500,  campaigns: 5  },
      scale:   { prospects: 2000, campaigns: -1 }
    };

    const plan = budget.plan || 'free';
    const limits = planLimits[plan] || planLimits.free;

    const campaignResult = await pool.query(
      'SELECT COUNT(*) as count FROM campaigns WHERE user_id = $1 AND (is_archived = false OR is_archived IS NULL)',
      [user.id]
    );

    res.json({
      success: true,
      plan,
      prospects: {
        used: parseInt(prospectResult.rows[0].count),
        limit: limits.prospects
      },
      campaigns: {
        used: parseInt(campaignResult.rows[0].count),
        limit: limits.campaigns
      },
      ai_budget: {
        used_cents: budget.used_cents || 0,
        budget_cents: budget.budget_cents || 500,
        remaining_cents: budget.remaining_cents || 0
      }
    });
  } catch (err) {
    console.error('Billing usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook (raw body required — must be before json middleware)
// Note: This route uses express.raw() for signature verification

// ============================================
// CAMPAIGN SENDING ROUTES (Protected)
// ============================================

// Start campaign
app.post('/api/campaigns/:campaignId/send', [
  param('campaignId').isInt(),
  body('senderEmail').isEmail(),
  body('senderName').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { campaignId } = req.params;
    const { senderEmail, senderName, replyToEmail } = req.body;

    const result = await campaignSendingService.startCampaign(
      campaignId,
      user.id,
      senderEmail,
      senderName,
      replyToEmail
    );

    res.json(result);
  } catch (err) {
    console.error('Campaign start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get campaign status
app.get('/api/campaigns/:campaignId/status', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { campaignId } = req.params;

    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        csc.status,
        csc.prospect_count,
        COALESCE(COUNT(DISTINCT CASE WHEN csq.status = 'sent' THEN csq.id END), 0) as emails_sent,
        COALESCE(COUNT(DISTINCT CASE WHEN csq.status = 'pending' THEN csq.id END), 0) as emails_pending,
        COALESCE(COUNT(DISTINCT CASE WHEN csq.status = 'failed' THEN csq.id END), 0) as emails_failed
      FROM campaigns c
      LEFT JOIN campaign_sending_context csc ON c.id = csc.campaign_id
      LEFT JOIN campaign_sending_queue csq ON c.id = csq.campaign_id
      WHERE c.id = $1 AND c.user_id = $2
      GROUP BY c.id, c.name, csc.status, csc.prospect_count
    `, [campaignId, user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Campaign status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Pause campaign
app.post('/api/campaigns/:campaignId/pause', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { campaignId } = req.params;

    await pool.query(`
      UPDATE campaign_sending_context
      SET status = 'paused', updated_at = NOW()
      WHERE campaign_id = $1
        AND EXISTS (SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2)
    `, [campaignId, user.id]);

    res.json({ success: true, status: 'paused' });
  } catch (err) {
    console.error('Campaign pause error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resume campaign
app.post('/api/campaigns/:campaignId/resume', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { campaignId } = req.params;

    await pool.query(`
      UPDATE campaign_sending_context
      SET status = 'active', updated_at = NOW()
      WHERE campaign_id = $1
        AND EXISTS (SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2)
    `, [campaignId, user.id]);

    res.json({ success: true, status: 'active' });
  } catch (err) {
    console.error('Campaign resume error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CAMPAIGN CRUD ROUTES (Protected)
// ============================================

// Helper: extract user from auth token
async function authenticateRequest(req, authService) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  const decoded = authService.verifyToken(token);
  if (!decoded || !decoded.userId) return null;
  return { id: decoded.userId };
}

// List campaigns with optional status filter
app.get('/api/campaigns', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const status = req.query.status || 'active';

    let whereClause = 'WHERE c.user_id = $1';
    if (status === 'active') {
      whereClause += ' AND (c.is_archived = false OR c.is_archived IS NULL)';
    } else if (status === 'archived') {
      whereClause += ' AND c.is_archived = true';
    }
    // 'all' = no additional filter

    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.description,
        c.icp_description,
        c.status,
        c.is_archived,
        c.created_at,
        c.updated_at,
        COALESCE(
          json_build_object(
            'total_prospects', COALESCE(csc.prospect_count, 0),
            'total_emails', COALESCE(eq.total_emails, 0),
            'emails_sent', COALESCE(eq.emails_sent, 0)
          ), '{}'::json
        ) as stats
      FROM campaigns c
      LEFT JOIN campaign_sending_context csc ON c.id = csc.campaign_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) as total_emails,
          COUNT(CASE WHEN status = 'sent' THEN 1 END) as emails_sent
        FROM campaign_sending_queue
        WHERE campaign_id = c.id
      ) eq ON true
      ${whereClause}
      ORDER BY c.created_at DESC
    `, [user.id]);

    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error('List campaigns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create campaign
app.post('/api/campaigns', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { name, description, icp_description, icp_template_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Campaign name is required' });

    // Enforce plan limits
    const planLimits = { free: 1, starter: 1, growth: 5, scale: -1 };
    const userPlan = await pool.query('SELECT subscription_plan FROM users WHERE id = $1', [user.id]);
    const plan = userPlan.rows[0]?.subscription_plan || 'free';
    const maxCampaigns = planLimits[plan] ?? 1;

    if (maxCampaigns !== -1) {
      const campaignCount = await pool.query(
        'SELECT COUNT(*) as count FROM campaigns WHERE user_id = $1 AND (is_archived = false OR is_archived IS NULL)',
        [user.id]
      );
      if (parseInt(campaignCount.rows[0].count) >= maxCampaigns) {
        // Track plan limit hit
        trackEvent('plan_limit_hit', user.id, {
          limit_type: 'campaigns',
          current_plan: plan,
          limit: maxCampaigns
        }).catch(() => {});
        return res.status(403).json({
          error: `Campaign limit reached (${maxCampaigns} on ${plan} plan). Upgrade to create more campaigns.`,
          upgrade_required: true,
          current_plan: plan
        });
      }
    }

    let icpDesc = icp_description || null;

    // If using template, fetch ICP description from template
    if (icp_template_id) {
      const tpl = await pool.query(
        'SELECT icp_description FROM icp_templates WHERE id = $1 AND user_id = $2',
        [icp_template_id, user.id]
      );
      if (tpl.rows.length > 0) {
        icpDesc = tpl.rows[0].icp_description;
        // Increment template usage count
        await pool.query(
          'UPDATE icp_templates SET usage_count = COALESCE(usage_count, 0) + 1 WHERE id = $1',
          [icp_template_id]
        );
      }
    }

    const result = await pool.query(`
      INSERT INTO campaigns (user_id, name, description, icp_description, icp_template_id, status, is_archived)
      VALUES ($1, $2, $3, $4, $5, 'active', false)
      RETURNING *
    `, [user.id, name, description || null, icpDesc, icp_template_id || null]);

    // Track campaign creation event
    trackEvent('campaign_created', user.id, {
      campaign_id: result.rows[0].id,
      campaign_name: name
    }).catch(err => console.error('Campaign creation tracking failed:', err.message));

    res.json({ success: true, campaign: result.rows[0] });
  } catch (err) {
    console.error('Create campaign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Duplicate campaign
app.post('/api/campaigns/:id/duplicate', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const { new_name } = req.body;

    const original = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [id, user.id]
    );
    if (original.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });

    const src = original.rows[0];
    const result = await pool.query(`
      INSERT INTO campaigns (user_id, name, description, icp_description, icp_template_id, status, is_archived)
      VALUES ($1, $2, $3, $4, $5, 'active', false)
      RETURNING *
    `, [user.id, new_name || `${src.name} (Copy)`, src.description, src.icp_description, src.icp_template_id]);

    res.json({ success: true, campaign: result.rows[0] });
  } catch (err) {
    console.error('Duplicate campaign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Archive campaign
app.put('/api/campaigns/:id/archive', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const result = await pool.query(`
      UPDATE campaigns SET is_archived = true, archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `, [id, user.id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Archive campaign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Unarchive campaign
app.put('/api/campaigns/:id/unarchive', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const result = await pool.query(`
      UPDATE campaigns SET is_archived = false, archived_at = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `, [id, user.id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Unarchive campaign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete campaign
app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;

    // Delete related records first
    await pool.query('DELETE FROM campaign_sending_queue WHERE campaign_id = $1', [id]);
    await pool.query('DELETE FROM campaign_sending_context WHERE campaign_id = $1', [id]);

    const result = await pool.query(
      'DELETE FROM campaigns WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, user.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete campaign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ICP TEMPLATE ROUTES (Protected)
// ============================================

// List ICP templates
app.get('/api/icp-templates', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await pool.query(
      'SELECT * FROM icp_templates WHERE user_id = $1 ORDER BY is_favorite DESC, created_at DESC',
      [user.id]
    );

    res.json({ templates: result.rows });
  } catch (err) {
    console.error('List templates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create ICP template
app.post('/api/icp-templates', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { name, icp_description } = req.body;
    if (!name || !icp_description) {
      return res.status(400).json({ error: 'Name and ICP description are required' });
    }

    const result = await pool.query(`
      INSERT INTO icp_templates (user_id, name, icp_description)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [user.id, name, icp_description]);

    res.json({ success: true, template: result.rows[0] });
  } catch (err) {
    console.error('Create template error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DASHBOARD API ROUTES (Protected)
// ============================================

// Get dashboard KPI stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get key metrics from pipeline tables (prospects, generated_emails) + sending queue
    const userId = user.userId || user.id;
    const statsResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM campaigns WHERE user_id = $1 AND (is_archived = false OR is_archived IS NULL)) as total_campaigns,
        (SELECT COUNT(*) FROM campaigns WHERE user_id = $1 AND status = 'active' AND (is_archived = false OR is_archived IS NULL)) as active_campaigns,
        (SELECT COUNT(*) FROM prospects WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)) as total_prospects,
        (SELECT COUNT(*) FROM generated_emails WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1) AND status = 'pending_approval') as emails_pending,
        (SELECT COUNT(*) FROM generated_emails WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1) AND status = 'approved') as emails_approved,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1) AND status = 'sent') as emails_sent,
        (SELECT COUNT(*) FROM prospect_reply_inbox WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)) as replies_received
    `, [userId]);

    const stats = statsResult.rows[0] || {};

    const emailsSent = parseInt(stats.emails_sent) || 0;
    const repliesReceived = parseInt(stats.replies_received) || 0;
    const replyRate = emailsSent > 0 ? Math.round((repliesReceived / emailsSent) * 100) : 0;

    res.json({
      total_campaigns: parseInt(stats.total_campaigns) || 0,
      active_campaigns: parseInt(stats.active_campaigns) || 0,
      total_prospects: parseInt(stats.total_prospects) || 0,
      emails_pending: parseInt(stats.emails_pending) || 0,
      emails_approved: parseInt(stats.emails_approved) || 0,
      emails_sent: emailsSent,
      reply_rate: replyRate,
      replies_received: repliesReceived
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get email activity data for charts
app.get('/api/dashboard/email-activity', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const days = req.query.days || 7;

    // Get daily email activity
    const activityResult = await pool.query(`
      SELECT
        DATE(created_at)::text as date,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status IN ('pending', 'queued') THEN 1 ELSE 0 END) as pending,
        COUNT(*) as total
      FROM campaign_sending_queue
      WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)
        AND created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
    `, [user.id, parseInt(days)]);

    res.json(activityResult.rows);
  } catch (err) {
    console.error('Email activity error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get active campaigns for dashboard
app.get('/api/dashboard/campaigns', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get top 3 campaigns
    const campaignsResult = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.description,
        COALESCE(csc.status, 'draft') as status,
        COALESCE(csc.prospect_count, 0) as prospect_count,
        COALESCE(COUNT(DISTINCT CASE WHEN csq.status = 'sent' THEN csq.id END), 0) as emails_sent,
        COALESCE(COUNT(DISTINCT CASE WHEN pr.id IS NOT NULL THEN pr.id END), 0) as replies,
        CASE
          WHEN COUNT(DISTINCT CASE WHEN csq.status = 'sent' THEN csq.id END) > 0
          THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN pr.id IS NOT NULL THEN pr.id END) / COUNT(DISTINCT CASE WHEN csq.status = 'sent' THEN csq.id END))
          ELSE 0
        END as reply_rate
      FROM campaigns c
      LEFT JOIN campaign_sending_context csc ON c.id = csc.campaign_id
      LEFT JOIN campaign_sending_queue csq ON c.id = csq.campaign_id
      LEFT JOIN prospect_replies pr ON c.id = pr.campaign_id
      WHERE c.user_id = $1
      GROUP BY c.id, c.name, c.description, csc.status, csc.prospect_count
      ORDER BY c.created_at DESC
      LIMIT 3
    `, [user.id]);

    res.json(campaignsResult.rows);
  } catch (err) {
    console.error('Dashboard campaigns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get recent activity feed
app.get('/api/dashboard/activity', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get recent activities from multiple sources
    const activityResult = await pool.query(`
      SELECT * FROM (
        -- Campaign launches
        SELECT
          csc.created_at as timestamp,
          'campaign_launch' as type,
          c.name as subject,
          csc.prospect_count as count,
          c.id as entity_id
        FROM campaign_sending_context csc
        JOIN campaigns c ON c.id = csc.campaign_id
        WHERE c.user_id = $1

        UNION ALL

        -- Email sends (daily aggregate)
        SELECT
          DATE_TRUNC('hour', csq.created_at) as timestamp,
          'emails_sent' as type,
          c.name as subject,
          COUNT(*) as count,
          c.id as entity_id
        FROM campaign_sending_queue csq
        JOIN campaigns c ON c.id = csq.campaign_id
        WHERE c.user_id = $1 AND csq.status = 'sent'
        GROUP BY DATE_TRUNC('hour', csq.created_at), c.name, c.id

        UNION ALL

        -- Replies received
        SELECT
          pr.created_at as timestamp,
          'reply_received' as type,
          c.name as subject,
          1 as count,
          pr.campaign_id as entity_id
        FROM prospect_replies pr
        JOIN campaigns c ON c.id = pr.campaign_id
        WHERE c.user_id = $1
      ) activities
      ORDER BY timestamp DESC
      LIMIT 10
    `, [user.id]);

    res.json(activityResult.rows);
  } catch (err) {
    console.error('Activity feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AUTONOMOUS PIPELINE ROUTES (Protected)
// ============================================

// --- Discovery ---
app.post('/api/campaigns/:id/discover', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { batchSize } = req.body;
    const result = await discoveryService.discoverProspects(
      parseInt(req.params.id), user.id, batchSize || 25
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Discovery error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/research', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { prospect_ids, batchSize } = req.body;
    const result = await discoveryService.researchProspects(
      parseInt(req.params.id), user.id, prospect_ids, batchSize || 5
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Research error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/prospects', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await pool.query(`
      SELECT p.*, ge.status as email_status, ge.subject_line
      FROM prospects p
      LEFT JOIN LATERAL (
        SELECT status, subject_line FROM generated_emails
        WHERE prospect_id = p.id ORDER BY created_at DESC LIMIT 1
      ) ge ON true
      WHERE p.campaign_id = $1
        AND EXISTS (SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2)
      ORDER BY p.fit_score DESC, p.created_at DESC
    `, [req.params.id, user.id]);

    res.json({ prospects: result.rows });
  } catch (err) {
    console.error('Prospects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- CSV Import ---
app.post('/api/campaigns/:id/import-prospects', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const campaignId = parseInt(req.params.id);

    // Verify ownership
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, user.id]
    );
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });

    const { prospects } = req.body;
    if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ error: 'prospects array is required' });
    }

    if (prospects.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 prospects per import' });
    }

    let imported = 0;
    let skipped = 0;

    for (const p of prospects) {
      if (!p.email) { skipped++; continue; }

      try {
        await pool.query(`
          INSERT INTO prospects (campaign_id, email, first_name, last_name, company_name, title, source, status, fit_score)
          VALUES ($1, $2, $3, $4, $5, $6, 'csv_import', 'discovered', 50)
          ON CONFLICT (campaign_id, email) DO NOTHING
        `, [
          campaignId,
          p.email.trim().toLowerCase(),
          p.first_name || p.name?.split(' ')[0] || null,
          p.last_name || p.name?.split(' ').slice(1).join(' ') || null,
          p.company || p.company_name || null,
          p.title || p.role || null
        ]);
        imported++;
      } catch (insertErr) {
        skipped++;
      }
    }

    // Track CSV import event (H1 hypothesis - activation funnel)
    trackEvent('csv_import', user.id, {
      campaign_id: campaignId,
      prospect_count: imported,
      skipped: skipped
    }).catch(() => {});

    res.json({ success: true, imported, skipped, total: prospects.length });
  } catch (err) {
    console.error('CSV import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Email Generation ---
app.post('/api/campaigns/:id/generate-emails', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { batchSize } = req.body;
    const result = await emailGenService.generateForCampaign(
      parseInt(req.params.id), user.id, batchSize || 5
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Email generation error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/emails/:id/regenerate', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { feedback } = req.body;
    const result = await emailGenService.regenerateEmail(
      parseInt(req.params.id), user.id, feedback
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Email regeneration error:', err);
    res.status(400).json({ error: err.message });
  }
});

// --- Approval Queue ---
app.get('/api/queue', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { type, campaign_id, page, limit } = req.query;
    const result = await approvalService.getQueue(user.id, {
      type, campaign_id: campaign_id ? parseInt(campaign_id) : null,
      page: parseInt(page) || 1, limit: parseInt(limit) || 50
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/queue/counts', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const counts = await approvalService.getQueueCounts(user.id);
    res.json({ success: true, ...counts });
  } catch (err) {
    console.error('Queue counts error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/emails/:id/approve', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await approvalService.approveEmail(parseInt(req.params.id), user.id);

    // Track email approval event
    trackEvent('email_approved', user.id, {
      email_id: parseInt(req.params.id)
    }).catch(() => {});

    // Beta: Check if this is the user's FIRST EVER email approval (activation milestone)
    try {
      const priorApprovals = await pool.query(
        "SELECT COUNT(*) as count FROM analytics_events WHERE user_id = $1 AND event_type = 'first_email_approved'",
        [user.id]
      );
      if (parseInt(priorApprovals.rows[0].count) === 0) {
        trackEvent('first_email_approved', user.id, {
          email_id: parseInt(req.params.id)
        }).catch(() => {});
        // Set activated_at timestamp
        pool.query('UPDATE users SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL', [user.id]).catch(() => {});
      }
    } catch (activationErr) {
      console.error('Activation check error:', activationErr.message);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Email approve error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/queue/emails/:id/edit-approve', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await approvalService.editAndApproveEmail(
      parseInt(req.params.id), user.id, req.body
    );

    // Track edit-before-approve event (H2 hypothesis)
    trackEvent('email_edited_approved', user.id, {
      email_id: parseInt(req.params.id)
    }).catch(() => {});

    // Beta: Also check for first-ever activation
    try {
      const priorApprovals = await pool.query(
        "SELECT COUNT(*) as count FROM analytics_events WHERE user_id = $1 AND event_type = 'first_email_approved'",
        [user.id]
      );
      if (parseInt(priorApprovals.rows[0].count) === 0) {
        trackEvent('first_email_approved', user.id, {
          email_id: parseInt(req.params.id),
          was_edited: true
        }).catch(() => {});
        pool.query('UPDATE users SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL', [user.id]).catch(() => {});
      }
    } catch (activationErr) {
      console.error('Activation check error:', activationErr.message);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Email edit-approve error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/queue/emails/:id/reject', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { reason } = req.body;
    const result = await approvalService.rejectEmail(parseInt(req.params.id), user.id, reason);

    // Track email rejection event (H2 hypothesis)
    trackEvent('email_rejected', user.id, {
      email_id: parseInt(req.params.id),
      reason: reason || null
    }).catch(() => {});

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Email reject error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/queue/emails/bulk-approve', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { email_ids } = req.body;
    if (!email_ids || !Array.isArray(email_ids)) {
      return res.status(400).json({ error: 'email_ids array required' });
    }
    const result = await approvalService.bulkApproveEmails(email_ids, user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Bulk approve error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/queue/replies/:id/approve', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await approvalService.approveReplyDraft(parseInt(req.params.id), user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Reply approve error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/queue/replies/:id/edit-approve', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await approvalService.editAndApproveReplyDraft(
      parseInt(req.params.id), user.id, req.body
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Reply edit-approve error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/queue/replies/:id/reject', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { reason } = req.body;
    const result = await approvalService.rejectReplyDraft(parseInt(req.params.id), user.id, reason);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Reply reject error:', err);
    res.status(400).json({ error: err.message });
  }
});

// --- Reply Processing ---
app.post('/api/replies/:id/categorize', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await replyResponseService.categorizeReply(parseInt(req.params.id), user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Categorize error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/replies/:id/draft-response', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await replyResponseService.draftResponse(parseInt(req.params.id), user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Draft response error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/replies/process-new', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await replyResponseService.processNewReplies(user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Process replies error:', err);
    res.status(400).json({ error: err.message });
  }
});

// --- Pipeline Status (lightweight polling endpoint) ---
app.get('/api/campaigns/:id/pipeline-status', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const campaignId = parseInt(req.params.id);

    const result = await pool.query(`
      SELECT
        c.name,
        c.discovery_status,
        COALESCE(csc.status, 'draft') as sending_status,
        (SELECT COUNT(*) FROM prospects WHERE campaign_id = $1) as total_prospects,
        (SELECT COUNT(*) FROM generated_emails WHERE campaign_id = $1 AND status = 'pending_approval') as pending_approval,
        (SELECT COUNT(*) FROM generated_emails WHERE campaign_id = $1 AND status = 'approved') as approved,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id = $1 AND status = 'sent') as sent,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id = $1 AND status = 'pending') as queued,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id = $1 AND status = 'failed') as failed
      FROM campaigns c
      LEFT JOIN campaign_sending_context csc ON c.id = csc.campaign_id
      WHERE c.id = $1 AND c.user_id = $2
    `, [campaignId, user.id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('Pipeline status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- CSV Export ---
app.get('/api/campaigns/:id/export-csv', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const campaignId = parseInt(req.params.id);
    const type = req.query.type || 'prospects';

    // Verify ownership
    const campaign = await pool.query(
      'SELECT id, name FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, user.id]
    );
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });

    const campaignName = campaign.rows[0].name.replace(/[^a-zA-Z0-9]/g, '_');

    if (type === 'prospects') {
      const result = await pool.query(`
        SELECT
          p.email, p.first_name, p.last_name, p.company_name, p.title,
          p.status, p.fit_score, p.source, p.created_at
        FROM prospects p
        WHERE p.campaign_id = $1
        ORDER BY p.created_at DESC
      `, [campaignId]);

      const header = 'email,first_name,last_name,company_name,title,status,fit_score,source,created_at';
      const rows = result.rows.map(r =>
        [r.email, r.first_name, r.last_name, r.company_name, r.title, r.status, r.fit_score, r.source, r.created_at]
          .map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(',')
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${campaignName}_prospects.csv"`);
      res.send(header + '\n' + rows.join('\n'));
    } else if (type === 'emails') {
      const result = await pool.query(`
        SELECT
          ge.subject_line, ge.email_body, ge.status, ge.personalization_notes,
          p.email as prospect_email, p.company_name, p.first_name, p.last_name,
          ge.created_at
        FROM generated_emails ge
        JOIN prospects p ON ge.prospect_id = p.id
        WHERE ge.campaign_id = $1
        ORDER BY ge.created_at DESC
      `, [campaignId]);

      const header = 'prospect_email,company_name,first_name,last_name,subject_line,status,personalization_notes,created_at';
      const rows = result.rows.map(r =>
        [r.prospect_email, r.company_name, r.first_name, r.last_name, r.subject_line, r.status, r.personalization_notes, r.created_at]
          .map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(',')
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${campaignName}_emails.csv"`);
      res.send(header + '\n' + rows.join('\n'));
    } else {
      res.status(400).json({ error: 'Invalid type. Use "prospects" or "emails".' });
    }
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Pipeline View ---
app.get('/api/campaigns/:id/pipeline', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const campaignId = parseInt(req.params.id);

    // Verify ownership
    const campaign = await pool.query(
      'SELECT id, name, description, discovery_status FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, user.id]
    );
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });

    // Get stage counts
    const stages = await pool.query(`
      SELECT
        p.status,
        COUNT(*) as count,
        AVG(p.fit_score)::int as avg_fit_score
      FROM prospects p
      WHERE p.campaign_id = $1
      GROUP BY p.status
      ORDER BY
        CASE p.status
          WHEN 'discovered' THEN 1
          WHEN 'researched' THEN 2
          WHEN 'email_drafted' THEN 3
          WHEN 'approved' THEN 4
          WHEN 'sent' THEN 5
          WHEN 'replied' THEN 6
          WHEN 'meeting_booked' THEN 7
        END
    `, [campaignId]);

    // Email stats
    const emailStats = await pool.query(`
      SELECT
        ge.status,
        COUNT(*) as count
      FROM generated_emails ge
      WHERE ge.campaign_id = $1
      GROUP BY ge.status
    `, [campaignId]);

    res.json({
      success: true,
      campaign: campaign.rows[0],
      stages: stages.rows,
      email_stats: emailStats.rows
    });
  } catch (err) {
    console.error('Pipeline error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Onboarding ---
app.post('/api/onboarding/complete', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { product_description, icp_description, sender_name, sender_email, campaign_name } = req.body;

    if (!product_description || !icp_description) {
      return res.status(400).json({ error: 'Product description and ICP are required' });
    }

    // Update user profile
    await pool.query(`
      UPDATE users SET
        product_description = $1,
        sender_name = $2,
        sender_email = $3,
        onboarding_completed = true
      WHERE id = $4
    `, [product_description, sender_name || null, sender_email || null, user.id]);

    // Create first campaign
    const campaignResult = await pool.query(`
      INSERT INTO campaigns (user_id, name, description, icp_description, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING *
    `, [user.id, campaign_name || 'My First Campaign', product_description, icp_description]);

    const campaign = campaignResult.rows[0];

    // Start discovery in background
    discoveryService.discoverProspects(campaign.id, user.id, 25).catch(err => {
      console.error('[Onboarding] Background discovery failed:', err.message);
    });

    trackEvent('onboarding_completed', user.id, {
      campaign_id: campaign.id
    }).catch(() => {});

    res.json({
      success: true,
      campaign,
      message: 'Onboarding complete! Discovering prospects...'
    });
  } catch (err) {
    console.error('Onboarding error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/onboarding/status', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const result = await pool.query(
      'SELECT onboarding_completed, product_description, sender_name, sender_email FROM users WHERE id = $1',
      [user.id]
    );

    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ANALYTICS & METRICS (Admin-only)
// ============================================

app.get('/api/metrics', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Admin check — use is_admin column
    const adminCheck = await pool.query('SELECT is_admin FROM users WHERE id = $1', [user.id]);
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Forbidden - Admin access only' });
    }

    const { period = '7d' } = req.query;

    // Calculate time ranges
    const now = new Date();
    const periods = {
      '24h': new Date(now.getTime() - 24 * 60 * 60 * 1000),
      '7d': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      '30d': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    };

    // Get total users
    const totalUsersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(totalUsersResult.rows[0].count);

    // Get new signups by period
    const signups24h = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['signup', periods['24h']]
    );
    const signups7d = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['signup', periods['7d']]
    );
    const signups30d = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['signup', periods['30d']]
    );

    // Get active users (logged in within 7 days)
    const activeUsers = await pool.query(
      'SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['login', periods['7d']]
    );

    // Get total campaigns created
    const totalCampaignsResult = await pool.query('SELECT COUNT(*) as count FROM campaigns');
    const totalCampaigns = parseInt(totalCampaignsResult.rows[0].count);

    // Get campaigns created by period
    const campaignsCreated = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['campaign_created', periods[period]]
    );

    // Get total emails sent (from campaign_sending_queue)
    const totalEmailsResult = await pool.query(
      "SELECT COUNT(*) as count FROM campaign_sending_queue WHERE status = 'sent'"
    );
    const totalEmails = parseInt(totalEmailsResult.rows[0].count);

    // Get page views by period
    const pageViews24h = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['page_view', periods['24h']]
    );
    const pageViews7d = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['page_view', periods['7d']]
    );
    const pageViews30d = await pool.query(
      'SELECT COUNT(*) as count FROM analytics_events WHERE event_type = $1 AND created_at > $2',
      ['page_view', periods['30d']]
    );

    // Get page view breakdown by path
    const pageViewsByPath = await pool.query(`
      SELECT
        metadata->>'path' as path,
        COUNT(*) as views
      FROM analytics_events
      WHERE event_type = 'page_view' AND created_at > $1
      GROUP BY metadata->>'path'
      ORDER BY views DESC
      LIMIT 10
    `, [periods[period]]);

    // Revenue — real MRR from Stripe service
    let revenue = { mrr: 0, breakdown: {} };
    try {
      revenue = await stripeService.calculateMRR();
    } catch (mrrErr) {
      console.error('[Metrics] MRR calculation failed:', mrrErr.message);
    }

    res.json({
      period,
      users: {
        total: totalUsers,
        signups: {
          '24h': parseInt(signups24h.rows[0].count),
          '7d': parseInt(signups7d.rows[0].count),
          '30d': parseInt(signups30d.rows[0].count)
        },
        active_7d: parseInt(activeUsers.rows[0].count)
      },
      campaigns: {
        total: totalCampaigns,
        created_in_period: parseInt(campaignsCreated.rows[0].count)
      },
      emails: {
        total_sent: totalEmails
      },
      page_views: {
        '24h': parseInt(pageViews24h.rows[0].count),
        '7d': parseInt(pageViews7d.rows[0].count),
        '30d': parseInt(pageViews30d.rows[0].count),
        by_path: pageViewsByPath.rows
      },
      revenue
    });
  } catch (err) {
    console.error('Metrics error:', err);
    res.status(500).json({ error: 'Failed to fetch metrics', message: err.message });
  }
});

// ============================================
// BETA API ROUTES
// ============================================

// Submit beta feedback
app.post('/api/beta/feedback', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { rating, what_worked, what_frustrated, would_recommend, pricing_feedback, missing_features } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating (1-5) is required' });
    }

    await pool.query(`
      INSERT INTO beta_feedback (user_id, rating, what_worked, what_frustrated, would_recommend, pricing_feedback, missing_features)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [user.id, rating, what_worked || null, what_frustrated || null, would_recommend ?? null, pricing_feedback || null, missing_features || null]);

    trackEvent('beta_feedback_submitted', user.id, { rating, would_recommend }).catch(() => {});

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    console.error('Beta feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Beta metrics dashboard (admin only)
app.get('/api/beta/metrics', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const adminCheck = await pool.query('SELECT is_admin FROM users WHERE id = $1', [user.id]);
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access only' });
    }

    // --- H1: Activation Funnel ---
    const signups = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE event_type = 'signup'"
    );
    const onboarded = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE event_type = 'onboarding_completed'"
    );
    const csvImported = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE event_type = 'csv_import'"
    );
    const activated = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE event_type = 'first_email_approved'"
    );
    // Median time to activation
    const activationTimes = await pool.query(`
      SELECT
        ae_signup.user_id,
        EXTRACT(EPOCH FROM (ae_activated.created_at - ae_signup.created_at)) / 60 as minutes_to_activation
      FROM analytics_events ae_signup
      JOIN analytics_events ae_activated ON ae_signup.user_id = ae_activated.user_id
      WHERE ae_signup.event_type = 'signup'
        AND ae_activated.event_type = 'first_email_approved'
      ORDER BY minutes_to_activation
    `);
    const activationTimesArr = activationTimes.rows.map(r => parseFloat(r.minutes_to_activation));
    const medianActivationMin = activationTimesArr.length > 0
      ? activationTimesArr[Math.floor(activationTimesArr.length / 2)]
      : null;

    // --- H2: Email Quality ---
    const approvals = await pool.query(
      "SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'email_approved'"
    );
    const editApprovals = await pool.query(
      "SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'email_edited_approved'"
    );
    const rejections = await pool.query(
      "SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'email_rejected'"
    );
    const totalReviewed = parseInt(approvals.rows[0].count) + parseInt(editApprovals.rows[0].count) + parseInt(rejections.rows[0].count);
    const approvalRate = totalReviewed > 0 ? (parseInt(approvals.rows[0].count) / totalReviewed * 100).toFixed(1) : null;
    const editRate = totalReviewed > 0 ? (parseInt(editApprovals.rows[0].count) / totalReviewed * 100).toFixed(1) : null;

    // --- H3: Reply Rate ---
    const emailsSentToReal = await pool.query(`
      SELECT COUNT(*) as count FROM campaign_sending_queue csq
      JOIN prospects p ON csq.prospect_id = p.id
      WHERE csq.status = 'sent' AND p.source = 'csv_import'
    `);
    const repliesFromReal = await pool.query(`
      SELECT COUNT(*) as count FROM prospect_reply_inbox pri
      JOIN prospects p ON pri.prospect_id = p.id
      WHERE p.source = 'csv_import'
    `);
    const sentCount = parseInt(emailsSentToReal.rows[0].count);
    const replyCount = parseInt(repliesFromReal.rows[0].count);
    const replyRate = sentCount > 0 ? (replyCount / sentCount * 100).toFixed(1) : null;

    // --- H4: D7 Retention ---
    const retentionData = await pool.query(`
      SELECT
        ae_act.user_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM analytics_events ae_login
          WHERE ae_login.user_id = ae_act.user_id
            AND ae_login.event_type = 'login'
            AND ae_login.created_at > ae_act.created_at
            AND ae_login.created_at <= ae_act.created_at + INTERVAL '7 days'
        ) THEN true ELSE false END as returned
      FROM analytics_events ae_act
      WHERE ae_act.event_type = 'first_email_approved'
        AND ae_act.created_at <= NOW() - INTERVAL '7 days'
    `);
    const eligibleForRetention = retentionData.rows.length;
    const returnedCount = retentionData.rows.filter(r => r.returned).length;
    const d7RetentionRate = eligibleForRetention > 0 ? (returnedCount / eligibleForRetention * 100).toFixed(1) : null;

    // --- H5: Willingness to Pay ---
    const checkouts = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE event_type = 'billing_checkout'"
    );

    // --- Beta Feedback Summary ---
    const feedbackSummary = await pool.query(`
      SELECT
        COUNT(*) as total_responses,
        AVG(rating)::numeric(3,1) as avg_rating,
        COUNT(CASE WHEN would_recommend = true THEN 1 END) as would_recommend_count
      FROM beta_feedback
    `);

    res.json({
      success: true,
      hypotheses: {
        h1_activation: {
          funnel: {
            signups: parseInt(signups.rows[0].count),
            onboarded: parseInt(onboarded.rows[0].count),
            csv_imported: parseInt(csvImported.rows[0].count),
            activated: parseInt(activated.rows[0].count)
          },
          activation_rate: parseInt(signups.rows[0].count) > 0
            ? (parseInt(activated.rows[0].count) / parseInt(signups.rows[0].count) * 100).toFixed(1) + '%'
            : 'N/A',
          median_time_to_activation_min: medianActivationMin ? medianActivationMin.toFixed(1) : 'N/A',
          pass_threshold: '≥70%',
          status: parseInt(signups.rows[0].count) >= 15
            ? (parseInt(activated.rows[0].count) / parseInt(signups.rows[0].count) >= 0.7 ? 'CONFIRMED' : 'REFUTED')
            : 'INSUFFICIENT_DATA'
        },
        h2_email_quality: {
          approved: parseInt(approvals.rows[0].count),
          edited: parseInt(editApprovals.rows[0].count),
          rejected: parseInt(rejections.rows[0].count),
          total_reviewed: totalReviewed,
          approval_rate: approvalRate ? approvalRate + '%' : 'N/A',
          edit_rate: editRate ? editRate + '%' : 'N/A',
          pass_threshold: '≥60% approval, <25% edits',
          status: totalReviewed >= 200
            ? (parseFloat(approvalRate) >= 60 && parseFloat(editRate) < 25 ? 'CONFIRMED' : 'REFUTED')
            : 'INSUFFICIENT_DATA'
        },
        h3_reply_rate: {
          emails_sent_to_real: sentCount,
          replies_from_real: replyCount,
          reply_rate: replyRate ? replyRate + '%' : 'N/A',
          pass_threshold: '≥3%',
          status: sentCount >= 500
            ? (parseFloat(replyRate) >= 3 ? 'CONFIRMED' : 'REFUTED')
            : 'INSUFFICIENT_DATA'
        },
        h4_retention: {
          eligible_users: eligibleForRetention,
          returned_d7: returnedCount,
          d7_retention_rate: d7RetentionRate ? d7RetentionRate + '%' : 'N/A',
          pass_threshold: '≥50%',
          status: eligibleForRetention >= 12
            ? (parseFloat(d7RetentionRate) >= 50 ? 'CONFIRMED' : 'REFUTED')
            : 'INSUFFICIENT_DATA'
        },
        h5_willingness_to_pay: {
          checkouts: parseInt(checkouts.rows[0].count),
          activated_users: parseInt(activated.rows[0].count),
          conversion_rate: parseInt(activated.rows[0].count) > 0
            ? (parseInt(checkouts.rows[0].count) / parseInt(activated.rows[0].count) * 100).toFixed(1) + '%'
            : 'N/A',
          pass_threshold: '≥40% (checkout + stated intent)',
          status: 'REQUIRES_INTERVIEW_DATA'
        }
      },
      feedback: {
        total_responses: parseInt(feedbackSummary.rows[0].total_responses),
        avg_rating: feedbackSummary.rows[0].avg_rating,
        would_recommend_count: parseInt(feedbackSummary.rows[0].would_recommend_count)
      }
    });
  } catch (err) {
    console.error('Beta metrics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// OPERATOR API ROUTES (Admin-only)
// ============================================

// Admin middleware helper
async function requireAdmin(req, res) {
  const user = await authenticateRequest(req, authService);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const check = await pool.query('SELECT is_admin FROM users WHERE id = $1', [user.id]);
  if (!check.rows[0]?.is_admin) { res.status(403).json({ error: 'Admin access only' }); return null; }
  return user;
}

// Decision queue
app.get('/api/operator/decisions', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { category, urgency, gate, limit, offset } = req.query;
    const result = await decisionQueueService.getPending({
      category, urgency, safetyGate: gate ? parseInt(gate) : undefined,
      limit: parseInt(limit) || 50, offset: parseInt(offset) || 0
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operator/decisions/:id/resolve', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { status, outcome } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected' });
    }
    const result = await decisionQueueService.resolve(parseInt(req.params.id), status, outcome, 'admin');
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/operator/decisions/counts', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const counts = await decisionQueueService.getCounts();
    res.json(counts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Operator digest
app.get('/api/operator/digest', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { period = 'weekly' } = req.query;
    const digest = await decisionQueueService.getDigest(period);
    res.json(digest);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A/B experiments
app.get('/api/operator/experiments', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { status } = req.query;
    const experiments = await productIntelService.listExperiments(status || null);
    res.json({ experiments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operator/experiments', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { name, target, variants, description, sample_size } = req.body;
    if (!name || !target || !variants) return res.status(400).json({ error: 'name, target, and variants required' });
    const experiment = await productIntelService.createExperiment(name, target, variants, description, sample_size);
    res.json(experiment);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/operator/experiments/:id/start', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const result = await productIntelService.startExperiment(parseInt(req.params.id));
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/operator/experiments/:id/results', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const results = await productIntelService.evaluateExperiment(parseInt(req.params.id));
    res.json(results);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/operator/experiments/:id/conclude', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { winner } = req.body;
    const result = await productIntelService.concludeExperiment(parseInt(req.params.id), winner);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Product signals
app.get('/api/operator/signals', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { type, status, limit } = req.query;
    const signals = await productIntelService.getSignals({ signalType: type, status, limit: parseInt(limit) || 50 });
    res.json({ signals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operator/signals', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { signal_type, source, content } = req.body;
    if (!signal_type || !content) return res.status(400).json({ error: 'signal_type and content required' });
    const signal = await productIntelService.ingestSignal(signal_type, source || 'admin', content);
    res.json(signal);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Support tickets (admin view)
app.get('/api/operator/tickets', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { status, priority, limit, offset } = req.query;
    const tickets = await supportService.getTickets({
      status, priority, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0
    });
    res.json({ tickets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operator/tickets/:id/resolve', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const { resolution } = req.body;
    if (!resolution) return res.status(400).json({ error: 'resolution is required' });
    const ticket = await supportService.resolveTicket(parseInt(req.params.id), resolution);
    res.json(ticket);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Engagement / retention data
app.get('/api/operator/engagement', async (req, res) => {
  try {
    const user = await requireAdmin(req, res); if (!user) return;
    const scores = await pool.query(`
      SELECT es.user_id, es.score, es.churn_risk, es.components, es.last_calculated_at,
             u.email, u.name, u.subscription_plan
      FROM engagement_scores es
      JOIN users u ON es.user_id = u.id
      ORDER BY es.score ASC
      LIMIT 100
    `);
    res.json({ users: scores.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Testimonial submission (user-facing)
app.post('/api/operator/testimonial', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { content } = req.body;
    if (!content || content.trim().length < 10) return res.status(400).json({ error: 'Testimonial must be at least 10 characters' });
    const result = await marketingService.processTestimonial(user.id, content);
    res.json({ success: true, analysis: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// SUPPORT API ROUTES (User-facing)
// ============================================

// Knowledge base search
app.get('/api/support/kb/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });
    const results = await supportService.searchKB(q);
    res.json({ articles: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Knowledge base list
app.get('/api/support/kb', async (req, res) => {
  try {
    const { category } = req.query;
    const articles = await supportService.listKB(category || null);
    res.json({ articles });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark KB article helpful
app.post('/api/support/kb/:id/helpful', async (req, res) => {
  try {
    await supportService.markHelpful(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create support ticket
app.post('/api/support/ticket', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { subject, description, priority } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject is required' });
    const ticket = await supportService.createTicket(user.id, subject, description, priority || 'p2');
    res.json({ success: true, ticket });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get user's own tickets
app.get('/api/support/tickets', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query(
      'SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    );
    res.json({ tickets: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A/B experiment variant assignment (user-facing)
app.get('/api/experiment/:experimentId/variant', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    const sessionId = req.cookies?.analytics_session || null;
    const variant = await productIntelService.assignVariant(
      parseInt(req.params.experimentId),
      user?.id || null,
      sessionId
    );
    res.json({ variant });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// A/B experiment conversion tracking (user-facing)
app.post('/api/experiment/:experimentId/convert', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    const sessionId = req.cookies?.analytics_session || null;
    const { event } = req.body;
    await productIntelService.recordConversion(
      parseInt(req.params.experimentId),
      user?.id || null,
      sessionId,
      event || 'default'
    );
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ============================================
// GLOBAL ERROR HANDLER
// ============================================

app.use((err, req, res, next) => {
  console.error('[Error Handler] Unhandled error:', {
    message: err.message,
    code: err.code,
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString()
  });

  // Prevent stack trace leakage in production
  const isDev = process.env.NODE_ENV !== 'production';
  const stack = isDev ? err.stack : undefined;

  // Handle specific error types
  if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
    return res.status(408).json({
      error: 'Request timeout',
      message: 'The request took too long. Please try again.'
    });
  }

  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    return res.status(503).json({
      error: 'Service unavailable',
      message: 'Please try again in a moment.'
    });
  }

  // Default error response
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(isDev && { stack })
  });
});

// ============================================
// 404 HANDLER (must be LAST)
// ============================================

app.use((req, res) => {
  // Serve branded 404 page for HTML requests (from cache)
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    const cached404 = htmlCache.get('404.html');
    res.status(404).type('html').send(cached404 || '<h1>404 - Not Found</h1>');
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ============================================
// DATABASE & STARTUP
// ============================================

async function startServer() {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    console.log('Database connected');

    // Run migrations
    const migrateScript = require('./migrate.js');
    console.log('Database migrations completed');

    // Initialize scheduler with AI service
    const AIService = require('./lib/ai-service');
    const aiService = new AIService(pool);
    initializeScheduler(pool, aiService);
    console.log('Scheduler initialized');

    // Start server (assign to `server` for graceful shutdown)
    server = app.listen(port, () => {
      console.log(`Koldly server running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

let server;

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received. Shutting down gracefully...`);

  if (server) {
    server.close(() => {
      console.log('[Shutdown] HTTP server closed');
      pool.end(() => {
        console.log('[Shutdown] Database pool closed');
        process.exit(0);
      });
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('[Shutdown] Forced exit after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();

module.exports = app;
