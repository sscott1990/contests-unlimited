const express = require('express');
const AWS = require('aws-sdk');
const router = express.Router();
const { loadJSONFromS3 } = require('../utils/s3Utils'); // Adjust path as needed

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function loadEntries() {
  return loadJSONFromS3('entries.json');
}

async function loadUploads() {
  return loadJSONFromS3('uploads.json');
}

// Generate a pre-signed URL for an S3 object key (valid for 15 minutes)
function getPresignedUrl(key) {
  const params = { Bucket: BUCKET_NAME, Key: key, Expires: 900 };
  return s3.getSignedUrlPromise('getObject', params);
}

// Basic Auth middleware
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

    const uploadsWithPresignedUrls = await Promise.all(
      uploads.map(async (upload) => {
        if (!upload.fileUrl) return upload;
        const url = new URL(upload.fileUrl);
        const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;

        try {
          const presignedUrl = await getPresignedUrl(key);
          return { ...upload, presignedUrl };
        } catch (err) {
          console.error('Error generating presigned URL:', err);
          return { ...upload, presignedUrl: upload.fileUrl };
        }
      })
    );

    const rows = uploadsWithPresignedUrls.map(upload => {
      const date = new Date(upload.timestamp).toLocaleString();
      const filename = upload.fileUrl ? upload.fileUrl.split('/').pop() : '';
      const viewUrl = upload.presignedUrl || upload.fileUrl || '#';

      return `
      <tr>
        <td>${upload.name || ''}</td>
        <td>${upload.contest || ''}</td>
        <td>${date}</td>
        <td>${filename}</td>
        <td>
          <a href="${viewUrl}" target="_blank">View</a><br>
          <img src="${viewUrl}" alt="${filename}" style="max-width: 100px;">
        </td>
      </tr>`;
    }).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Admin Uploads</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 1rem; background: #f9f9f9; color: #333; }
          h1, h2 { color: #444; }
          nav a { margin-right: 1rem; text-decoration: none; color: #007bff; }
          nav a:hover { text-decoration: underline; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
          th { background: #eee; }
          img { max-width: 100px; border-radius: 4px; margin-top: 0.5rem; }
        </style>
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

// Trivia results view
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
        <td>${entry.name}</td>
        <td>${entry.contest}</td>
        <td>${entry.score} / ${correctAnswers.length}</td>
        <td>${typeof entry.timeTaken === 'number' ? entry.timeTaken.toFixed(3) + ' sec' : 'N/A'}</td>
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

// Logout route
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
