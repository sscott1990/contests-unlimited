const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch'); // Make sure to install this: npm install node-fetch
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

// === ✅ EPD Create Checkout Session Route ===
app.post('/api/payment/create-checkout-session', async (req, res) => {
  try {
    const response = await fetch('https://api.easypaydirectgateway.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.EPD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'sale',
        lineItems: [
          {
            lineItemType: 'purchase',
            sku: 'contest-entry-may2025',
            quantity: 1,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('EPD session creation failed:', errorText);
      return res.status(500).json({ error: 'Failed to create session' });
    }

    const data = await response.json();
    res.json({ sessionId: data.id });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === ✅ Optional: EPD Webhook Receiver (for future use) ===
app.post('/api/payment/webhook', rawBodyParser, (req, res) => {
  console.log('EPD Webhook received:', req.body);
  res.status(200).send('OK');
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
