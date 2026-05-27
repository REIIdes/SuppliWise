const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const authRoutes = require('./routes/auth');
const assessmentRoutes = require('./routes/assessment');
const recommendRoutes = require('./routes/recommend');
const chatRoutes = require('./routes/chat');
const polishRoutes = require('./routes/polish');

const app = express();

// Middleware
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174'], credentials: true }));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/recommend', recommendRoutes);
app.use('/api/chat', chatRoutes);
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
