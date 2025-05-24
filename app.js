const express = require('express');
const bodyParser = require('body-parser'); // ✅ keep as-is
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// ✅ Instantiate the JSON parser once
const jsonParser = bodyParser.json();

// ✅ Use JSON parser for all routes *except* the Stripe webhook
app.use((req, res, next) => {
  // Only skip raw parsing for the webhook route
  if (req.originalUrl === '/api/payment/webhook') {
    next();
  } else {
    jsonParser(req, res, next);
  }
});

// ✅ Load routes AFTER the middleware
const indexRoutes = require('./routes/index');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');

// ✅ NEW: Trivia route to serve trivia questions
const triviaRoute = require('./routes/trivia');

app.use('/', indexRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trivia', triviaRoute); // ✅ add trivia route
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Stripe secret key loaded:', !!process.env.STRIPE_SECRET_KEY);
  console.log('Stripe webhook secret loaded:', !!process.env.STRIPE_WEBHOOK_SECRET);
});
