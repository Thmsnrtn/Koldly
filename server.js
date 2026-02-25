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

// CORS Configuration - only allow koldly.com and koldly.polsia.app
const allowedOrigins = [
  'https://koldly.com',
  'https://www.koldly.com',
  'https://koldly.polsia.app',
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

app.use('/api/', apiLimiter);

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
const webhookService = new WebhookService();
const slackService = new SlackService();

// Register inbox routes
registerInboxRoutes(app, pool);

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

// Serve HTML pages as routes (fallback for static file serving issues)
app.get('/proof', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/proof.html'), 'utf8'));
});

app.get('/demo', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/demo.html'), 'utf8'));
});

// Protected: Onboarding (may be public but often protected)
app.get('/onboarding', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/onboarding.html'), 'utf8'));
});

// Public: Pricing
app.get('/pricing', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/pricing.html'), 'utf8'));
});

// Protected: Settings
app.get('/settings', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/settings.html'), 'utf8'));
});

// Protected: Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/dashboard.html'), 'utf8'));
});

// Protected: Campaigns
app.get('/campaigns', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/campaigns.html'), 'utf8'));
});

// Protected: Analytics
app.get('/analytics', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/analytics.html'), 'utf8'));
});

// Protected: Integrations
app.get('/integrations', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/integrations.html'), 'utf8'));
});

// Protected: Campaign Sending
app.get('/campaign-sending', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/campaign-sending.html'), 'utf8'));
});

// Protected: Inbox
app.get('/inbox', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/inbox.html'), 'utf8'));
});

// Protected: Admin Metrics
app.get('/admin/metrics', requireAuth, (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/admin-metrics.html'), 'utf8'));
});

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

    // Send reset email via Polsia email proxy
    const resetUrl = `https://koldly.com/reset-password?token=${resetData.token}`;

    try {
      await fetch('https://polsia.com/api/proxy/email/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.POLSIA_API_KEY}`
        },
        body: JSON.stringify({
          to: resetData.email,
          subject: 'Reset Your Koldly Password',
          body: `You requested a password reset for your Koldly account.\n\nClick here to reset your password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #FF6B35;">Reset Your Password</h2>
              <p>You requested a password reset for your Koldly account.</p>
              <p>Click the button below to reset your password:</p>
              <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #FF6B35; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0;">Reset Password</a>
              <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
              <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
              <p style="color: #999; font-size: 12px;">If the button doesn't work, copy and paste this link:<br>${resetUrl}</p>
            </div>
          `,
          transactional: true  // Bypass rate limit for password reset emails
        })
      });
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

    // Redirect to dashboard with token
    res.redirect(`/dashboard?token=${token}&email=${encodeURIComponent(user.email)}&verified=${isVerified ? '1' : '0'}`);
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

    // Send verification email via Polsia email proxy
    const verifyUrl = `https://koldly.com/verify-email?token=${verificationToken}`;

    try {
      await fetch('https://polsia.com/api/proxy/email/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.POLSIA_API_KEY}`
        },
        body: JSON.stringify({
          to: email,
          subject: 'Verify Your Koldly Email Address',
          html: `
            <h2>Verify Your Email</h2>
            <p>Click the link below to verify your email address:</p>
            <p><a href="${verifyUrl}" style="background: #FF6B35; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Verify Email</a></p>
            <p>Or paste this link: ${verifyUrl}</p>
            <p style="color: #888; font-size: 12px;">This link expires in 24 hours.</p>
          `,
          text: `Verify your email: ${verifyUrl}`
        })
      });
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

// Serve login and signup pages
app.get('/login', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/login.html'), 'utf8'));
});

app.get('/signup', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/signup.html'), 'utf8'));
});

app.get('/forgot-password', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/forgot-password.html'), 'utf8'));
});

app.get('/reset-password', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/reset-password.html'), 'utf8'));
});

// Legal pages
app.get('/terms', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/terms.html'), 'utf8'));
});

app.get('/privacy', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/privacy.html'), 'utf8'));
});

// Billing page
app.get('/billing', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/billing.html'), 'utf8'));
});

// ============================================
// BILLING API ROUTES (Protected)
// ============================================

