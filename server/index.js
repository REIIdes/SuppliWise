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

const app = express();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'suppliwise_jwt_secret_key_change_in_production') {
  throw new Error('JWT_SECRET is missing or still uses the default placeholder value.');
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
  skip: (req) => process.env.NODE_ENV !== 'production' && req.path === '/login',
});

// Recommend: 15 requests per 10 min per IP (protects Groq quota)
const recommendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/recommend', recommendLimiter, recommendRoutes);
app.use('/api/chat', chatRoutes);       // no rate limit — chat needs to feel instant
app.use('/api/polish', polishRoutes);
app.use('/api/supplement-detail', supplementDetailRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/insights', insightsRoutes);

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
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
