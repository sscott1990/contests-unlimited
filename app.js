const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const AWS = require('aws-sdk');
const multer = require('multer');  // <-- Add multer for file uploads
const { v4: uuidv4 } = require('uuid'); // For UUID generation
const contestRoutes = require('./routes/contest');
const collectRoutes = require('./routes/collect');
require('dotenv').config();
const bcrypt = require('bcrypt'); // <-- Added for password hashing
const earningsRoutes = require('./routes/earnings');

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
const TRIVIA_KEY = 'trivia-contest.json'; // <--- default trivia
const CUSTOM_TRIVIA_KEY = 'custom-trivia.json'; // <--- NEW: custom trivia

// Serve static files
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

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

app.use('/api/admin', earningsRoutes);

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

// === 📦 Helpers for Trivia Sets ===
// Now trivia-contest.json is an ARRAY of contest objects (not an object/dict)
async function getTriviaSets() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: TRIVIA_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return []; // CHANGED: Array, not object
    throw err;
  }
}

async function saveTriviaSets(triviaSets) {
  await s3.putObject({
    Bucket: ENTRIES_BUCKET,
    Key: TRIVIA_KEY,
    Body: JSON.stringify(triviaSets, null, 2),
    ContentType: 'application/json',
  }).promise();
}

// === 📦 Helpers for Custom Trivia Sets (NEW) ===
async function getCustomTriviaSets() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: CUSTOM_TRIVIA_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

