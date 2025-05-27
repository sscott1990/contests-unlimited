console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'set' : 'missing');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'missing');

const express = require('express');
const path = require('path');
const multer = require('multer');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const router = express.Router();

const epdApiKey = process.env.EPD_API_KEY || '';
const endpointSecret = process.env.EPD_WEBHOOK_SECRET || '';
console.log('🔑 Loaded webhook secret (first 6 chars):', endpointSecret.slice(0, 6));

console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? '***' : 'MISSING');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '***' : 'MISSING');
console.log('AWS_REGION:', process.env.AWS_REGION || 'MISSING');
console.log('S3_BUCKET_NAME:', process.env.S3_BUCKET_NAME || 'MISSING');

// ✅ AWS S3 configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// === S3 helper functions ===
async function loadJSONFromS3(key) {
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: key }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

async function saveJSONToS3(key, data) {
  await s3.putObject({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json'
  }).promise();
}

async function loadEntries() {
  return loadJSONFromS3('entries.json');
}

async function saveEntries(entries) {
  await saveJSONToS3('entries.json', entries);
}

async function loadUploads() {
  return loadJSONFromS3('uploads.json');
}

async function saveUploads(uploads) {
  await saveJSONToS3('uploads.json', uploads);
}

// === EPD Checkout Session Creation ===
router.post('/create-checkout-session', async (req, res) => {
  try {
    const payload = {
      amount: 500,
      currency: 'USD',
      description: 'Contest Entry',
      success_url: `${req.headers.origin}/success.html?session_id={SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel.html`
    };

    const response = await fetch('https://api.easypaymentdirect.com/v1/checkout/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${epdApiKey}`,
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`EPD API error: ${response.status} ${errorText}`);
    }

    const session = await response.json();
    console.log('EPD session created:', session.id);
    res.json({ id: session.id });
  } catch (error) {
    console.error('EPD create checkout session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === ✅ Webhook Handler with Signature Verification & Payload Capture ===
// Changed here: removed express.raw() middleware to rely on app.js raw parser
router.post('/webhook', async (req, res) => {
  const signatureHeader = req.headers['webhook-signature'];

  if (!signatureHeader) {
    console.error('❌ Missing EPD signature header');
    return res.status(400).send('Missing signature');
  }

  const parts = signatureHeader.split(',').map(p => p.trim());
  const timestampPart = parts.find(p => p.startsWith('t='));
  const signaturePart = parts.find(p => p.startsWith('s='));

  if (!timestampPart || !signaturePart) {
    console.error('❌ Malformed signature header');
    return res.status(400).send('Malformed signature');
  }

  const timestamp = timestampPart.split('=')[1];
  const signature = signaturePart.split('=')[1];

  // Check timestamp freshness (within last 5 minutes)
  const timestampInt = parseInt(timestamp, 10);
  const currentUnix = Math.floor(Date.now() / 1000);
  const FIVE_MINUTES = 5 * 60;
  if (Math.abs(currentUnix - timestampInt) > FIVE_MINUTES) {
    console.error('❌ Webhook signature timestamp too old or too far in the future');
    return res.status(400).send('Invalid timestamp');
  }

  const hmac = crypto.createHmac('sha256', endpointSecret);
  // req.body is a Buffer (raw body)
  hmac.update(req.body);
  const digest = hmac.digest('hex');

  console.log('🔐 Expected digest:', digest);
  console.log('📩 Received signature:', signature);

  // Write payload with timestamped filename for debugging
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(`payload_${ts}.json`, req.body.toString('utf8'));
  } catch (err) {
    console.error('❌ Failed to save payload to file:', err);
  }

  if (digest !== signature) {
    console.error('❌ Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('❌ Webhook JSON parse error:', err);
    return res.status(400).send('Invalid JSON');
  }

  console.log('✅ Received EPD webhook event:', event);

  if (event.type === 'payment.completed') {
    const session = event.data;

    const entries = await loadEntries();
    entries.push({
      id: session.id,
      paymentStatus: 'paid',
      customerEmail: session.customer_email || 'anonymous',
      timestamp: new Date().toISOString()
    });
    await saveEntries(entries);
  }

  res.json({ received: true });
});

// ✅ Upload handler (memory-based)
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), async (req, res) => {
  const { name, contest, triviaAnswers, timeTaken, session_id } = req.body;

  if (!session_id) return res.status(400).send('Missing payment session ID.');

  const entries = await loadEntries();
  const matched = entries.find(e => e.id === session_id && e.paymentStatus === 'paid');

  if (!matched) return res.status(403).send('Invalid or unpaid session.');
  if (matched.used) return res.status(409).send('This payment session has already been used.');

  const uploads = await loadUploads();

  if (contest === 'Trivia Contest') {
    if (!name || !triviaAnswers || !timeTaken) {
      return res.status(400).send('Missing trivia submission data.');
    }

    let parsedAnswers;
    try {
      parsedAnswers = JSON.parse(triviaAnswers);
    } catch {
      return res.status(400).send('Invalid trivia answers format.');
    }

    uploads.push({
      userName: name,
      contestName: contest,
      timestamp: new Date().toISOString(),
      correctCount: parsedAnswers.filter(ans => ans.correct).length,
      timeTaken: Number(timeTaken)
    });

    await saveUploads(uploads);

    matched.used = true;
    await saveEntries(entries);

    console.log('✅ Trivia entry saved for:', name);

    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Trivia Submission Successful</title>
      <style>body{font-family:Arial;text-align:center;margin-top:50px;background:#f0f8ff;color:#005b96;}</style>
      <script>setTimeout(()=>{window.location.href='/'},2000);</script>
      </head><body><h1>✅ Trivia Submission Successful!</h1><p>Redirecting to homepage...</p></body></html>
    `);
  }

  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const timestamp = Date.now();
  const safeUserName = name?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'user';
  const safeContestName = contest?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'contest';
  const originalName = file.originalname.replace(/\s+/g, '_');
  const s3Key = `${safeUserName}_${safeContestName}_${timestamp}_${originalName}`;

  try {
    await s3.putObject({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: file.buffer,
      ContentType: file.mimetype
    }).promise();
  } catch (err) {
    console.error('❌ Failed to upload to S3:', err);
    return res.status(500).send('Upload failed.');
  }

  uploads.push({
    userName: name,
    contestName: contest,
    timestamp: new Date().toISOString(),
    originalFilename: file.originalname,
    savedFilename: s3Key,
  });
  await saveUploads(uploads);

  matched.used = true;
  await saveEntries(entries);

  console.log('✅ File uploaded to S3:', s3Key);
  console.log('👤 Name:', name);
  console.log('🏆 Contest:', contest);

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Upload Successful</title>
    <style>body{font-family:Arial;text-align:center;margin-top:50px;background:#e6ffed;color:#2d662d;}</style>
    <script>setTimeout(()=>{window.location.href='/'},2000);</script>
    </head><body><h1>✅ Upload Successful!</h1><p>Redirecting to homepage...</p></body></html>
  `);
});

module.exports = router;
