const express = require('express');
const AWS = require('aws-sdk');
require('dotenv').config();

const router = express.Router();

const s3 = new AWS.S3();
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'contests-unlimited';
const DEMO_EXPIRATION_ENABLED = true;
const DEMO_EXPIRATION_MS = 1 * 60 * 60 * 1000; // 1 hour
const DEMO_EXPIRY_S3_KEY = 'demo_expiry.json';

// --- DEMO EXPIRY LOGIC ---
function getDemoExpiryFromS3(callback) {
  s3.getObject({
    Bucket: BUCKET_NAME,
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
    Bucket: BUCKET_NAME,
    Key: DEMO_EXPIRY_S3_KEY,
    Body: JSON.stringify({ expiresAt }),
    ContentType: 'application/json'
  }, (err) => {
    if (callback) callback();
  });
}

// --- DEMO AUTH & EXPIRY MIDDLEWARE ---
router.use((req, res, next) => {
  if (DEMO_EXPIRATION_ENABLED) {
    getDemoExpiryFromS3((expiresAt) => {
      const now = Date.now();
      if (!expiresAt) {
        const newExpiry = now + DEMO_EXPIRATION_MS;
        return setDemoExpiryInS3(newExpiry, () => runBasicAuth());
      } else if (now > expiresAt) {
        return res.status(403).send('Demo expired. Please contact the site owner for access.');
      } else {
        return runBasicAuth();
      }
    });
    return;
  }
  return runBasicAuth();

  function runBasicAuth() {
    const auth = {
      login: process.env.BASIC_AUTH_USER,
      password: process.env.BASIC_AUTH_PASS
    };
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === auth.login && password === auth.password) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="401"');
    res.status(401).send('Authentication required.');
  }
});

// --- DEMO PROTECTED ROUTES ---
router.get('/', (req, res) => {
  res.send(`<h1>Demo Home</h1><p>This is a demo-protected route. Demo auth and expiry are required.</p>`);
});

// Add more demo-protected routes here...

module.exports = router;