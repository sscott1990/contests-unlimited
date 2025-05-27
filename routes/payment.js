console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'set' : 'missing');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'missing');

const express = require('express');
const path = require('path');
const multer = require('multer');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const fs = require('fs');
const fetch = require('node-fetch');  // npm install node-fetch@2
const router = express.Router();

const endpointSecret = process.env.EPD_WEBHOOK_SECRET || '';
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const EASY_PAY_DIRECT_SECRET = process.env.EPD_API_KEY; // your private key for API calls

// === ✅ AWS S3 configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// === ✅ S3 JSON Helpers
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

// === ✅ Create EasyPayDirect session endpoint
router.post('/create-session', async (req, res) => {
  try {
    const response = await fetch('https://api.easypaydirectgateway.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${EASY_PAY_DIRECT_SECRET}`,
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
        // Add any other session parameters you need here
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('EasyPayDirect session creation failed:', errorData);
      return res.status(500).json({ error: 'Failed to create session', details: errorData });
    }

    const data = await response.json();
    res.json({ sessionId: data.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Server error creating session' });
  }
});

// === ✅ Webhook Handler
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

// === ✅ Upload handler (for files and trivia)
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), async (req, res) => {
  const { name, contest, triviaAnswers, timeTaken, session_id } = req.body;
  if (!session_id) return res.status(400).send('Missing payment session ID.');

  const entries = await loadEntries();
  const matched = entries.find(e => e.id === session_id && e.paymentStatus === 'paid');
  if (!matched) return res.status(403).send('Invalid or unpaid session.');
  if (matched.used) return res.status(409).send('This payment session has already been used.');

  const uploads = await loadUploads();

  // 🎯 Trivia Contest handler
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
