require('dotenv').config(); // Load env vars early

const express = require('express');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');

const router = express.Router();

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'contests-unlimited';

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-2',
});

const s3 = new AWS.S3();

function loadEntries() {
  try {
    // Use absolute path for consistency, same as uploads.json
    const data = fs.readFileSync(path.join(__dirname, '..', 'entries.json'));
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function loadUploads() {
  try {
    const data = fs.readFileSync(path.join(__dirname, '..', 'uploads.json'));
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function formatTimestamp(ts) {
  if (!ts) return 'No Date';
  if (typeof ts === 'number') return new Date(ts).toLocaleString();
  const d = new Date(ts);
  return isNaN(d) ? 'Invalid Date' : d.toLocaleString();
}

// Basic Auth middleware (for demo purposes, use env vars in real life)
router.use((req, res, next) => {
  const auth = { login: 'admin', password: 'password' };

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && password && login === auth.login && password === auth.password) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Authentication required.');
});

// JSON view of Stripe entries
router.get('/entries', (req, res) => {
  const entries = loadEntries();
  res.json(entries);
});

// ✅ REVISED HTML view of uploaded files and trivia answers with signed S3 URLs
router.get('/uploads', (req, res) => {
  const uploads = loadUploads();

  const rows = uploads.map(entry => {
    const date = formatTimestamp(entry.timestamp);
    const isTrivia = Array.isArray(entry.triviaAnswers);

    if (isTrivia) {
      return `
        <tr>
          <td>${entry.userName}</td>
          <td>${entry.contestName}</td>
          <td>${date}</td>
          <td colspan="2">
            <strong>Trivia Answers:</strong>
            <pre>${JSON.stringify(entry.triviaAnswers, null, 2)}</pre>
            <strong>Time Taken:</strong> ${entry.timeTaken?.toFixed(3)} sec
          </td>
        </tr>`;
    } else {
      // Generate a signed URL valid for 15 minutes
      const signedUrl = s3.getSignedUrl('getObject', {
        Bucket: BUCKET_NAME,
        Key: entry.savedFilename,
        Expires: 900, // 15 minutes
      });

      return `
        <tr>
          <td>${entry.userName}</td>
          <td>${entry.contestName}</td>
          <td>${date}</td>
          <td>${entry.originalFilename}</td>
          <td><a href="${signedUrl}" target="_blank" rel="noopener noreferrer">View</a></td>
        </tr>`;
    }
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
      <h2>Uploaded Entries</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Contest</th>
            <th>Date</th>
            <th>Original Filename</th>
            <th>File / Answers</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

// ✅ Trivia results view (revised for sorting and time with milliseconds)
router.get('/trivia', (req, res) => {
  const uploads = loadUploads();

  const triviaData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trivia-contest.json'), 'utf8'));
  const correctAnswers = triviaData.map(q => q.answer);

  // Calculate score for each entry and sort
  const scored = uploads
    .filter(entry => Array.isArray(entry.triviaAnswers))
    .map(entry => {
      const score = entry.triviaAnswers.reduce((sum, answer, i) => {
        if (i >= correctAnswers.length) return sum;
        const userAns = String(answer.selected || '').trim().toLowerCase();
        const correctAns = String(correctAnswers[i]).trim().toLowerCase();
        return sum + (userAns === correctAns ? 1 : 0);
      }, 0);
      return { ...entry, score };
    })
    .sort((a, b) => {
      // Sort by score descending, then timeTaken ascending
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
