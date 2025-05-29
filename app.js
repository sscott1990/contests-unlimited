const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const AWS = require('aws-sdk');
const multer = require('multer');  // <-- Add multer for file uploads
const { v4: uuidv4 } = require('uuid'); // For UUID generation
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure AWS S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
});

const ENTRIES_BUCKET = process.env.S3_BUCKET_NAME;
const ENTRIES_KEY = 'entries.json';
const UPLOADS_KEY = 'uploads.json';
const CREATORS_KEY = 'creator.json';

// Serve static files
app.use(express.static('public'));

// Setup body parsers
const jsonParser = bodyParser.json();
const rawBodyParser = bodyParser.raw({ type: 'application/json' });

// Smart parser switch based on route
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payment/webhook') {
    rawBodyParser(req, res, next);
  } else {
    jsonParser(req, res, next);
  }
});

// Multer memory storage for uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
  },
});

// === 🔑 Generate a UUID for new checkout session ===
app.get('/api/session', (req, res) => {
  const uuid = uuidv4();
  res.json({ sessionId: uuid });
});

// === 📛 UUID for contest creator ===
app.get('/api/creator/session', (req, res) => {
  const creatorSessionId = uuidv4();
  res.json({ creatorSessionId });
});

// === 📦 Helpers for S3 file access ===
async function getEntries() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: ENTRIES_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

async function saveEntries(entries) {
  await s3.putObject({
    Bucket: ENTRIES_BUCKET,
    Key: ENTRIES_KEY,
    Body: JSON.stringify(entries, null, 2),
    ContentType: 'application/json',
  }).promise();
}

async function getUploads() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: UPLOADS_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

async function saveUploads(uploads) {
  await s3.putObject({
    Bucket: ENTRIES_BUCKET,
    Key: UPLOADS_KEY,
    Body: JSON.stringify(uploads, null, 2),
    ContentType: 'application/json',
  }).promise();
}

async function getCreators() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: CREATORS_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

async function saveCreators(creators) {
  await s3.putObject({
    Bucket: ENTRIES_BUCKET,
    Key: CREATORS_KEY,
    Body: JSON.stringify(creators, null, 2),
    ContentType: 'application/json',
  }).promise();
}

// === ✅ EPD Webhook Receiver ===
app.post('/api/payment/webhook', rawBodyParser, async (req, res) => {
  try {
    const rawBody = req.body.toString(); // Buffer to string
    console.log('🔔 EPD Webhook received:', rawBody);

    const webhookData = JSON.parse(rawBody);

    if (
      webhookData.event_type === 'transaction.sale.success' &&
      webhookData.event_body &&
      webhookData.event_body.transaction_id
    ) {
      const sessionId = webhookData.event_body.transaction_id;

      const paymentRecord = {
        sessionId,
        amount: webhookData.event_body.action.amount,
        status: webhookData.event_body.action.success === "1" ? 'success' : 'failed',
        timestamp: new Date().toISOString(),
        customerEmail: webhookData.event_body.billing_address?.email || null,
        billingAddress: webhookData.event_body.billing_address || {},
        shippingAddress: webhookData.event_body.shipping_address || {},
      };

      const entries = await getEntries();
      entries.push(paymentRecord);
      await saveEntries(entries);

      console.log(`✅ Payment record saved with sessionId: ${sessionId}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(400).send('Webhook processing failed');
  }
});

// === 🚩 New route for handling uploads ===
app.post('/api/payment/upload', upload.single('file'), async (req, res) => {
  try {
    const { name, contest, session_id, triviaAnswers } = req.body;
    let { timeTaken } = req.body;
    const file = req.file;

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    timeTaken = parseFloat(timeTaken);
    if (isNaN(timeTaken)) timeTaken = null;

    let fileUrl = null;
    if (file) {
      const s3Key = `uploads/${session_id}/${Date.now()}_${file.originalname}`;
      await s3.putObject({
        Bucket: ENTRIES_BUCKET,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }).promise();

      fileUrl = `https://${ENTRIES_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
    }

    const uploads = await getUploads();
    const alreadyUploaded = uploads.find(u => u.sessionId === session_id);
    if (alreadyUploaded) {
      return res.status(400).json({ error: 'Upload already completed for this session.' });
    }

    uploads.push({
      sessionId: session_id,
      name,
      contest,
      fileUrl,
      triviaAnswers: triviaAnswers ? JSON.parse(triviaAnswers) : null,
      timeTaken,
      timestamp: new Date().toISOString(),
    });

    await saveUploads(uploads);

    res.redirect('/success-submitted.html');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/creator/upload', upload.none(), async (req, res) => {
  try {
    const { name, email, contestTitle, creatorSessionId, description, prizeModel } = req.body;
    const session_id = creatorSessionId;

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    const creators = await getCreators();
    const alreadySubmitted = creators.find(c => c.sessionId === session_id);
    if (alreadySubmitted) {
      return res.status(400).json({ error: 'Submission already exists for this session.' });
    }

   creators.push({
  sessionId: session_id,
  creatorName: name,    // save the actual person’s name here
  email,
  contestName: contestTitle,  // contest name here
  description,
  prizeModel,
  approved: false,
  timestamp: new Date().toISOString(),
});

    await saveCreators(creators);

    res.redirect('/success-creator-submitted.html');
  } catch (err) {
    console.error('Creator submission error:', err);
    res.status(500).json({ error: 'Failed to submit creator info' });
  }
});

// === 🔁 All other routes ===
const indexRoutes = require('./routes/index');
const adminRoutes = require('./routes/admin');
const triviaRoute = require('./routes/trivia');

app.use('/', indexRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trivia', triviaRoute);

// ⛳ Serve uploaded files via S3 proxy
app.get('/uploads/:sessionId/:fileName', async (req, res) => {
  const { sessionId, fileName } = req.params;
  const key = `uploads/${sessionId}/${fileName}`;

  try {
    const fileStream = s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: key,
    }).createReadStream();

    fileStream.on('error', err => {
      console.error('S3 stream error:', err);
      res.status(404).send('File not found');
    });

    fileStream.pipe(res);
  } catch (err) {
    console.error('File serving error:', err);
    res.status(500).send('Failed to retrieve file');
  }
});

// === 🚀 Start server ===
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('EPD webhook secret loaded:', !!process.env.EPD_WEBHOOK_SECRET);
});
