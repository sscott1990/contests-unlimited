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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

const DEMO_EXPIRATION_ENABLED = true;
const DEMO_EXPIRATION_MS = 1 * 60 * 60 * 1000; // 1 hour
const DEMO_EXPIRY_S3_KEY = 'demo_expiry.json';

function getDemoExpiryFromS3(callback) {
  s3.getObject({
    Bucket: ENTRIES_BUCKET,
    Key: DEMO_EXPIRY_S3_KEY
  }, (err, data) => {
    if (err) {
      if (err.code === 'NoSuchKey') return callback(null);
      return callback(null);
    }
    try {
      const json = JSON.parse(data.Body.toString('utf-8'));
      callback(json.expiresAt || null);
    } catch (e) {
      callback(null);
    }
  });
}

function setDemoExpiryInS3(expiresAt, callback) {
  s3.putObject({
    Bucket: ENTRIES_BUCKET,
    Key: DEMO_EXPIRY_S3_KEY,
    Body: JSON.stringify({ expiresAt }),
    ContentType: 'application/json'
  }, (err) => {
    if (callback) callback();
  });
}

function demoAuthAndExpiry(req, res, next) {
  // Bypass for /api/admin and its subroutes
  if (req.path.startsWith('/api/admin')) return next();

  // Bypass for /request-access.html and /request-access (GET and POST)
  if (
  req.path === '/request-access.html' ||
  req.path === '/request-access' ||
  req.path === '/api/request-access' ||
  req.path === '/api/payment/webhook'
) return next();

  if (DEMO_EXPIRATION_ENABLED) {
    getDemoExpiryFromS3((expiresAt) => {
      const now = Date.now();
      if (!expiresAt) {
        // No expiry set yet: require login, only set expiry on successful login
        return runBasicAuth((success) => {
          if (success) {
            const newExpiry = now + DEMO_EXPIRATION_MS;
            return setDemoExpiryInS3(newExpiry, () => next());
          }
          // If not successful, runBasicAuth handles response
        });
      } else if (now > expiresAt) {
        return res.status(403).send('Demo expired. Please contact the site owner for access.');
      } else {
        // Expiry valid, require login as usual
        return runBasicAuth((success) => {
          if (success) return next();
          // If not successful, runBasicAuth handles response
        });
      }
    });
    return;
  }
  // If expiration not enabled, just run basic auth
  return runBasicAuth((success) => {
    if (success) return next();
    // If not successful, runBasicAuth handles response
  });

  function runBasicAuth(callback) {
    const auth = {
      login: process.env.BASIC_AUTH_USER,
      password: process.env.BASIC_AUTH_PASS
    };
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === auth.login && password === auth.password) {
      return callback(true);
    }
    res.set('WWW-Authenticate', 'Basic realm="401"');
    res.status(401).send('Authentication required.');
    return callback(false);
  }
}
app.use(demoAuthAndExpiry);

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
async function getTriviaSets() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: TRIVIA_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
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

// === Helper for Presigned S3 URLs ===
async function getPresignedUrlFromFileUrl(fileUrl) {
  if (!fileUrl) return null;
  try {
    const url = new URL(fileUrl);
    const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    return await s3.getSignedUrlPromise('getObject', {
      Bucket: ENTRIES_BUCKET,
      Key: key,
      Expires: 900 // 15 minutes
    });
  } catch (e) {
    console.warn('Could not parse key for signed URL:', fileUrl, e);
    return null;
  }
}

