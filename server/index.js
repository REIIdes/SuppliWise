const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const authRoutes = require('./routes/auth');
const assessmentRoutes = require('./routes/assessment');
const recommendRoutes = require('./routes/recommend');
const chatRoutes = require('./routes/chat');
const polishRoutes = require('./routes/polish');
const supplementDetailRoutes = require('./routes/supplement_detail');
const dashboardRoutes = require('./routes/dashboard');
const insightsRoutes = require('./routes/insights');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');
const AdminAccount = require('./models/AdminAccount');

const app = express();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'suppliwise_jwt_secret_key_change_in_production') {
  throw new Error('JWT_SECRET is missing or still uses the default placeholder value.');
}

// Production safeguard: OTP values must never be exposed in API responses.
// Refuse to boot live with the dev override enabled.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_OTP_RESPONSE === 'true') {
  throw new Error('ALLOW_DEV_OTP_RESPONSE must never be "true" in production.');
}

// ── Security headers ──────────────────────────────────────────────────────
// Helmet sets X-Frame-Options, X-Content-Type-Options, HSTS, etc.
// CSP is disabled — it blocks localhost API calls in development and
// requires domain-specific config before enabling in production.
app.use(helmet({ contentSecurityPolicy: false }));

// Middleware
// Allow CORS from web dev servers and mobile app (Capacitor uses capacitor:// or http://localhost on device)
app.use(cors({ 
  origin: [
    'http://localhost:5173', 
    'http://localhost:5174',
    'http://localhost:5175',
    'https://localhost:5173',
    'https://localhost:5174', 
    'https://localhost:5175',
    'capacitor://localhost',
    'http://localhost', // Mobile app
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/, // Allow any local network IP
    /^https:\/\/192\.168\.\d+\.\d+:\d+$/ // HTTPS version
  ], 
  credentials: true 
}));
app.use(express.json({ limit: '10mb' })); // Increase limit for profile/banner images

// Add a middleware to set Cache-Control headers
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── Rate limiters ──────────────────────────────────────────────────────────
// Keep production limits strict while allowing repeated localhost testing.
const isLocalDevRequest = (req) => process.env.NODE_ENV !== 'production' ||
  ['localhost', '127.0.0.1'].includes(req.hostname) || req.ip.includes('127.0.0.1') || req.ip.includes('::1');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 200 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait 15 minutes and try again.' },
});

// Recommend: 15 requests per 10 min per IP (protects Groq quota)
const recommendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

// AI-adjacent endpoints: generous but bounded (protects OpenRouter quota)
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 300 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

// General API abuse guard (dashboard/insights/assessment polling) — kept for future use
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again.' },
});

// ── Dedicated rate limiters for Admins vs Users ───────────────────────────
// Separate buckets so admin traffic never starves user traffic and vice-versa.
// Production limits are stricter; local dev stays generous for testing/HMR.
const userLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again.' },
});

const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: (req) => isLocalDevRequest(req) ? 300 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many admin requests. Please slow down and try again.' },
});

// Routes — admin vs user buckets are isolated
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/assessment', userLimiter, assessmentRoutes);
app.use('/api/recommend', recommendLimiter, recommendRoutes);
app.use('/api/chat', userLimiter, chatRoutes);
app.use('/api/polish', aiLimiter, polishRoutes);
app.use('/api/supplement-detail', aiLimiter, supplementDetailRoutes);
app.use('/api/dashboard', userLimiter, dashboardRoutes);
app.use('/api/insights', userLimiter, insightsRoutes);
app.use('/api/notifications', userLimiter, notificationRoutes);
app.use('/api/admin', adminLimiter, adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// ── Global error handler — catches any unhandled errors in routes ──────────
// Must be defined AFTER all routes and have 4 parameters (err, req, res, next)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log the full technical error internally
  console.error('[Global Error Handler]', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Never expose stack traces or raw DB errors to the client
  const status = err.status || err.statusCode || 500;
  const userMessage = status < 500
    ? (err.message || 'An error occurred.')
    : 'Something went wrong. Please try again later.';

  res.status(status).json({ message: userMessage });
});

// Connect to MongoDB and start server
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    const legacy = process.env.ADMIN_ALIAS && process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_TOTP_SECRET
      ? [{ alias: process.env.ADMIN_ALIAS, passwordHash: process.env.ADMIN_PASSWORD_HASH, totpSecret: process.env.ADMIN_TOTP_SECRET }]
      : [];
    const configuredAdmins = String(process.env.ADMIN_ACCOUNTS || '').split(',').map(entry => {
      const [alias, passwordHash, totpSecret] = entry.split('|').map(value => value.trim());
      return alias && passwordHash && totpSecret ? { alias, passwordHash, totpSecret } : null;
    }).filter(Boolean);
    const accounts = [...legacy, ...configuredAdmins];
    return Promise.all(accounts.map(account => AdminAccount.updateOne({ alias: account.alias }, { $setOnInsert: account }, { upsert: true })))
      .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
      .then(() => {
        // Non-blocking SMTP check — bad credentials surface in the log at boot
        const { verifyEmailConfig } = require('./utils/email');
        verifyEmailConfig().catch(() => {});
      });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });