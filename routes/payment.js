console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'set' : 'missing');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'missing');


const express = require('express');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const multer = require('multer');
const AWS = require('aws-sdk');
const router = express.Router();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

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

// ✅ JSON file paths
const entriesFilePath = path.join(__dirname, '..', 'entries.json');
const uploadsFilePath = path.join(__dirname, '..', 'uploads.json');

function loadEntries() {
  try {
    const data = fs.readFileSync(entriesFilePath);
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function saveEntries(entries) {
  fs.writeFileSync(entriesFilePath, JSON.stringify(entries, null, 2));
}

function loadUploads() {
  try {
    const data = fs.readFileSync(uploadsFilePath);
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function saveUploads(uploads) {
  fs.writeFileSync(uploadsFilePath, JSON.stringify(uploads, null, 2));
}

// ✅ Stripe Checkout
router.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Contest Entry',
          },
          unit_amount: 500,
        },
        quantity: 1,
      }],
      success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel.html`,
    });
    console.log('Stripe session created:', session.id);
    res.json({ id: session.id });
  } catch (error) {
    console.error('Stripe create checkout session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Stripe Webhook
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const entries = loadEntries();
    entries.push({
      id: session.id,
      paymentStatus: session.payment_status,
      customerEmail: session.customer_details?.email || 'anonymous',
      timestamp: new Date().toISOString()
    });
    saveEntries(entries);
  }

  res.json({ received: true });
});

// ✅ Use memory storage for S3
const upload = multer({ storage: multer.memoryStorage() });

// ✅ Unified upload handler
router.post('/upload', upload.single('file'), async (req, res) => {
  const { name, contest, triviaAnswers, timeTaken, session_id } = req.body;

  if (!session_id) return res.status(400).send('Missing payment session ID.');

  const entries = loadEntries();
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

    const uploads = loadUploads();
    uploads.push({
      userName: name,
      contestName: contest,
      timestamp: new Date().toISOString(),
      triviaAnswers: parsedAnswers,
      timeTaken: Number(timeTaken)
    });
    saveUploads(uploads);

    matched.used = true;
    saveEntries(entries);

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

  const uploads = loadUploads();
  uploads.push({
    userName: name,
    contestName: contest,
    timestamp: new Date().toISOString(),
    originalFilename: file.originalname,
    savedFilename: s3Key,
  });
  saveUploads(uploads);

  matched.used = true;
  saveEntries(entries);

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