// === 🚩 Request Access Form (GET and POST) ===
app.get('/request-access', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Request Demo Access</title>
      <meta charset="UTF-8">
    </head>
    <body>
      <h1>Request Demo Access</h1>
      <form action="/api/request-access" method="POST">
        <label for="name">Name:</label><br>
        <input type="text" id="name" name="name" required><br>
        <label for="email">Email:</label><br>
        <input type="email" id="email" name="email" required><br>
        <label for="reason">Reason for Access (optional):</label><br>
        <textarea id="reason" name="reason"></textarea><br>
        <button type="submit">Request Access</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/api/request-access', async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email) {
      return res.status(400).send('Name and email are required.');
    }

    // Create a unique filename for each request
    const filename = `request-access/${Date.now()}_${Math.random().toString(36).substr(2, 8)}.json`;

    const item = {
      name,
      email,
      reason: reason || "",
      timestamp: new Date().toISOString()
    };

    await s3.putObject({
      Bucket: ENTRIES_BUCKET,
      Key: filename,
      Body: JSON.stringify(item, null, 2),
      ContentType: 'application/json'
    }).promise();

    res.send(`
      <h2>Thank you for your request!</h2>
      <p>We have received your request for demo access. You will receive an email soon if approved.</p>
      <a href="/">Back to Home</a>
    `);
  } catch (err) {
    console.error('Failed to handle request access:', err);
    res.status(500).send('Failed to process your request');
  }
});

