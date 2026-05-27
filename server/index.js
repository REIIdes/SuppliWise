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

const app = express();

// ── Security headers (helmet sets X-Frame-Options, X-Content-Type-Options,
//    Strict-Transport-Security, X-XSS-Protection, etc. automatically) ───────
app.use(helmet());

// Middleware
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174'], credentials: true }));
app.use(express.json());

// ── Rate limiters ──────────────────────────────────────────────────────────
// Auth: 20 attempts per 15 min per IP (prevents brute-force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait 15 minutes and try again.' },
});

// AI routes: 15 requests per 10 min per IP (protects Groq quota)
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/recommend', aiLimiter, recommendRoutes);
app.use('/api/chat', aiLimiter, chatRoutes);
app.use('/api/polish', polishRoutes);

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
