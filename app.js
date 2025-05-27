const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Use JSON parser for all routes except the webhook
const jsonParser = bodyParser.json();
const rawBodyParser = bodyParser.raw({ type: 'application/json' }); // restrict raw parser to json type

app.use((req, res, next) => {
  console.log('Incoming request URL:', req.originalUrl);
  if (req.originalUrl === '/api/payment/webhook') {
    rawBodyParser(req, res, next);
  } else {
    jsonParser(req, res, next);
  }
});

// Load route handlers
const indexRoutes = require('./routes/index');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');
const triviaRoute = require('./routes/trivia');

app.use('/', indexRoutes);
app.use('/api', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trivia', triviaRoute);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('EPD webhook secret loaded:', !!process.env.EPD_WEBHOOK_SECRET);
});