// Get user's current plan
app.get('/api/billing/plan', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const result = await pool.query(
      `SELECT
        subscription_plan,
        subscription_status,
        subscription_expires_at,
        subscription_updated_at,
        stripe_subscription_id
      FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const plans = {
      'starter': { name: 'Starter', monthlyPrice: 49 },
      'growth': { name: 'Growth', monthlyPrice: 149 },
      'scale': { name: 'Scale', monthlyPrice: 399 }
    };

    const plan = plans[user.subscription_plan] || plans.starter;
    const status = user.subscription_status || 'inactive';

    // Calculate next billing date (30 days from now)
    const nextBilling = new Date();
    nextBilling.setDate(nextBilling.getDate() + 30);

    // Calculate renewal date
    const renewalDate = user.subscription_expires_at || nextBilling;

    res.json({
      success: true,
      plan: {
        name: plan.name,
        monthlyPrice: plan.monthlyPrice,
        status,
        nextBillingDate: nextBilling.toISOString(),
        renewalDate: renewalDate.toISOString()
      }
    });
  } catch (err) {
    console.error('Plan fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch plan information' });
  }
});

// Get Stripe customer portal URL
app.get('/api/billing/portal', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT stripe_subscription_id FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (!user.stripe_subscription_id) {
      // User hasn't subscribed yet - redirect to pricing
      return res.json({ portalUrl: 'https://koldly.com/pricing' });
    }

    // In production, you would use Stripe API to create a billing portal session
    // For now, we'll return a link to Stripe's customer portal
    const portalUrl = 'https://billing.stripe.com/login/test_1F6SBg0bZa1w';

    res.json({ success: true, portalUrl });
  } catch (err) {
    console.error('Portal URL error:', err);
    res.status(500).json({ error: 'Failed to generate portal URL' });
  }
});

// Get invoices (placeholder)
app.get('/api/billing/invoices', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // In production, fetch from Stripe API
    // For now, return empty invoices
    res.json({
      success: true,
      invoices: []
    });
  } catch (err) {
    console.error('Invoices fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

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

    // Get key metrics
    const statsResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM campaigns WHERE user_id = $1) as total_campaigns,
        (SELECT COUNT(DISTINCT prospect_id) FROM campaign_sending_queue WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)) as total_prospects,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1) AND status = 'sent') as emails_sent,
        (SELECT COUNT(*) FROM campaign_sending_queue WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1) AND status = 'pending') as emails_pending,
        (SELECT COUNT(*) FROM prospect_replies WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1)) as replies_received,
        (SELECT COUNT(*) FROM campaign_sending_context WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = $1) AND status = 'active') as active_campaigns
    `, [user.id]);

    const stats = statsResult.rows[0] || {};

    // Calculate reply rate
    const emailsSent = parseInt(stats.emails_sent) || 0;
    const repliesReceived = parseInt(stats.replies_received) || 0;
    const replyRate = emailsSent > 0 ? Math.round((repliesReceived / emailsSent) * 100) : 0;

    res.json({
      total_campaigns: parseInt(stats.total_campaigns) || 0,
      total_prospects: parseInt(stats.total_prospects) || 0,
      emails_sent: emailsSent,
      emails_pending: parseInt(stats.emails_pending) || 0,
      reply_rate: replyRate,
      active_campaigns: parseInt(stats.active_campaigns) || 0,
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
// ANALYTICS & METRICS (Admin-only)
// ============================================

app.get('/api/metrics', async (req, res) => {
  try {
    const user = await authenticateRequest(req, authService);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Admin check - only founder account can access (thmsnrtn@gmail.com)
    if (user.email !== 'thmsnrtn@gmail.com') {
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

    // Revenue - placeholder (would need Stripe integration)
    const revenue = {
      mrr: 0,
      total: 0,
      note: 'Stripe integration pending'
    };

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
  // If a file is being requested but not found, it's a 404
  // Serve branded 404 page for HTML requests
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    res.status(404).type('html').send(fs.readFileSync(path.join(__dirname, 'public/404.html'), 'utf8'));
  } else {
    // Return JSON for API requests
    res.status(404).json({ error: 'Not found' });
  }
});

// ============================================
// ERROR HANDLER (must be LAST)
// ============================================

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
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

    // Initialize scheduler
    initializeScheduler(pool);
    console.log('Scheduler initialized');

    // Start server
    app.listen(port, () => {
      console.log(`Koldly server running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