// === ADD THIS: API for default caption contest, with signed image URL ===
app.get('/api/caption-contest', async (req, res) => {
  try {
    // Fetch the JSON metadata from S3
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: 'caption-contest.json'
    }).promise();
    const json = JSON.parse(data.Body.toString('utf-8'));

    // If the image is an S3 key (not a full URL), generate a signed URL
    let imageUrl = json.image;
    if (imageUrl && !/^https?:\/\//.test(imageUrl)) {
      // Remove leading slash if present
      const key = imageUrl.replace(/^\//, '');
      imageUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: ENTRIES_BUCKET,
        Key: key,
        Expires: 900 // 15 minutes
      });
    }

    res.json({
      ...json,
      image: imageUrl
    });
  } catch (err) {
    if (err.code === 'NoSuchKey') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: 'Failed to fetch caption contest' });
  }
});

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
      const billingAddress = webhookData.event_body.billing_address || {};
      const userState = (billingAddress.state || '').toUpperCase();
      const RESTRICTED_STATES = ['NY', 'WA', 'NJ', 'PR', 'GU', 'AS', 'VI', 'MP', 'RI', 'FL', 'AZ'];

      // 🚩 Block or disqualify restricted state entries
      if (RESTRICTED_STATES.includes(userState)) {
        console.warn(`Blocked/disqualified entry from restricted state: ${userState} (sessionId: ${sessionId})`);
        // Option 1: Don't save the entry at all (just return OK for webhook)
        // return res.status(200).send('Entry from restricted state blocked');

        // Option 2: Save but mark as disqualified for audit trail
        const paymentRecord = {
          sessionId,
          amount: webhookData.event_body.action.amount,
          status: 'disqualified',
          restrictedReason: `Entry from restricted state: ${userState}`,
          timestamp: new Date().toISOString(),
          customerEmail: billingAddress?.email || null,
          billingAddress: billingAddress,
          shippingAddress: webhookData.event_body.shipping_address || {},
        };
        const entries = await getEntries();
        entries.push(paymentRecord);
        await saveEntries(entries);
        return res.status(200).send('Entry from restricted state recorded as disqualified');
      }

      // Normal entry creation for allowed states
      const paymentRecord = {
        sessionId,
        amount: webhookData.event_body.action.amount,
        status: webhookData.event_body.action.success === "1" ? 'success' : 'failed',
        timestamp: new Date().toISOString(),
        customerEmail: billingAddress?.email || null,
        billingAddress: billingAddress,
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
    let { name, email, contestName, session_id, triviaAnswers } = req.body;
    if (Array.isArray(contestName)) contestName = contestName[0];

    let { timeTaken } = req.body;
    const file = req.file;

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    timeTaken = parseFloat(timeTaken);
    if (isNaN(timeTaken)) timeTaken = null;

    let fileUrl = null;
    let captionText = null;
    let fileContent = null; // <-- add this line
    let contestImageUrl = null;

    // Save caption as a .txt file in S3 for caption contests (robust)
    if (
      contestName &&
      contestName.startsWith('caption-contest-') &&
      contestName !== 'caption-contest-default' &&
      file &&
      file.mimetype === 'text/plain'
    ) {
      // Upload the caption as a .txt file to S3
      const s3Key = `uploads/${session_id}/${Date.now()}_caption.txt`;
      await s3.putObject({
        Bucket: ENTRIES_BUCKET,
        Key: s3Key,
        Body: file.buffer,
        ContentType: 'text/plain',
      }).promise();
      fileUrl = `https://${ENTRIES_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
      captionText = file.buffer.toString('utf-8');
      fileContent = captionText; // <-- add this line
      // Get contest image from the creators list
      const creators = await getCreators();
      const contest = creators.find(c => c.slug === contestName);
      if (contest && contest.fileUrl) {
        contestImageUrl = contest.fileUrl;
      }
    } else if (file) {
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
      email,
      contestName,
      fileUrl,
      triviaAnswers: triviaAnswers ? JSON.parse(triviaAnswers) : null,
      timeTaken,
      timestamp: new Date().toISOString(),
      captionText,
      fileContent, // <-- add this line
      contestImageUrl,
    });

    await saveUploads(uploads);

    // PATCH: Also update entries.json with contestName (if present)
    const entries = await getEntries();
    const entryIndex = entries.findIndex(e => e.sessionId === session_id);
    if (entryIndex !== -1) {
      entries[entryIndex].contestName = contestName;
      await saveEntries(entries);
    }

    res.redirect('/success-submitted.html');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// === 🚩 Creator contest creation with address collection, password hashing, duration/seed/min logic, 
app.post('/api/creator/upload', upload.single('captionFile'), async (req, res) => {
  try {
    const {
      contestName,
      creator,
      email,
      theme,
      description,
      creatorSessionId,
      prizeModel,
      password,
      durationMonths,
      triviaQuestions,
      address,
      city,
      state,
      zipcode
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
    let uploadedFileName = null;
    if (req.file && req.file.buffer && req.file.originalname) {
      uploadedFileName = req.file.originalname;
      const s3Params = {
        Bucket: ENTRIES_BUCKET,
        Key: `creator-files/${slug}-${uploadedFileName}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };
      const uploadResult = await s3.upload(s3Params).promise();
      fileUrl = uploadResult.Location;
      // Log for debugging
      console.log('Uploading file to S3 key:', s3Params.Key);
      console.log('File will be accessible at:', fileUrl);
    }

    // Save the new creator contest info, now including address fields
    creators.push({
      sessionId: creatorSessionId,
      contestTitle: contestName,
      creator,
      email,
      address,     // <-- new
      city,        // <-- new
      state,       // <-- new
      zipcode,
      theme,     // <-- new
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
    res.json(approved.map(entry => ({
      name: `${entry.contestTitle} (hosted by ${entry.creator})`,
      slug: entry.slug,
      endDate: entry.endDate
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

    // If there's a fileUrl, convert it to a signed url
    let signedFileUrl = null;
    if (contest.fileUrl) {
      signedFileUrl = await getPresignedUrlFromFileUrl(contest.fileUrl);
    }

    res.json({
      contestTitle: contest.contestTitle,
      creator: contest.creator,
      endDate: contest.endDate,
      slug: contest.slug,
      fileUrl: signedFileUrl, // <<--- SIGNED URL HERE!
      theme: contest.theme || "",
      description: contest.description || "",
      status: contest.status || "",
      // add other fields if needed
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

// === Admin: Generate a presigned URL for any S3 file (for creator file/image viewing) ===
app.get('/api/admin/creator-file', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "Missing key" });
  try {
    // Use AWS SDK v2 (you are using v2 now)
    const url = await s3.getSignedUrlPromise('getObject', {
      Bucket: ENTRIES_BUCKET,
      Key: key,
      Expires: 300, // 5 minutes
    });
    res.json({ url });
  } catch (e) {
    console.error("Failed to get signed url", e);
    res.status(500).json({ error: "Failed to get signed url" });
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

// === API Gallery Route: Strict Filtering (for frontend JS fetching) ===
app.get('/api/gallery', async (req, res) => {
  try {
    const uploads = await getUploads();
    const creators = await getCreators();
    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    // --- Platform contest logic for default expiration ---
    const PLATFORM_SLUG_MAP = {
      "art-contest-default": "Art Contest",
      "Art Contest": "Art Contest",
      "photo-contest-default": "Photo Contest",
      "Photo Contest": "Photo Contest",
      "trivia-contest-default": "Trivia Contest",
      "Trivia Contest": "Trivia Contest",
      "caption-contest-default": "Caption Contest",
      "Caption Contest": "Caption Contest"
    };
    const DEFAULT_CONTEST_START = new Date('2025-05-30T14:00:00Z');
    const DEFAULT_CONTEST_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
    const DEFAULT_CONTEST_END = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;

    // Attach host (creator) to each upload
    const uploadsWithHost = uploads.map(u => {
      const creatorMatch = creators.find(c =>
        (c.slug && u.contestName === c.slug) ||
        (c.contestTitle && u.contestName && c.contestTitle.toLowerCase() === u.contestName.toLowerCase())
      );
      return {
        ...u,
        host: creatorMatch && creatorMatch.creator ? creatorMatch.creator : "Contests Unlimited"
      };
    });

    // Group uploads by contest key
    const contestUploadsMap = {};
    uploadsWithHost.forEach(u => {
      if (!u.contestName) return;
      const key = u.contestName.toLowerCase();
      if (!contestUploadsMap[key]) contestUploadsMap[key] = [];
      contestUploadsMap[key].push(u);
    });

    // Collect all contest keys in creators
    const creatorKeys = new Set();
    creators.forEach(c => {
      if (c.slug) creatorKeys.add(c.slug.toLowerCase());
      if (c.contestTitle) creatorKeys.add(c.contestTitle.toLowerCase());
    });

    // Filter: Active = show all, Expired <30d = only winners, Expired >30d = none
    let filteredUploadsFinal = [];
    creators.forEach(creator => {
      const contestKeys = [];
      if (creator.slug) contestKeys.push(creator.slug.toLowerCase());
      if (creator.contestTitle) contestKeys.push(creator.contestTitle.toLowerCase());

      let contestUploads = [];
      contestKeys.forEach(key => {
        if (contestUploadsMap[key]) contestUploads = contestUploads.concat(contestUploadsMap[key]);
      });
      if (!contestUploads.length) return;

      const contestEnd = new Date(creator.endDate).getTime();
      const expired = now > contestEnd;
      const within30Days = now - contestEnd < 30 * MS_PER_DAY;

      if (!expired) {
        filteredUploadsFinal.push(...contestUploads);
      } else if (within30Days) {
        const winners = contestUploads.filter(u => u.isWinner === true);
        if (winners.length) filteredUploadsFinal.push(...winners);
      }
    });

    // === ADD: Include default/unknown contests (not in creators.json) and match expiration logic ===
    const orphanUploads = uploadsWithHost.filter(u => {
      if (
        u.contestName &&
        !creatorKeys.has(u.contestName.toLowerCase()) &&
        PLATFORM_SLUG_MAP[u.contestName]
      ) {
        // Platform default contest. Check if expired.
        if (now > DEFAULT_CONTEST_END) {
          // Expired > 30d ago: hide all uploads
          if (now - DEFAULT_CONTEST_END >= 30 * MS_PER_DAY) {
            return false; // hide
          }
          // Expired within 30d: show only winners
          return u.isWinner === true;
        }
        // Not expired: show all
        return true;
      }
      // Not a platform contest, not an orphan, or not in platform map
      return false;
    });
    filteredUploadsFinal.push(...orphanUploads);

    // --- SEARCH LOGIC ---
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredUploads = filteredUploadsFinal;
    if (search) {
      filteredUploads = filteredUploads.filter(u =>
        (u.contestName || '').toLowerCase().includes(search) ||
        (u.name || '').toLowerCase().includes(search) ||
        (u.host || '').toLowerCase().includes(search)
      );
    }

    // --- Winners in last 30 days, sorted newest first ---
    // REVISED: Use contest endDate instead of upload timestamp!
    const winners = filteredUploads.filter(u => {
      if (u.isWinner === true) {
        const contest = creators.find(c =>
          (c.slug && u.contestName === c.slug) ||
          (c.contestTitle && u.contestName === c.contestTitle)
        );
        const contestEnd = contest ? new Date(contest.endDate).getTime() : null;
        return contestEnd && (now - contestEnd < 30 * MS_PER_DAY);
      }
      return false;
    }).sort((a, b) => {
      const contestA = creators.find(c =>
        (c.slug && a.contestName === c.slug) ||
        (c.contestTitle && a.contestName === c.contestTitle)
      );
      const contestB = creators.find(c =>
        (c.slug && b.contestName === c.slug) ||
        (c.contestTitle && b.contestName === c.contestTitle)
      );
      const endA = contestA ? new Date(contestA.endDate).getTime() : new Date(a.timestamp).getTime();
      const endB = contestB ? new Date(contestB.endDate).getTime() : new Date(b.timestamp).getTime();
      return endB - endA;
    });

    const winnerSessionIds = new Set(winners.map(w => w.sessionId));
    let regularUploads = filteredUploads.filter(u => !winnerSessionIds.has(u.sessionId));

    // --- Pagination ---
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = 25;
    const totalUploads = regularUploads.length;
    const totalPages = Math.ceil(totalUploads / perPage);
    const start = (page - 1) * perPage;
    const paginatedUploads = regularUploads.slice(start, start + perPage);

    // --- Combine winners (always at top) + paginated regular uploads ---
    const uploadsToShow = [...winners, ...paginatedUploads];

    // --- S3 helpers ---
    const getPresignedUrl = async (key) =>
      await s3.getSignedUrlPromise('getObject', {
        Bucket: ENTRIES_BUCKET,
        Key: key,
        Expires: 900,
      });

    const getTextFileContents = async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.text();
      } catch {
        return null;
      }
    };

    const isTextFile = (filename) => filename && /\.(txt|md|csv|json)$/i.test(filename);
    const isImageFile = (filename) => filename && /\.(jpe?g|png|gif|webp)$/i.test(filename);

    // Compose API JSON with presigned URLs & captions
    const uploadsWithDetails = await Promise.all(
      uploadsToShow.map(async (upload) => {
        let presignedUrl = null;
        let filename = null;
        let fileContent = null;
        let contestImageUrl = null;
        let captionText = null;
        let isImageFileFlag = false;

        if (upload.fileUrl) {
          try {
            const url = new URL(upload.fileUrl);
            const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
            filename = url.pathname.split('/').pop();
            presignedUrl = await getPresignedUrl(key);
            isImageFileFlag = isImageFile(filename);
            if (isTextFile(filename)) {
              fileContent = await getTextFileContents(presignedUrl);
            }
          } catch (e) {
            presignedUrl = upload.fileUrl;
          }
        }

        // Find contest info for custom contests
        const creatorContest = creators.find(c =>
          (c.slug && upload.contestName === c.slug) ||
          (c.contestTitle && upload.contestName === c.contestTitle)
        );

        // Default Caption Contest
        if (
          upload.contestName === 'caption-contest-default' &&
          upload.fileUrl && isTextFile(filename)
        ) {
          try {
            const data = await s3.getObject({
              Bucket: ENTRIES_BUCKET,
              Key: 'caption-contest.json'
            }).promise();
            const json = JSON.parse(data.Body.toString('utf-8'));
            let imageUrl = json.image;
            if (imageUrl && !/^https?:\/\//.test(imageUrl)) {
              const key = imageUrl.replace(/^\//, '');
              contestImageUrl = await getPresignedUrl(key);
            } else {
              contestImageUrl = imageUrl;
            }
          } catch (e) {
            contestImageUrl = null;
          }
          captionText = fileContent;
        }
        // Custom Caption Contest
        else if (
          creatorContest &&
          creatorContest.fileUrl &&
          upload.contestName &&
          upload.contestName.startsWith('caption-contest-') &&
          upload.contestName !== 'caption-contest-default'
        ) {
          try {
            const url = new URL(creatorContest.fileUrl);
            const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
            contestImageUrl = await getPresignedUrl(key);
          } catch (e) {
            contestImageUrl = creatorContest.fileUrl;
          }
          if (fileContent) captionText = fileContent;
        } else if (isImageFileFlag) {
          contestImageUrl = presignedUrl;
        }

        let host = upload.host || "Contests Unlimited";

        // Always include geminiScore if present (for gallery display)
        return {
          ...upload,
          presignedUrl,
          filename,
          fileContent,
          contestImageUrl,
          captionText,
          isImageFile: isImageFileFlag,
          host,
          geminiScore: upload.geminiScore || null
        };
      })
    );

    res.json({
      uploads: uploadsWithDetails,
      page,
      perPage,
      totalPages,
      totalUploads
    });
  } catch (err) {
    console.error('Failed to load gallery API:', err);
    res.status(500).json({ error: 'Failed to load gallery.' });
  }
});

// === Gallery SSR Route (for direct browser page load) ===
app.get('/gallery', async (req, res) => {
  try {
    const uploads = await getUploads();
    const creators = await getCreators();
    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    // --- Platform contest logic for default expiration ---
    const PLATFORM_SLUG_MAP = {
      "art-contest-default": "Art Contest",
      "Art Contest": "Art Contest",
      "photo-contest-default": "Photo Contest",
      "Photo Contest": "Photo Contest",
      "trivia-contest-default": "Trivia Contest",
      "Trivia Contest": "Trivia Contest",
      "caption-contest-default": "Caption Contest",
      "Caption Contest": "Caption Contest"
    };
    const DEFAULT_CONTEST_START = new Date('2025-05-30T14:00:00Z');
    const DEFAULT_CONTEST_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
    const DEFAULT_CONTEST_END = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;

    // Attach host (creator) to each upload
    const uploadsWithHost = uploads.map(u => {
      const creatorMatch = creators.find(c =>
        (c.slug && u.contestName === c.slug) ||
        (c.contestTitle && u.contestName && c.contestTitle.toLowerCase() === u.contestName.toLowerCase())
      );
      return {
        ...u,
        host: creatorMatch && creatorMatch.creator ? creatorMatch.creator : "Contests Unlimited"
      };
    });

    // Group uploads by contest key
    const contestUploadsMap = {};
    uploadsWithHost.forEach(u => {
      if (!u.contestName) return;
      const key = u.contestName.toLowerCase();
      if (!contestUploadsMap[key]) contestUploadsMap[key] = [];
      contestUploadsMap[key].push(u);
    });

    // Collect all contest keys in creators
    const creatorKeys = new Set();
    creators.forEach(c => {
      if (c.slug) creatorKeys.add(c.slug.toLowerCase());
      if (c.contestTitle) creatorKeys.add(c.contestTitle.toLowerCase());
    });

    // Filter: Active = show all, Expired <30d = only winners, Expired >30d = none
    let filteredUploadsFinal = [];
    creators.forEach(creator => {
      const contestKeys = [];
      if (creator.slug) contestKeys.push(creator.slug.toLowerCase());
      if (creator.contestTitle) contestKeys.push(creator.contestTitle.toLowerCase());

      let contestUploads = [];
      contestKeys.forEach(key => {
        if (contestUploadsMap[key]) contestUploads = contestUploads.concat(contestUploadsMap[key]);
      });
      if (!contestUploads.length) return;

      const contestEnd = new Date(creator.endDate).getTime();
      const expired = now > contestEnd;
      const within30Days = now - contestEnd < 30 * MS_PER_DAY;

      if (!expired) {
        filteredUploadsFinal.push(...contestUploads);
      } else if (within30Days) {
        const winners = contestUploads.filter(u => u.isWinner === true);
        if (winners.length) filteredUploadsFinal.push(...winners);
      }
    });

    // === ADD: Include default/unknown contests (not in creators.json) and match expiration logic ===
    const orphanUploads = uploadsWithHost.filter(u => {
      if (
        u.contestName &&
        !creatorKeys.has(u.contestName.toLowerCase()) &&
        PLATFORM_SLUG_MAP[u.contestName]
      ) {
        // Platform default contest. Check if expired.
        if (now > DEFAULT_CONTEST_END) {
          // Expired > 30d ago: hide all uploads
          if (now - DEFAULT_CONTEST_END >= 30 * MS_PER_DAY) {
            return false; // hide
          }
          // Expired within 30d: show only winners
          return u.isWinner === true;
        }
        // Not expired: show all
        return true;
      }
      // Not a platform contest, not an orphan, or not in platform map
      return false;
    });
    filteredUploadsFinal.push(...orphanUploads);

    // --- SEARCH LOGIC ---
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredUploads = filteredUploadsFinal;
    if (search) {
      filteredUploads = filteredUploads.filter(u =>
        (u.contestName || '').toLowerCase().includes(search) ||
        (u.name || '').toLowerCase().includes(search) ||
        (u.host || '').toLowerCase().includes(search)
      );
    }

    // --- Winners in last 30 days, sorted newest first ---
    // REVISED: Use contest endDate instead of upload timestamp!
    const winners = filteredUploads.filter(u => {
      if (u.isWinner === true) {
        const contest = creators.find(c =>
          (c.slug && u.contestName === c.slug) ||
          (c.contestTitle && u.contestName === c.contestTitle)
        );
        const contestEnd = contest ? new Date(contest.endDate).getTime() : null;
        return contestEnd && (now - contestEnd < 30 * MS_PER_DAY);
      }
      return false;
    }).sort((a, b) => {
      const contestA = creators.find(c =>
        (c.slug && a.contestName === c.slug) ||
        (c.contestTitle && a.contestName === c.contestTitle)
      );
      const contestB = creators.find(c =>
        (c.slug && b.contestName === c.slug) ||
        (c.contestTitle && b.contestName === c.contestTitle)
      );
      const endA = contestA ? new Date(contestA.endDate).getTime() : new Date(a.timestamp).getTime();
      const endB = contestB ? new Date(contestB.endDate).getTime() : new Date(b.timestamp).getTime();
      return endB - endA;
    });

    const winnerSessionIds = new Set(winners.map(w => w.sessionId));
    let regularUploads = filteredUploads.filter(u => !winnerSessionIds.has(u.sessionId));

    // --- Pagination ---
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = 25;
    const totalUploads = regularUploads.length;
    const totalPages = Math.ceil(totalUploads / perPage);
    const start = (page - 1) * perPage;
    const paginatedUploads = regularUploads.slice(start, start + perPage);

    // --- Combine winners (always at top) + paginated regular uploads ---
    const uploadsToShow = [...winners, ...paginatedUploads];

    // S3 helpers
    const getPresignedUrl = async (key) =>
      await s3.getSignedUrlPromise('getObject', {
        Bucket: ENTRIES_BUCKET,
        Key: key,
        Expires: 900,
      });

    const getTextFileContents = async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.text();
      } catch {
        return null;
      }
    };

    const isTextFile = (filename) => filename && /\.(txt|md|csv|json)$/i.test(filename);
    const isImageFile = (filename) => filename && /\.(jpe?g|png|gif|webp)$/i.test(filename);

    // Map uploads to include presigned/image/caption
    const uploadsWithDetails = await Promise.all(
      uploadsToShow.map(async (upload) => {
        let presignedUrl = null;
        let filename = null;
        let fileContent = null;
        let contestImageUrl = null;
        let captionText = null;
        let isImageFileFlag = false;

        if (upload.fileUrl) {
          try {
            const url = new URL(upload.fileUrl);
            const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
            filename = url.pathname.split('/').pop();
            presignedUrl = await getPresignedUrl(key);
            isImageFileFlag = isImageFile(filename);
            if (isTextFile(filename)) {
              fileContent = await getTextFileContents(presignedUrl);
            }
          } catch (e) {
            presignedUrl = upload.fileUrl;
          }
        }

        // Find contest info for custom contests
        const creatorContest = creators.find(c =>
          (c.slug && upload.contestName === c.slug) ||
          (c.contestTitle && upload.contestName === c.contestTitle)
        );

        // Default Caption Contest
        if (
          upload.contestName === 'caption-contest-default' &&
          upload.fileUrl && isTextFile(filename)
        ) {
          try {
            const data = await s3.getObject({
              Bucket: ENTRIES_BUCKET,
              Key: 'caption-contest.json'
            }).promise();
            const json = JSON.parse(data.Body.toString('utf-8'));
            let imageUrl = json.image;
            if (imageUrl && !/^https?:\/\//.test(imageUrl)) {
              const key = imageUrl.replace(/^\//, '');
              contestImageUrl = await getPresignedUrl(key);
            } else {
              contestImageUrl = imageUrl;
            }
          } catch (e) {
            contestImageUrl = null;
          }
          captionText = fileContent;
        }
        // Custom Caption Contest
        else if (
          creatorContest &&
          creatorContest.fileUrl &&
          upload.contestName &&
          upload.contestName.startsWith('caption-contest-') &&
          upload.contestName !== 'caption-contest-default'
        ) {
          try {
            const url = new URL(creatorContest.fileUrl);
            const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
            contestImageUrl = await getPresignedUrl(key);
          } catch (e) {
            contestImageUrl = creatorContest.fileUrl;
          }
          if (fileContent) captionText = fileContent;
        } else if (isImageFileFlag) {
          contestImageUrl = presignedUrl;
        }

        let host = upload.host || "Contests Unlimited";

        // Always include geminiScore if present (for gallery display)
        return {
          ...upload,
          presignedUrl,
          filename,
          fileContent,
          contestImageUrl,
          captionText,
          isImageFile: isImageFileFlag,
          host,
          geminiScore: upload.geminiScore || null
        };
      })
    );

    // Render gallery EJS template (views/gallery.ejs)
    res.render('gallery', {
      uploads: uploadsWithDetails,
      page,
      totalPages,
      search
    });
  } catch (err) {
    console.error('Failed to load gallery:', err);
    res.status(500).send('Failed to load gallery.');
  }
});

// === 🚦 Proxy test route ===
app.get('/test-proxy', async (req, res) => {
  try {
    // Use fetch or axios; fetch uses proxy if env vars are set
    const response = await fetch('https://httpbin.org/ip');
    const data = await response.json();
    res.json(data); // Should show your EC2 proxy's public IP if proxy is working
  } catch (err) {
    console.error('Proxy test error:', err);
    res.status(500).json({ error: 'Proxy test failed' });
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

// === 🚩 Disqualify upload API ===
app.post('/api/admin/disqualify-upload', async (req, res) => {
  try {
    const { sessionId, contestName } = req.body;
    if (!sessionId || !contestName) {
      return res.status(400).json({ success: false, error: 'Missing sessionId or contestName.' });
    }
    const uploads = await getUploads();
    const idx = uploads.findIndex(
      u => u.sessionId === sessionId && u.contestName === contestName
    );
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Upload not found.' });
    }
    uploads[idx].isDisqualified = true;
    await saveUploads(uploads);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to disqualify upload:', err);
    res.status(500).json({ success: false, error: 'Failed to disqualify upload.' });
  }
});

// === 🚀 Start server ===
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('EPD webhook secret loaded:', !!process.env.EPD_WEBHOOK_SECRET);
});