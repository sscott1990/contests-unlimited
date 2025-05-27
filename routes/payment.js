console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'set' : 'missing');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'missing');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const express = require('express');
const path = require('path');
const multer = require('multer');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const fs = require('fs');
const router = express.Router();

const epdApiKey = process.env.EPD_API_KEY || '';
const endpointSecret = process.env.EPD_WEBHOOK_SECRET || '';
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

console.log('🔑 Loaded webhook secret (first 6 chars):', endpointSecret.slice(0, 6));
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? '***' : 'MISSING');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '***' : 'MISSING');
console.log('AWS_REGION:', process.env.AWS_REGION || 'MISSING');
console.log('S3_BUCKET_NAME:', BUCKET_NAME || 'MISSING');

// ✅ AWS S3 configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// === S3 JSON Helpers ===
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
async function loadEntries() { return loadJSONFromS3('entries.json'); }
async function saveEntries(entries) { return saveJSONToS3('entries.json', entries); }
async function loadUploads() { return loadJSONFromS3('uploads.json'); }
async function saveUploads(uploads) { return saveJSONToS3('uploads.json', uploads); }

// === ✅ Create Checkout Session with session_id ===
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { name = 'anonymous', contest = 'unknown' } = req.body;
    const sessionId = crypto.randomUUID();

    const entries = await loadEntries();
    entries.push({
      id: sessionId,
      paymentStatus: 'pending',
      name,
      contest,
      used: false,
      createdAt: new Date().toISOString()
    });
    await saveEntries(entries);

    const redirectUrl = `https://contests-unlimited.onrender.com/success.html?session_id=${sessionId}`;
    const cancelUrl = `https://contests-unlimited.onrender.com/cancel.html`;

    const payload = {
      type: 'sale',
      amount: '5.00',
      description: 'Contest Entry',
      redirect_url: redirectUrl,
      cancel_url: cancelUrl,
      security_key: epdApiKey,
    };

    const params = new URLSearchParams(payload);

    const response = await fetch('https://secure.easypaydirectgateway.com/api/transact.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const text = await response.text();
    console.log('EPD raw response:', text);

    const result = Object.fromEntries(new URLSearchParams(text));
    if (!result.redirect_url) {
      throw new Error(`EPD response missing redirect_url: ${JSON.stringify(result)}`);
    }

    res.json({ redirect_url: result.redirect_url });
  } catch (error) {
    console.error('EPD create checkout session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === ✅ Webhook Handler ===
router.post('/webhook', async (req, res) => {
  const signatureHeader = req.headers['webhook-signature'];

  if (!signatureHeader) return res.status(400).send('Missing signature');

  const parts = signatureHeader.split(',').map(p => p.trim());
  const timestampPart = parts.find(p => p.startsWith('t='));
  const signaturePart = parts.find(p => p.startsWith('s='));
  if (!timestampPart || !signaturePart) return res.status(400).send('Malformed signature');

  const timestamp = timestampPart.split('=')[1];
  const signature = signaturePart.split('=')[1];

  const currentUnix = Math.floor(Date.now() / 1000);
  if (Math.abs(currentUnix - parseInt(timestamp)) > 300) {
    return res.status(400).send('Invalid timestamp');
  }

  const hmac = crypto.createHmac('sha256', endpointSecret);
  hmac.update(req.body);
  const digest = hmac.digest('hex');

  if (digest !== signature) {
    return res.status(400).send('Invalid signature');
  }

  try {
    fs.writeFileSync(`payload_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, req.body.toString('utf8'));
  } catch (err) {
    console.error('Failed to write payload to file:', err);
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON');
  }

  if (event.type === 'payment.completed') {
    const session = event.data;
    const sessionId = session.id;

    const entries = await loadEntries();
    const match = entries.find(e => e.id === sessionId);
    if (match) {
      match.paymentStatus = 'paid';
      await saveEntries(entries);
    }
  }

  res.json({ received: true });
});

// === ✅ Upload handler ===
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), async (req, res) => {
  const { name, contest, triviaAnswers, timeTaken, session_id } = req.body;
  if (!session_id) return res.status(400).send('Missing payment session ID.');

  const entries = await loadEntries();
  const matched = entries.find(e => e.id === session_id && e.paymentStatus === 'paid');
  if (!matched) return res.status(403).send('Invalid or unpaid session.');
  if (matched.used) return res.status(409).send('This payment session has already been used.');

  const uploads = await loadUploads();

  // 🎯 Trivia handler
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

    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Trivia Submission Successful</title>
      <style>body{font-family:Arial;text-align:center;margin-top:50px;background:#f0f8ff;color:#005b96;}</style>
      <script>setTimeout(()=>{window.location.href='/'},2000);</script>
      </head><body><h1>✅ Trivia Submission Successful!</h1><p>Redirecting to homepage...</p></body></html>
    `);
  }

  // 📤 File upload handler
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

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Upload Successful</title>
    <style>body{font-family:Arial;text-align:center;margin-top:50px;background:#e6ffed;color:#2d662d;}</style>
    <script>setTimeout(()=>{window.location.href='/'},2000);</script>
    </head><body><h1>✅ Upload Successful!</h1><p>Redirecting to homepage...</p></body></html>
  `);
});

module.exports = router;
