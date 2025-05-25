const express = require('express');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const router = express.Router();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function loadJSONFromS3(key) {
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: key }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.code === 'NotFound') {
      return [];
    }
    console.error(`Error loading ${key} from S3:`, err);
    throw err;
  }
}

async function loadEntries() {
  return loadJSONFromS3('entries.json');
}

async function loadUploads() {
  return loadJSONFromS3('uploads.json');
}

// Basic Auth middleware (for demo purposes, use env vars in real life)
router.use((req, res, next) => {
  const auth = {
    login: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD
  };

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && password && login === auth.login && password === auth.password) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Authentication required.');
});

// JSON view of Stripe entries
router.get('/entries', async (req, res) => {
  try {
    const entries = await loadEntries();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load entries' });
  }
});

// HTML view of uploaded files
router.get('/uploads', async (req, res) => {
  try {
    const uploads = await loadUploads();
    if (!uploads || uploads.length === 0) {
      return res.send('<h2>No uploads found</h2>');
    }

    const rows = uploads.map(upload => {
      const date = new Date(upload.timestamp).toLocaleString();
      return `
      <tr>
        <td>${upload.userName || ''}</td>
        <td>${upload.contestName || ''}</td>
        <td>${date}</td>
        <td>${upload.originalFilename || ''}</td>
        <td><a href="https://${BUCKET_NAME}.s3.amazonaws.com/${encodeURIComponent(upload.savedFilename)}" target="_blank">View</a><br>
            <img src="https://${BUCKET_NAME}.s3.amazonaws.com/${encodeURIComponent(upload.savedFilename)}" alt="${upload.originalFilename || ''}" style="max-width: 100px;"></td>    
      </tr>`;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Admin Uploads</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/styles.css">
      </head>
      <body>
        <h1>Admin Panel</h1>
        <nav>
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <h2>Uploaded Files</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Contest</th>
              <th>Date</th>
              <th>Original Filename</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to load uploads.');
  }
});

// ✅ Trivia results view (revised for score or correctCount-based entries)
router.get('/trivia', async (req, res) => {
  try {
    const uploads = await loadUploads();
    const triviaData = await loadJSONFromS3('trivia-contest.json');
    const correctAnswers = triviaData.map(q => q.answer);

    const scored = uploads
      .filter(entry =>
        (Array.isArray(entry.triviaAnswers) && entry.triviaAnswers.length > 0) ||
        (typeof entry.correctCount === 'number' && typeof entry.timeTaken === 'number')
      )
      .map(entry => {
        let score = 0;

        if (Array.isArray(entry.triviaAnswers)) {
          score = entry.triviaAnswers.reduce((sum, answer, i) => {
            if (i >= correctAnswers.length) return sum;
            const userAns = String(answer.selected || '').trim().toLowerCase();
            const correctAns = String(correctAnswers[i]).trim().toLowerCase();
            return sum + (userAns === correctAns ? 1 : 0);
          }, 0);
        } else if (typeof entry.correctCount === 'number') {
          score = entry.correctCount;
        }

        return { ...entry, score };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      });

    const rows = scored.map(entry => `
      <tr>
        <td>${entry.userName}</td>
        <td>${entry.contestName}</td>
        <td>${entry.score} / ${correctAnswers.length}</td>
        <td>${(entry.timeTaken).toFixed(3)} sec</td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Trivia Results</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/styles.css">
      </head>
      <body>
        <h1>Trivia Contest Submissions</h1>
        <nav>
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Contest</th>
              <th>Correct Answers</th>
              <th>Time Taken</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to load trivia results.');
  }
});

// Add logout route to clear Basic Auth cached credentials
router.get('/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Logged Out</title>
    </head>
    <body>
      <h1>You have been logged out.</h1>
      <p><a href="/api/admin/uploads">Log back in</a></p>
    </body>
    </html>
  `);
});

module.exports = router;
