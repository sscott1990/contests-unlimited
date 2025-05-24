const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

function loadEntries() {
  try {
    const data = fs.readFileSync('entries.json');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function loadUploads() {
  try {
    const data = fs.readFileSync('uploads.json');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
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

// HTML view of uploaded files
router.get('/uploads', (req, res) => {
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    return res.send('<h2>No uploads found</h2>');
  }

  const files = fs.readdirSync(uploadsDir);
  const rows = files.map(filename => {
    const match = filename.match(/^(.+?)_(.+?)_(\d+)_(.+)$/);
    if (!match) {
      return `<tr><td colspan="5">${filename} (invalid format)</td></tr>`;
    }

    const [, name, contest, timestamp, original] = match;
    const date = new Date(Number(timestamp)).toLocaleString();

    return `
      <tr>
        <td>${name}</td>
        <td>${contest}</td>
        <td>${date}</td>
        <td>${original}</td>
        <td><a href="/uploads/${encodeURIComponent(filename)}" target="_blank">View</a><br>
               <img src="/uploads/${encodeURIComponent(filename)}" alt="${original}" style="max-width: 100px;"></td>    
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
});

// ✅ Trivia results view (revised for sorting and time with milliseconds)
router.get('/trivia', (req, res) => {
  const uploads = loadUploads();

  const triviaData = JSON.parse(fs.readFileSync('trivia-contest.json', 'utf8'));
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
