const express = require('express');
const AWS = require('aws-sdk');
const router = express.Router();
const { loadJSONFromS3 } = require('../utils/s3Utils'); // Adjust path as needed
const slugify = require('slugify');

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

async function loadCreators() {
  return loadJSONFromS3('creator.json');
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

// HTML view of uploaded files with pagination
router.get('/uploads', async (req, res) => {
  try {
    const uploads = await loadUploads();
    if (!uploads || uploads.length === 0) {
      return res.send('<h2>No uploads found</h2>');
    }

    // Pagination logic
    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalUploads = uploads.length;
    const totalPages = Math.ceil(totalUploads / perPage);
    const start = (page - 1) * perPage;
    const paginatedUploads = uploads.slice(start, start + perPage);

    const uploadsWithPresignedUrls = await Promise.all(
      paginatedUploads.map(async (upload) => {
        if (!upload.fileUrl) return { ...upload, presignedUrl: null };

        let key;
        try {
          const url = new URL(upload.fileUrl);
          key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
        } catch (err) {
          console.warn('Invalid fileUrl:', upload.fileUrl);
          return { ...upload, presignedUrl: null };
        }

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
      const filename = upload.fileUrl ? upload.fileUrl.split('/').pop() : 'No file';
      const viewUrl = upload.presignedUrl;

      return `
        <tr>
          <td>${upload.name || ''}</td>
          <td>${upload.contestName || ''}</td>
          <td>${date}</td>
          <td>${filename}</td>
          <td>
            ${viewUrl
              ? `<a href="${viewUrl}" target="_blank">View</a><br>
                 <img src="${viewUrl}" alt="${filename}" style="max-width: 100px;">`
              : 'No file available'}
          </td>
        </tr>
      `;
    }).join('');

    // Pagination controls html
    let paginationControls = `<div style="margin-top: 1rem;">`;
    if (page > 1) {
      paginationControls += `<a href="?page=${page - 1}">Previous</a> `;
    }
    paginationControls += `Page ${page} of ${totalPages}`;
    if (page < totalPages) {
      paginationControls += ` <a href="?page=${page + 1}">Next</a>`;
    }
    paginationControls += `</div>`;

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
          div.pagination { margin-top: 1rem; }
        </style>
      </head>
      <body>
        <h1>Admin Panel</h1>
        <nav>
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
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
        ${paginationControls}
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

    // Updated logic to support correctCount fallback if triviaAnswers is missing
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
        <td>${entry.contestName}</td>
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
        <style>
          body { font-family: Arial, sans-serif; margin: 1rem; background: #f9f9f9; color: #333; }
          h1, h2 { color: #444; }
          nav a { margin-right: 1rem; text-decoration: none; color: #007bff; }
          nav a:hover { text-decoration: underline; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
          th { background: #eee; }
        </style>
      </head>
      <body>
        <h1>Trivia Contest Submissions</h1>
        <nav>
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
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
    console.error('Failed to load trivia submissions:', err);
    res.status(500).send('Failed to load trivia submissions.');
  }
});

// New route: Creators view with pagination
router.get('/creators', async (req, res) => {
  try {
    const creators = await loadCreators();

    if (!creators || creators.length === 0) {
      return res.send('<h2>No creator submissions found</h2>');
    }

    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalCreators = creators.length;
    const totalPages = Math.ceil(totalCreators / perPage);
    const start = (page - 1) * perPage;
    const paginatedCreators = creators.slice(start, start + perPage);

    const rows = paginatedCreators.map(creator => `
      <tr data-id="${creator.id || creator.timestamp}">
        <td>${creator.creator || ''}</td>
        <td>${creator.email || ''}</td>
        <td>${creator.contestTitle || ''}</td>
        <td>${creator.description || ''}</td>
        <td>${new Date(creator.timestamp).toLocaleString()}</td>
        <td>${creator.status || 'Pending'}</td>
        <td>
          ${creator.slug ? `<a href="/contest/${creator.slug}" target="_blank">Go to Contest</a>` : ''}
        </td>
        <td>
          <button onclick="handleStatus('${creator.id || creator.timestamp}', 'approved')">Approve</button>
          <button onclick="handleStatus('${creator.id || creator.timestamp}', 'rejected')">Reject</button>
        </td>
      </tr>
    `).join('');

    let paginationControls = `<div style="margin-top: 1rem;">`;
    if (page > 1) {
      paginationControls += `<a href="?page=${page - 1}">Previous</a> `;
    }
    paginationControls += `Page ${page} of ${totalPages}`;
    if (page < totalPages) {
      paginationControls += ` <a href="?page=${page + 1}">Next</a>`;
    }
    paginationControls += `</div>`;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Contest Creators</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: Arial, sans-serif; margin: 1rem; background: #f9f9f9; color: #333; }
          h1, h2 { color: #444; }
          nav a { margin-right: 1rem; text-decoration: none; color: #007bff; }
          nav a:hover { text-decoration: underline; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
          th { background: #eee; }
          div.pagination { margin-top: 1rem; }
        </style>
      </head>
      <body>
        <h1>Contest Creators</h1>
        <nav>
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Contest Name</th>
              <th>Description</th>
              <th>Submitted</th>
              <th>Status</th>
              <th>Link</th> <!-- new header for the contest link -->
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        ${paginationControls}
<script>
  async function handleStatus(id, status) {
    const response = await fetch('/api/admin/update-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id, status })
    });

    const result = await response.json();

    if (response.ok) {
      alert('Marked as ' + status);
      const row = document.querySelector('tr[data-id="' + id + '"]');
      row.style.backgroundColor = status === 'approved' ? '#d4edda' : '#f8d7da';

      if (status === 'approved' && result.slug) {
        // Add or update the link cell
        let linkCell = row.querySelector('td:nth-child(7)');
        if (linkCell) {
          linkCell.innerHTML = '<a href="/contest/' + result.slug + '" target="_blank">View Contest</a>';
        }
      } else {
        // Remove link if rejected
        let linkCell = row.querySelector('td:nth-child(7)');
        if (linkCell) {
          linkCell.innerHTML = '';
        }
      }

    } else {
      alert('Failed to update status.');
    }
  }
</script>
      </body>
      </html>
   `);
  } catch (err) {
    console.error('Failed to load creators:', err);
    res.status(500).send('Failed to load creators.');
  }
});

// --- ADDITION: Contest Stats Route for Creators ---
router.get('/creator-stats/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const uploads = await loadUploads();
    if (!uploads) return res.status(404).send('No entries found.');

    // Filter entries for this contest by slug
    const contestEntries = uploads.filter(entry => entry.contestName === slug);

    const numEntries = contestEntries.length;

    // Calculate prize pot as $2.50 per entry (site), and $1.00 per entry (creator's earnings)
    const prizePot = numEntries * 2.5;
    const creatorEarnings = numEntries * 1.0;

    // Optionally get the contest name/title from one of the entries
    const contestName = contestEntries[0]?.contestTitle || contestEntries[0]?.contestName || slug;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>${contestName} Stats</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: Arial, sans-serif; margin: 2rem; background: #f9f9f9; color: #333; }
          h1 { color: #444; }
          .stat { font-size: 1.2em; margin-bottom: 1em; }
        </style>
      </head>
      <body>
        <h1>Stats for "${contestName}"</h1>
        <div class="stat"><strong>Number of Entries:</strong> ${numEntries}</div>
        <div class="stat"><strong>Current Prize Pot:</strong> $${prizePot.toFixed(2)}</div>
        <div class="stat"><strong>Your Earnings So Far:</strong> $${creatorEarnings.toFixed(2)}</div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Failed to load contest stats:', err);
    res.status(500).send('Failed to load contest stats.');
  }
});
// --- END ADDITION ---

// Logout route
router.get('/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Logged out');
});

router.post('/update-status', express.json(), async (req, res) => {
  const { id, status } = req.body;

  if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });

  try {
    const creators = await loadCreators();
    const index = creators.findIndex(entry => entry.id === id || entry.timestamp === id);

    if (index === -1) return res.status(404).json({ error: 'Submission not found' });

    creators[index].status = status;

    let slug = null;
    if (status === 'approved') {
      // Generate slug from contest name + timestamp for uniqueness
      slug = slugify(`${creators[index].contestTitle}-${Date.now()}`, { lower: true, strict: true });
      creators[index].slug = slug;
    } else {
      // Remove slug if status changed from approved to something else
      delete creators[index].slug;
    }

    // Save back to S3
    const params = {
      Bucket: BUCKET_NAME,
      Key: 'creator.json',
      Body: JSON.stringify(creators, null, 2),
      ContentType: 'application/json',
    };

    await s3.putObject(params).promise();
    res.json({ success: true, slug });
  } catch (err) {
    console.error('Error updating creator status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;