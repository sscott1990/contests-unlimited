console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'set' : 'missing');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'missing');

const express = require('express');
const path = require('path');
// const Stripe = require('stripe'); // Commented out since Stripe not used now
const multer = require('multer');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');
const router = express.Router();

const epdApiKey = process.env.EPD_API_KEY || '';
const endpointSecret = process.env.EPD_WEBHOOK_SECRET || '';

console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? '***' : 'MISSING');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '***' : 'MISSING');
console.log('AWS_REGION:', process.env.AWS_REGION || 'MISSING');
console.log('S3_BUCKET_NAME:', process.env.S3_BUCKET_NAME || 'MISSING');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function loadJSONFromS3(key) {
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: key }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      return [];
    }
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

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('🧪 Webhook hit!');
  console.log('Headers:', req.headers);
  console.log('Raw body:', req.body.toString('utf8'));

  const signature = req.headers['x-epd-signature'];
  console.log('Signature from header:', signature);
  if (!signature) {
    console.error('Missing EPD signature header');
    return res.status(400).send('Missing signature');
  }

  const hmac = crypto.createHmac('sha256', endpointSecret);
  hmac.update(req.body.toString('utf8'));
  const digest = hmac.digest('hex');
  console.log('Computed HMAC digest:', digest);

  if (digest !== signature) {
    console.error('❌ Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('Webhook JSON parse error:', err);
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

// 🚧 Test route to simulate a webhook manually
router.post('/webhook-test', async (req, res) => {
  const fakeEvent = {
    type: 'payment.completed',
    data: {
      id: 'test_session_id_12345',
      customer_email: 'test@example.com'
    }
  };

  const entries = await loadEntries();
  entries.push({
    id: fakeEvent.data.id,
    paymentStatus: 'paid',
    customerEmail: fakeEvent.data.customer_email,
    timestamp: new Date().toISOString()
  });
  await saveEntries(entries);

  console.log('✅ Test payment session injected.');
  res.send('✅ Webhook test injected');
});

const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), async (req, res) => {
  const { name, contest, triviaAnswers, timeTaken, session_id } = req.body;

  if (!session_id) return res.status(400).send('Missing payment session ID.');

  const entries = await loadEntries();
  const matched = entries.find(e => e.id === session_id && e.paymentStatus === 'paid');

  if (!matched) return res.status(403).send('Invalid or unpaid session.');
  if (matched.used) return res.status(409).send('This payment session has already been used.');

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

    const uploads = await loadUploads();
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

  const uploads = await loadUploads();
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
  console.log('🎯 Contest:', contest);

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Upload Successful</title>
    <style>body{font-family:Arial;text-align:center;margin-top:50px;background:#f0f8ff;color:#005b96;}</style>
    <script>setTimeout(()=>{window.location.href='/'},2000);</script>
    </head><body><h1>✅ Upload Successful!</h1><p>Redirecting to homepage...</p></body></html>
  `);
});

module.exports = router;
