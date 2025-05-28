const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch'); // npm install node-fetch
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Setup body parsers
const jsonParser = bodyParser.json();
const rawBodyParser = bodyParser.raw({ type: 'application/json' });

app.use((req, res, next) => {
  console.log('Incoming request URL:', req.originalUrl);
  if (req.originalUrl === '/api/payment/webhook') {
    rawBodyParser(req, res, next);
  } else {
    jsonParser(req, res, next);
  }
});

// === ✅ EPD Webhook Receiver ===
app.post('/api/payment/webhook', rawBodyParser, (req, res) => {
  try {
    const rawBody = req.body.toString(); // Buffer to string
    console.log('🔔 EPD Webhook received:', rawBody);

    // You can parse and verify webhook payload here if needed

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send('Webhook processing failed');
  }
});

// === 🔁 All other routes ===
const indexRoutes = require('./routes/index');
const adminRoutes = require('./routes/admin');
const triviaRoute = require('./routes/trivia');

app.use('/', indexRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trivia', triviaRoute);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// === 🚀 Start server ===
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('EPD webhook secret loaded:', !!process.env.EPD_WEBHOOK_SECRET);
});