async function saveCustomTriviaSets(triviaSets) {
  await s3.putObject({
    Bucket: ENTRIES_BUCKET,
    Key: CUSTOM_TRIVIA_KEY,
    Body: JSON.stringify(triviaSets, null, 2),
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
    const { name, contestName, session_id, triviaAnswers } = req.body;  // changed contest -> contestName
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
      contestName,  // updated here
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

// === 🚩 Creator contest creation with password hashing, duration/seed/min logic, 
app.post('/api/creator/upload', upload.single('captionFile'), async (req, res) => {
  try {
    const {
      contestName,
      creator,
      email,
      description,
      creatorSessionId,
      prizeModel,
      password,
      durationMonths,
      triviaQuestions
    } = req.body;

    if (!creatorSessionId) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Missing password' });
    }

    // Check for existing submission with this sessionId
    const creators = await getCreators();
    const alreadySubmitted = creators.find(c => c.sessionId === creatorSessionId);
    if (alreadySubmitted) {
      return res.status(400).json({ error: 'Submission already exists for this session.' });
    }

    // Hash the password before storing
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Duration and endDate logic
    let duration = parseInt(durationMonths, 10);
    if (![1, 3, 6, 12].includes(duration)) duration = 1; // default 1 month
    const endDate = new Date(Date.now() + duration * 30 * 24 * 60 * 60 * 1000).toISOString();

    // Seed and min entries based on duration
    const seedMatrix = {
      1: { seed: 250, min: 50 },
      3: { seed: 500, min: 100 },
      6: { seed: 750, min: 150 },
      12: { seed: 1000, min: 200 }
    };
    const { seed: seedAmount, min: minEntries } = seedMatrix[duration];

    // Create slug from contest name + timestamp
    const slug = contestName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();

    // Handle file upload to S3 if file exists
    let fileUrl = null;
    if (req.file && req.file.buffer && req.file.originalname) {
      const s3Params = {
        Bucket: ENTRIES_BUCKET, // Your S3 bucket name (make sure this is set correctly)
        Key: `creator-files/${slug}-${req.file.originalname}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
   };
      const uploadResult = await s3.upload(s3Params).promise();
      fileUrl = uploadResult.Location;
    }

    // Save the new creator contest info
    creators.push({
      sessionId: creatorSessionId,
      contestTitle: contestName,
      creator,
      email,
      description,
      prizeModel,
      passwordHash,
      approved: false,
      timestamp: new Date().toISOString(),
      endDate,
      durationMonths: duration,
      seedAmount,
      minEntries,
      slug,
      fileUrl // Save S3 file URL if uploaded
    });

    await saveCreators(creators);

    // Save custom trivia if it's a Trivia Contest with questions provided
    if (contestName === "Trivia Contest" && triviaQuestions) {
      let triviaSets = await getCustomTriviaSets();
      let parsedQuestions = Array.isArray(triviaQuestions)
        ? triviaQuestions
        : JSON.parse(triviaQuestions);

      // Remove any existing trivia set with the same slug
      triviaSets = triviaSets.filter(c => c.slug !== slug);

      // Add new trivia set
      triviaSets.push({
        slug,
        questions: parsedQuestions
      });

      await saveCustomTriviaSets(triviaSets);
    }

    // Redirect to success page after submission
    res.redirect('/success-creator-submitted.html');
  } catch (err) {
    console.error('Creator submission error:', err);
    res.status(500).json({ error: 'Failed to submit creator info' });
  }
});

// === 🚪 Creator login ===
app.post('/api/creator-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const creators = await getCreators();
    const emailLower = email.toLowerCase();
    // Check email case-insensitively and require passwordHash
    const matchingCreators = creators.filter(
      c => (c.email || '').toLowerCase() === emailLower && c.passwordHash
    );

    let valid = false;
    for (const creator of matchingCreators) {
      if (await bcrypt.compare(password, creator.passwordHash)) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    res.json({
      message: 'Login successful',
      email: email // frontend should use this for dashboard fetch
    });
  } catch (err) {
    console.error('Creator login error:', err);
    res.status(500).json({ error: 'Login failed due to server error.' });
  }
});

// === ✅ List approved custom contests ===
// === ✅ List approved custom contests ===
app.get('/api/contests/approved', async (req, res) => {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: CREATORS_KEY
    }).promise();

    const creators = JSON.parse(data.Body.toString());
    const approved = creators.filter(c => c.status === 'approved');

    approved.sort((a, b) =>
      a.contestTitle.localeCompare(b.contestTitle)
    );
    
    // Return the full contest data including fileUrl
    res.json(approved.map(entry => ({
      name: `${entry.contestTitle} (hosted by ${entry.creator})`,
      slug: entry.slug,
      contestTitle: entry.contestTitle,
      creator: entry.creator,
      description: entry.description,
      fileUrl: entry.fileUrl, // This is the key field that was missing!
      endDate: entry.endDate,
      durationMonths: entry.durationMonths,
      seedAmount: entry.seedAmount,
      minEntries: entry.minEntries
    })));
  } catch (err) {
    console.error('Failed to load approved contests:', err);
    res.status(500).json({ error: 'Failed to load contests' });
  }
});

// === New: API to fetch contest info by slug (for countdown, etc.) ===
app.get('/api/contest/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const creators = await getCreators();
    const contest = creators.find(c => c.slug === slug);
    if (!contest) return res.status(404).json({ error: "Contest not found" });
    res.json({
      contestTitle: contest.contestTitle,
      creator: contest.creator,
      endDate: contest.endDate,
      slug: contest.slug
    });
  } catch (err) {
    console.error('Failed to fetch contest:', err);
    res.status(500).json({ error: 'Failed to fetch contest' });
  }
});

// === New: API to fetch trivia questions for a contest by slug (for defaults only) ===
app.get('/api/trivia/by-slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const triviaSets = await getTriviaSets();
    const found = triviaSets.find(c => c.slug === slug);
    if (!found) return res.status(404).json({ error: "Trivia not found" });
    res.json({ questions: found.questions });
  } catch (err) {
    console.error('Failed to fetch trivia for contest:', err);
    res.status(500).json({ error: 'Failed to fetch trivia for contest' });
  }
});

// === New: API to fetch custom trivia questions for a contest by slug ===
app.get('/api/custom-trivia/by-slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const triviaSets = await getCustomTriviaSets();
    const found = triviaSets.find(c => c.slug === slug);
    if (!found) return res.status(404).json({ error: "Trivia not found" });
    res.json({ questions: found.questions });
  } catch (err) {
    console.error('Failed to fetch custom trivia for contest:', err);
    res.status(500).json({ error: 'Failed to fetch custom trivia for contest' });
  }
});

// === New: API to fetch all contests for an email ===
app.get('/api/admin/creator-stats-by-email/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const creators = await getCreators();
    const matchingContests = creators.filter(
      c => (c.email || '').toLowerCase() === email
    );
    res.json(matchingContests);
  } catch (err) {
    console.error('Error fetching creator stats by email:', err);
    res.status(500).json({ error: 'Failed to fetch contests for this email.' });
  }
});

// === Creator Dashboard route ===
app.get('/creator-dashboard/:slug', async (req, res) => {
  try {
    const creators = await getCreators();
    const creator = creators.find(c => c.slug === req.params.slug);
    if (!creator) return res.status(404).send('Creator not found');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Dashboard - ${creator.contestTitle}</title>
        <meta charset="UTF-8">
      </head>
      <body>
        <h1>Dashboard for ${creator.creator}</h1>
        <p><strong>Contest:</strong> ${creator.contestTitle}</p>
        <p><strong>Email:</strong> ${creator.email}</p>
        <p><strong>Description:</strong> ${creator.description}</p>
        <p><strong>Status:</strong> ${creator.status || 'Pending'}</p>
        <p><strong>End Date:</strong> ${creator.endDate}</p>
        <!-- Add more dashboard features here -->
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Failed to render creator dashboard:', err);
    res.status(500).send('Failed to render creator dashboard.');
  }
});

// === 🔁 All other routes ===
const indexRoutes = require('./routes/index');
const adminRoutes = require('./routes/admin');
const triviaRoute = require('./routes/trivia');

app.use('/', indexRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trivia', triviaRoute);
app.use('/contest', contestRoutes);
app.use('/', collectRoutes);

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