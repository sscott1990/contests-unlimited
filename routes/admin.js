const express = require('express');
const AWS = require('aws-sdk');
const router = express.Router();
const { loadJSONFromS3 } = require('../utils/s3Utils');
const slugify = require('slugify');
const fetch = require('node-fetch'); // For text file preview
const cron = require('node-cron');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// === File type helpers ===
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
function isImageFile(filename) {
  if (!filename) return false;
  let ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.includes(`.${ext}`);
}
function isTextFile(filename) {
  if (!filename) return false;
  return filename.toLowerCase().endsWith('.txt');
}
async function getTextFileContents(presignedUrl) {
  try {
    const res = await fetch(presignedUrl);
    if (res.ok) {
      return await res.text();
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function loadEntries() {
  return loadJSONFromS3('entries.json');
}

async function loadUploads() {
  return loadJSONFromS3('uploads.json');
}

async function loadCreators() {
  return loadJSONFromS3('creator.json');
}

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
router.get('/entries-view', async (req, res) => {
  try {
    const RESTRICTED_STATES = ['NY', 'WA', 'NJ', 'PR', 'GU', 'AS', 'VI', 'MP', 'RI', 'FL', 'AZ']; // Add this line
    const entries = await loadEntries();
    const creators = await loadCreators();
    const uploads = await loadUploads();

    if (!entries || entries.length === 0) {
      return res.send('<h2>No entries found</h2>');
    }

    // --- SEARCH LOGIC ---
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredEntries = entries;
    if (search) {
      filteredEntries = entries.filter(entry => {
        const name = `${entry.billingAddress?.first_name || ''} ${entry.billingAddress?.last_name || ''}`.trim();
        const email = entry.customerEmail || entry.billingAddress?.email || '';
        const address = [
          entry.billingAddress?.address_1 || '',
          entry.billingAddress?.address_2 || '',
          entry.billingAddress?.city || '',
          entry.billingAddress?.state || '',
          entry.billingAddress?.postal_code || '',
          entry.billingAddress?.country || ''
        ].filter(Boolean).join(', ');
        const contest = entry.contestName || '';
        return (
          contest.toLowerCase().includes(search) ||
          name.toLowerCase().includes(search) ||
          email.toLowerCase().includes(search) ||
          address.toLowerCase().includes(search) ||
          (creators && creators.find(c =>
            ((c.slug && contest === c.slug) ||
             (c.contestTitle && contest === c.contestTitle)) &&
            (c.creator || '').toLowerCase().includes(search)
          ))
        );
      });
    }

    // Pagination logic
    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalEntries = filteredEntries.length;
    const totalPages = Math.ceil(totalEntries / perPage);
    const start = (page - 1) * perPage;
    const paginatedEntries = filteredEntries.slice(start, start + perPage);

    // Improved matching: ignore case and whitespace, always extract filename from fileUrl if present
    const rows = paginatedEntries.map(entry => {
      const name = `${entry.billingAddress?.first_name || ''} ${entry.billingAddress?.last_name || ''}`.trim();
      const email = (entry.customerEmail || entry.billingAddress?.email || '').trim().toLowerCase();
      const contest = (entry.contestName || '').trim().toLowerCase();
      const date = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
      const address = [
        entry.billingAddress?.address_1 || '',
        entry.billingAddress?.address_2 || '',
        entry.billingAddress?.city || '',
        entry.billingAddress?.state || '',
        entry.billingAddress?.postal_code || '',
        entry.billingAddress?.country || ''
      ].filter(Boolean).join(', ');

      // Flag restricted state
      const userState = (entry.billingAddress?.state || '').toUpperCase();
      const restrictedFlag = RESTRICTED_STATES.includes(userState)
        ? ' <span style="color:red;font-weight:bold;">⚠️ Restricted State</span>'
        : '';

      // Try to match by contest and email, fallback to contest and name
      let uploadMatch = uploads.find(u => {
        const uContest = (u.contestName || '').trim().toLowerCase();
        const uEmail = (u.email || u.customerEmail || '').trim().toLowerCase();
        const uName = (u.name || '').trim().toLowerCase();
        return (
          uContest === contest &&
          (
            (uEmail && uEmail === email) ||
            (uName && uName === name.toLowerCase())
          )
        );
      });

      // Always extract filename from fileUrl if present
      let filename = '';
      if (uploadMatch) {
        if (uploadMatch.filename) {
          filename = uploadMatch.filename;
        } else if (uploadMatch.fileUrl) {
          try {
            filename = uploadMatch.fileUrl.split('/').pop();
          } catch {
            filename = '';
          }
        }
      }

      return `
        <tr>
          <td>${name}${restrictedFlag}</td>
          <td>${email}</td>
          <td>${address}</td>
          <td>${date}</td>
        </tr>
      `;
    }).join('');

    // Pagination controls html
    let paginationControls = `<div style="margin-top: 1rem;">`;
    if (page > 1) {
      paginationControls += `<a href="?search=${encodeURIComponent(search)}&page=${page - 1}">Previous</a> `;
    }
    paginationControls += `Page ${page} of ${totalPages}`;
    if (page < totalPages) {
      paginationControls += ` <a href="?search=${encodeURIComponent(search)}&page=${page + 1}">Next</a>`;
    }
    paginationControls += `</div>`;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Admin Entries</title>
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
          .search-bar { margin-bottom: 1rem; }
          .search-bar input { padding: 6px 10px; font-size: 1em; min-width: 200px; }
          .search-bar button { padding: 6px 14px; }
          div.pagination { margin-top: 1rem; }
          .restricted-flag { color: red; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>Admin Panel</h1>
        <nav>
          <a href="/api/admin/dashboard-financials">Dashboard</a> |
          <a href="/api/admin/ytd-snapshots">YTD Snapshots</a> |
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <h2>Entries</h2>
        <form class="search-bar" method="get" action="/api/admin/entries-view">
          <input type="text" name="search" value="${search.replace(/"/g, "&quot;")}" placeholder="Search by name, contest, email, or address..." />
          <button type="submit">Search</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Address</th>
              <th>Date</th>
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
    res.status(500).send('Failed to load entries.');
  }
});

// HTML view of uploaded files with pagination, host column, and contest search
router.get('/uploads', async (req, res) => {
  try {
    const RESTRICTED_STATES = ['NY', 'WA', 'NJ', 'PR', 'GU', 'AS', 'VI', 'MP', 'RI', 'FL', 'AZ'];
    const uploads = await loadUploads();
    const creators = await loadCreators();

    if (!uploads || uploads.length === 0) {
      return res.send('<h2>No uploads found</h2>');
    }

    // SEARCH LOGIC
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredUploads = uploads;
    if (search) {
      filteredUploads = uploads.filter(upload =>
        (upload.contestName || '').toLowerCase().includes(search) ||
        (upload.name || '').toLowerCase().includes(search) ||
        (creators && creators.find(c =>
          ((c.slug && upload.contestName === c.slug) ||
           (c.contestTitle && upload.contestName === c.contestTitle)) &&
          (c.creator || '').toLowerCase().includes(search)
        ))
      );
    }

    // Pagination logic
    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalUploads = filteredUploads.length;
    const totalPages = Math.ceil(totalUploads / perPage);
    const start = (page - 1) * perPage;
    const paginatedUploads = filteredUploads.slice(start, start + perPage);

    // Get presigned URLs and file details
    const uploadsWithDetails = await Promise.all(
      paginatedUploads.map(async (upload) => {
        if (!upload.fileUrl) return { ...upload, presignedUrl: null, fileContent: null, filename: null };

        let key, filename;
        try {
          const url = new URL(upload.fileUrl);
          key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
          filename = url.pathname.split('/').pop();
        } catch (err) {
          console.warn('Invalid fileUrl:', upload.fileUrl);
          return { ...upload, presignedUrl: null, fileContent: null, filename: null };
        }

        let presignedUrl = null;
        try {
          presignedUrl = await getPresignedUrl(key);
        } catch (err) {
          console.error('Error generating presigned URL:', err);
          presignedUrl = upload.fileUrl;
        }

        let fileContent = null;
        if (isTextFile(filename)) {
          fileContent = await getTextFileContents(presignedUrl);
        }

        return { ...upload, presignedUrl, filename, fileContent };
      })
    );

    // Add host/creator lookup logic
    const uploadsWithHost = uploadsWithDetails.map(upload => {
      let host = "Contests Unlimited";
      if (creators && creators.length) {
        const found = creators.find(c =>
          (c.slug && upload.contestName === c.slug) ||
          (c.contestTitle && upload.contestName === c.contestTitle)
        );
        if (found && found.creator) host = found.creator;
      }
      return { ...upload, host };
    });

    // --- New: Get contest end time for each upload for "expired" highlight ---
    const now = Date.now();

    const rows = await Promise.all(uploadsWithHost.map(async upload => {
      const date = new Date(upload.timestamp).toLocaleString();
      const filename = upload.filename || 'No file';
      const viewUrl = upload.presignedUrl;

      // Find the contest object from creators
      const creatorContest = creators.find(c =>
        (c.slug && upload.contestName === c.slug) ||
        (c.contestTitle && upload.contestName === c.contestTitle)
      );

      // --- Add restricted state flag for uploads ---
      const userState = (upload.state || upload.billingAddress?.state || '').toUpperCase();
      const restrictedFlag = RESTRICTED_STATES.includes(userState)
        ? ' <span style="color:red;font-weight:bold;">⚠️ Restricted State</span>'
        : '';

      // --- New: Is contest expired? ---
      let isExpired = false;
      if (creatorContest && creatorContest.endDate) {
        try {
          const endMs = new Date(creatorContest.endDate).getTime();
          if (!isNaN(endMs) && endMs < now) isExpired = true;
        } catch (e) {}
      }

      let fileCell = 'No file available';

      // === PATCH: Handle default caption contest ===
      if (
        upload.contestName === 'caption-contest-default' &&
        upload.fileContent
      ) {
        // Get default caption contest image from S3 caption-contest.json
        let contestImageUrl = '';
        let imgFilename = '';
        try {
          const data = await s3.getObject({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: 'caption-contest.json'
          }).promise();
          const json = JSON.parse(data.Body.toString('utf-8'));
          let imageUrl = json.image;
          if (imageUrl && !/^https?:\/\//.test(imageUrl)) {
            const key = imageUrl.replace(/^\//, '');
            contestImageUrl = await getPresignedUrl(key);
            imgFilename = key.split('/').pop();
          } else {
            contestImageUrl = imageUrl;
            imgFilename = '';
          }
        } catch (e) {
          contestImageUrl = '';
          imgFilename = '';
        }

        fileCell = `
          <b>Caption:</b><br>
          <pre style="max-width:320px;white-space:pre-wrap;background:#f0f0f0;padding:8px;border-radius:6px;">${(upload.fileContent || '').replace(/</g, '&lt;')}</pre>
          <b>Image:</b><br>
          ${contestImageUrl
            ? `<a href="${contestImageUrl}" target="_blank">View</a><br>
               <img src="${contestImageUrl}" alt="${imgFilename}" style="max-width: 100px;">`
            : 'No contest image'}
        `;
      }
      // For custom caption contests, show contest image and caption
      else if (
        creatorContest &&
        creatorContest.fileUrl &&
        upload.contestName &&
        upload.contestName.startsWith('caption-contest-') &&
        upload.contestName !== 'caption-contest-default'
      ) {
        // Get presigned URL for contest image
        let contestImageUrl = '';
        let imgFilename = '';
        try {
          const url = new URL(creatorContest.fileUrl);
          const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
          contestImageUrl = await getPresignedUrl(key);
          imgFilename = url.pathname.split('/').pop();
        } catch (e) {
          contestImageUrl = creatorContest.fileUrl;
          imgFilename = '';
        }

        fileCell = `
          <b>Caption:</b><br>
          <pre style="max-width:320px;white-space:pre-wrap;background:#f0f0f0;padding:8px;border-radius:6px;">${(upload.fileContent || '').replace(/</g, '&lt;')}</pre>
          <b>Image:</b><br>
          ${contestImageUrl
            ? `<a href="${contestImageUrl}" target="_blank">View</a><br>
               <img src="${contestImageUrl}" alt="${imgFilename}" style="max-width: 100px;">`
            : 'No contest image'}
        `;
      } else if (viewUrl) {
        if (isImageFile(filename)) {
          fileCell = `<a href="${viewUrl}" target="_blank">View</a><br>
                      <img src="${viewUrl}" alt="${filename}" style="max-width: 100px;">`;
        } else if (isTextFile(filename)) {
          fileCell = `<a href="${viewUrl}" target="_blank">View Caption</a><br>
                      <pre style="max-width:320px;white-space:pre-wrap;background:#f0f0f0;padding:8px;border-radius:6px;">${(upload.fileContent || '').replace(/</g, '&lt;')}</pre>`;
        } else {
          fileCell = `<a href="${viewUrl}" target="_blank">Download</a>`;
        }
      }

      // --- Winner / Disqualify logic ---
      let winnerCell = '';
      // If upload is disqualified, always show Disqualified and do not show winner button
      if (upload.isDisqualified) {
        winnerCell = '<b style="color:red;">Disqualified</b>';
      } else if (upload.isWinner) {
        winnerCell = '<b style="color:green;">Winner</b>';
      } else {
        // Show Disqualify button always
        let disqualifyBtn = `<button onclick="disqualifyUpload('${upload.sessionId}', '${upload.contestName || ''}')">Disqualify</button>`;
        // Only show Winner button if contest has ended and not disqualified
        let winnerBtn = '';
        if (isExpired) {
          winnerBtn = `<button onclick="confirmWinner('${upload.sessionId}', '${upload.contestName || ''}')">Winner</button>`;
        }
        winnerCell = `${disqualifyBtn}${winnerBtn ? '<br>' + winnerBtn : ''}`;
      }

      // --- Highlight row red if contest expired ---
      const trStyle = isExpired
        ? 'background-color:#ffd9d9;'
        : '';

      return `
        <tr style="${trStyle}">
          <td>${upload.name || ''}${restrictedFlag}</td>
          <td>${upload.contestName || ''}</td>
          <td>${upload.host || ''}</td>
          <td>${date}</td>
          <td>${filename}</td>
          <td>${fileCell}</td>
          <td>${winnerCell}</td>
        </tr>
      `;
    }));

    // Pagination controls html
    let paginationControls = `<div style="margin-top: 1rem;">`;
    if (page > 1) {
      paginationControls += `<a href="?search=${encodeURIComponent(search)}&page=${page - 1}">Previous</a> `;
    }
    paginationControls += `Page ${page} of ${totalPages}`;
    if (page < totalPages) {
      paginationControls += ` <a href="?search=${encodeURIComponent(search)}&page=${page + 1}">Next</a>`;
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
          pre { font-size: 0.97em; }
          div.pagination { margin-top: 1rem; }
          .search-bar { margin-bottom: 1rem; }
          .search-bar input { padding: 6px 10px; font-size: 1em; min-width: 200px; }
          .search-bar button { padding: 6px 14px; }
        </style>
      </head>
      <body>
        <h1>Admin Panel</h1>
        <nav>
          <a href="/api/admin/dashboard-financials">Dashboard</a> |
          <a href="/api/admin/ytd-snapshots">YTD Snapshots</a> |
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <h2>Uploaded Files</h2>
        <form class="search-bar" method="get" action="/api/admin/uploads">
          <input type="text" name="search" value="${search.replace(/"/g, "&quot;")}" placeholder="Search by contest, host, or name..." />
          <button type="submit">Search</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Contest</th>
              <th>Host</th>
              <th>Date</th>
              <th>Original Filename</th>
              <th>File</th>
              <th>Winner</th>
            </tr>
          </thead>
          <tbody>
            ${rows.join('')}
          </tbody>
        </table>
        ${paginationControls}
        <script>
          function confirmWinner(sessionId, contestName) {
            if (!confirm("Are you sure about this selection?")) return;
            fetch('/api/admin/set-winner', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ sessionId, contestName })
            })
            .then(res => res.json())
            .then(data => {
              if (data.success) {
                alert("Winner selected!");
                location.reload();
              } else {
                alert("Failed to select winner.");
              }
            })
            .catch(() => alert("Failed to select winner."));
          }
          function disqualifyUpload(sessionId, contestName) {
            if (!confirm("Are you sure you want to disqualify this entry? This cannot be undone.")) return;
            fetch('/api/admin/disqualify-upload', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ sessionId, contestName })
            })
            .then(res => res.json())
            .then(data => {
              if (data.success) {
                alert("Entry disqualified!");
                location.reload();
              } else {
                alert("Failed to disqualify entry.");
              }
            })
            .catch(() => alert("Failed to disqualify entry."));
          }
        </script>
      </body>
      </html>
   `);
  } catch (err) {
    res.status(500).send('Failed to load uploads.');
  }
});

// Trivia results view with search bar and host (FULL, with default and custom trivia support)
router.get('/trivia', async (req, res) => {
  try {
    const uploads = await loadUploads();
    const creators = await loadCreators();

    // Load both default and custom trivia sets
    const defaultTriviaData = await loadJSONFromS3('trivia-contest.json');
    const customTriviaData = await loadJSONFromS3('custom-trivia.json');

    // --- SEARCH LOGIC ---
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredUploads = uploads;
    if (search) {
      filteredUploads = uploads.filter(upload =>
        (upload.contestName || '').toLowerCase().includes(search) ||
        (upload.name || '').toLowerCase().includes(search) ||
        (creators && creators.find(c =>
          ((c.slug && upload.contestName === c.slug) ||
           (c.contestTitle && upload.contestName === c.contestTitle)) &&
          (c.creator || '').toLowerCase().includes(search)
        ))
      );
    }

    const scored = filteredUploads
      .filter(entry =>
        (Array.isArray(entry.triviaAnswers) && entry.triviaAnswers.length > 0) ||
        (typeof entry.correctCount === 'number' && typeof entry.timeTaken === 'number')
      )
      .map(entry => {
        // Find the matching contest by slug or title, if present
        let contest = creators.find(c =>
          (c.slug && entry.contestName === c.slug) ||
          (c.contestTitle && entry.contestName === c.contestTitle)
        );
//ended here
       let correctAnswers = [];
        if (contest && contest.slug && contest.slug.startsWith('trivia-contest-') && contest.slug !== 'trivia-contest-default') {
          // custom trivia contest
          const custom = customTriviaData.find(t => t.slug === contest.slug);
          if (custom && Array.isArray(custom.questions)) {
            correctAnswers = custom.questions.map(q => q.answer);
          }
        } else {
          // fallback to default
          correctAnswers = defaultTriviaData.map(q => q.answer);
        }

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
        // Host lookup
        let host = "Contests Unlimited";
        if (creators && creators.length) {
          const found = creators.find(c =>
            (c.slug && entry.contestName === c.slug) ||
            (c.contestTitle && entry.contestName === c.contestTitle)
          );
          if (found && found.creator) host = found.creator;
        }
        return { ...entry, score, host, numQuestions: correctAnswers.length };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
      });

    // Pagination logic
    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalRows = scored.length;
    const totalPages = Math.ceil(totalRows / perPage);
    const start = (page - 1) * perPage;
    const paginatedRows = scored.slice(start, start + perPage);

    const rows = paginatedRows.map(entry => `
      <tr>
        <td>${entry.name}</td>
        <td>${entry.contestName}</td>
        <td>${entry.host}</td>
        <td>${entry.score} / ${entry.numQuestions}</td>
        <td>${typeof entry.timeTaken === 'number' ? entry.timeTaken.toFixed(3) + ' sec' : 'N/A'}</td>
      </tr>
    `).join('');

    let paginationControls = `<div style="margin-top: 1rem;">`;
    if (page > 1) {
      paginationControls += `<a href="?search=${encodeURIComponent(search)}&page=${page - 1}">Previous</a> `;
    }
    paginationControls += `Page ${page} of ${totalPages}`;
    if (page < totalPages) {
      paginationControls += ` <a href="?search=${encodeURIComponent(search)}&page=${page + 1}">Next</a>`;
    }
    paginationControls += `</div>`;

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
          .search-bar { margin-bottom: 1rem; }
          .search-bar input { padding: 6px 10px; font-size: 1em; min-width: 200px; }
          .search-bar button { padding: 6px 14px; }
          div.pagination { margin-top: 1rem; }
        </style>
      </head>
      <body>
        <h1>Trivia Contest Submissions</h1>
        <nav>
          <a href="/api/admin/dashboard-financials">Dashboard</a> |
          <a href="/api/admin/ytd-snapshots">YTD Snapshots</a> |
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <form class="search-bar" method="get" action="/api/admin/trivia">
          <input type="text" name="search" value="${search.replace(/"/g, "&quot;")}" placeholder="Search by contest, host, or name..." />
          <button type="submit">Search</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Contest</th>
              <th>Host</th>
              <th>Correct Answers</th>
              <th>Time Taken</th>
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
    console.error('Failed to load trivia submissions:', err);
    res.status(500).send('Failed to load trivia submissions.');
  }
});

// Creators view with search bar and host, now with address info and secure S3 file/image presigned URLs
router.get('/creators', async (req, res) => {
  try {
    const RESTRICTED_STATES = ['NY', 'WA', 'NJ', 'PR', 'GU', 'AS', 'VI', 'MP', 'RI', 'FL', 'AZ'];
    const creators = await loadCreators();

    if (!creators || creators.length === 0) {
      return res.send('<h2>No creator submissions found</h2>');
    }

    // --- SEARCH LOGIC ---
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredCreators = creators;
    if (search) {
      filteredCreators = creators.filter(c =>
        (c.creator || '').toLowerCase().includes(search) ||
        (c.email || '').toLowerCase().includes(search) ||
        (c.contestTitle || '').toLowerCase().includes(search) ||
        (c.theme || '').toLowerCase().includes(search) ||
        (c.description || '').toLowerCase().includes(search) ||
        (c.slug || '').toLowerCase().includes(search) ||
        (c.address || '').toLowerCase().includes(search) ||
        (c.city || '').toLowerCase().includes(search) ||
        (c.state || '').toLowerCase().includes(search) ||
        (c.zipcode || '').toLowerCase().includes(search) ||
        (c.fileCell || '').toLowerCase().includes(search)
      );
    }

    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalCreators = filteredCreators.length;
    const totalPages = Math.ceil(totalCreators / perPage);
    const start = (page - 1) * perPage;
    const paginatedCreators = filteredCreators.slice(start, start + perPage);

    const now = Date.now();
    const rows = paginatedCreators.map(creator => {
      let isExpired = false;
      if (creator.endDate) {
        const end = new Date(creator.endDate).getTime();
        if (!isNaN(end) && end < now) isExpired = true;
      }
      // Format address: street, city, state ZIP
      const addressDisplay = [
        creator.address || "",
        creator.city || "",
        (creator.state || "") + (creator.zipcode ? " " + creator.zipcode : "")
      ].filter(Boolean).join(', ');

      // Add restricted state flag if needed
      const creatorState = (creator.state || '').toUpperCase();
      const restrictedFlag = RESTRICTED_STATES.includes(creatorState)
        ? ' <span style="color:red;font-weight:bold;">⚠️ Restricted State</span>'
        : '';

      // Get S3 key safely for presigned URL fetch (no regex in HTML!)
      let s3Key = '';
      if (creator.fileUrl) {
        try {
          const url = new URL(creator.fileUrl);
          s3Key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
        } catch (e) {
          s3Key = '';
        }
      }

      return `
        <tr data-id="${creator.id || creator.timestamp}"${isExpired ? ' class="expired-row"' : ''}>
          <td>${creator.creator || ''}${restrictedFlag}</td>
          <td>${creator.email || ''}</td>
          <td>${creator.contestTitle || ''}</td>
          <td>${creator.theme || ''}</td>
          <td>${creator.description || ''}</td>
          <td>${new Date(creator.timestamp).toLocaleString()}</td>
          <td>${creator.status || 'Pending'}</td>
          <td>${addressDisplay}</td>
          <td>
${creator.fileUrl 
  ? `<a href="#" onclick="return openCreatorFile('${creator.fileUrl.replace(/'/g, "\\'")}')" style="color:#007bff;">View</a>
     <br><img src="" data-key="${s3Key}" alt="creator-img" style="max-width:80px;max-height:80px;margin-top:3px;border-radius:4px;display:none;">`
  : ''}
</td>
          <td>${creator.email ? `<a href="/creator-dashboard.html?email=${encodeURIComponent(creator.email)}" target="_blank">Go to Dashboard</a>` : ''}</td>
          <td>
            <button onclick="handleStatus('${creator.id || creator.timestamp}', 'approved')">Approve</button>
            <button onclick="handleStatus('${creator.id || creator.timestamp}', 'rejected')">Reject</button>
          </td>
        </tr>
      `;
    }).join('');

    let paginationControls = `<div style="margin-top: 1rem;">`;
    if (page > 1) {
      paginationControls += `<a href="?search=${encodeURIComponent(search)}&page=${page - 1}">Previous</a> `;
    }
    paginationControls += `Page ${page} of ${totalPages}`;
    if (page < totalPages) {
      paginationControls += ` <a href="?search=${encodeURIComponent(search)}&page=${page + 1}">Next</a>`;
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
          .search-bar { margin-bottom: 1rem; }
          .search-bar input { padding: 6px 10px; font-size: 1em; min-width: 200px; }
          .search-bar button { padding: 6px 14px; }
          .expired-row {
            background: #ffeaea !important;
            color: #a00 !important;
          }
        </style>
      </head>
      <body>
        <h1>Contest Creators</h1>
        <nav>
          <a href="/api/admin/dashboard-financials">Dashboard</a> |
          <a href="/api/admin/ytd-snapshots">YTD Snapshots</a> |
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <form class="search-bar" method="get" action="/api/admin/creators">
          <input type="text" name="search" value="${search.replace(/"/g, "&quot;")}" placeholder="Search by name, email, contest, or address..." />
          <button type="submit">Search</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Contest Name</th>
              <th>Theme</th>
              <th>Description</th>
              <th>Submitted</th>
              <th>Status</th>
              <th>Address</th>
              <th>File</th>
              <th>Link</th>
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
        let linkCell = row.querySelector('td:nth-child(8)');
        if (linkCell) {
          linkCell.innerHTML = '<a href="/contest/' + result.slug + '" target="_blank">View Contest</a>';
        }
      } else {
        // Remove link if rejected
        let linkCell = row.querySelector('td:nth-child(8)');
        if (linkCell) {
          linkCell.innerHTML = '';
        }
      }

    } else {
      alert('Failed to update status.');
    }
  }

  // Open image/file in new tab using presigned URL
  async function openCreatorFile(fileUrl) {
    try {
      const url = new URL(fileUrl);
      const key = encodeURIComponent(url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname);
      const res = await fetch('/api/admin/creator-file?key=' + key);
      if (res.ok) {
        const data = await res.json();
        window.open(data.url, '_blank');
      } else {
        alert("Could not retrieve file link.");
      }
    } catch(e) {
      alert("Invalid file URL.");
      return false;
    }
    return false;
  }

  // On page load, set presigned URLs for all images
  window.addEventListener('DOMContentLoaded', async () => {
    const imgs = document.querySelectorAll('img[data-key]');
    for (const img of imgs) {
      const key = encodeURIComponent(img.getAttribute('data-key'));
      if (!key) continue;
      try {
        const res = await fetch('/api/admin/creator-file?key=' + key);
        if (res.ok) {
          const data = await res.json();
          img.src = data.url;
          img.style.display = '';
        }
      } catch (e) {
        // ignore
      }
    }
  });
</script>
      </body>
      </html>
   `);
  } catch (err) {
    console.error('Failed to load creators:', err);
    res.status(500).send('Failed to load creators.');
  }
});

// --- UPDATED: Contest Stats Route for Creators ---
router.get('/creator-stats/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const uploads = await loadUploads();
    const creators = await loadCreators();

    if (!uploads) return res.status(404).send('No entries found.');

    // Find the associated contest by slug
    const contest = creators.find(c => c.slug === slug);
    const contestName = contest?.contestTitle || slug;
    const creator = contest?.creator || 'Contests Unlimited';

    // Determine if platform or custom contest
    const isPlatform = !creator || (typeof creator === 'string' && creator.trim().toLowerCase() === "contests unlimited");

    // Filter entries for this contest by contestName
    const contestEntries = uploads.filter(entry => entry.contestName === contestName);
    const numEntries = contestEntries.length;

    // Business rules
    const entryFee = 100;

    // Use new contest duration/seed/min logic
    let duration = contest?.durationMonths ? parseInt(contest.durationMonths, 10) : (isPlatform ? 12 : 1);
    let seedAmount = contest?.seedAmount;
    let minEntries = contest?.minEntries;
    // UPDATED seed/min matrix
    if (!seedAmount || !minEntries) {
      if (duration === 1) { seedAmount = 250; minEntries = 50; }
      else if (duration === 3) { seedAmount = 500; minEntries = 100; }
      else if (duration === 6) { seedAmount = 750; minEntries = 150; }
      else { seedAmount = 1000; minEntries = 200; }
    }

    // Prize calculation
    let pot = 0, reserve = 0, creatorEarnings = 0, platformEarnings = 0, seedInPot = false;
    if (isPlatform) {
      pot = numEntries * entryFee * 0.6;
      reserve = numEntries * entryFee * 0.1;
      platformEarnings = numEntries * entryFee * 0.3;
    } else {
      pot = numEntries * entryFee * 0.6;
      reserve = numEntries * entryFee * 0.10;
      // --- REVISED CREATOR EARNINGS LOGIC ---
      if (numEntries <= minEntries) {
        creatorEarnings = numEntries * entryFee * 0.25;
      } else {
        creatorEarnings = minEntries * entryFee * 0.25 + (numEntries - minEntries) * entryFee * 0.30;
      }
      platformEarnings = numEntries * entryFee * 0.05;
    }
    // Add seed if minimum entries met
    if (numEntries >= minEntries) {
      pot += seedAmount;
      seedInPot = true;
    }

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
      .expired-row {
        background: #ffeaea !important;
        color: #a00 !important;
      }
    </style>
  </head>
  <body>
    <h1>Stats for "${contestName}"</h1>
    <div class="stat"><strong>Number of Entries:</strong> ${numEntries}</div>
    <div class="stat"><strong>Current Prize Pot:</strong> $${pot < 0 ? 0 : pot.toFixed(2)} ${seedInPot ? '(Seeded)' : (numEntries > 0 && numEntries < minEntries ? '(Seed removed - not enough entries)' : '')}</div>
    <div class="stat"><strong>Reserve:</strong> $${reserve.toFixed(2)}</div>
    <div class="stat"><strong>Creator Earnings:</strong> $${creatorEarnings.toFixed(2)}</div>
    <div class="stat"><strong>Platform Earnings:</strong> $${platformEarnings.toFixed(2)}</div>
    <div class="stat"><strong>Contest Type:</strong> ${isPlatform ? 'Platform (Contests Unlimited)' : 'Custom'}</div>
    <div class="stat"><strong>Seed Rule:</strong> $${seedAmount} is seeded in the prize pot if the contest reaches at least ${minEntries} entries by contest close. Winner always receives 60% of entry fees regardless.</div>
    <div class="stat"><strong>Duration:</strong> ${duration === 1 ? '1 month' : duration === 12 ? '1 year' : `${duration} months`}</div>
    <div class="stat"><strong>Split:</strong> ${
      isPlatform
        ? "60% pot, 10% reserve, 30% platform"
        : "60% pot, 25% creator up to minimum, 30% above minimum, 10% reserve, 5% platform"
    }</div>
    <div class="stat">
      <strong>Creator Payout Explanation:</strong>
      For the first ${minEntries} entries, the creator earns <b>25%</b> per entry. For each entry above the minimum, the creator earns <b>30%</b> per entry.
    </div>
  </body>
  </html>
`);
  } catch (err) {
    console.error('Failed to load contest stats:', err);
    res.status(500).send('Failed to load contest stats.');
  }
});
// --- END UPDATED ---

// Logout route
router.get('/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Logged out');
});

router.post('/update-status', express.json(), async (req, res) => {
  const { id, status } = req.body;
//ended here
 if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });

  try {
    const creators = await loadCreators();
    const index = creators.findIndex(entry => entry.id === id || entry.timestamp === id);

    if (index === -1) return res.status(404).json({ error: 'Submission not found' });

    creators[index].status = status;

    let slug = null;
   if (status === 'approved') {
    slug = creators[index].slug; // keep the original slug!
    // Do NOT change the slug on approval
  } else {
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

router.get('/dashboard-financials', async (req, res) => {
  try {
    const [uploads, creators] = await Promise.all([
      loadUploads(),
      loadCreators()
    ]);

    // --- Platform contest config (MUST match index.js logic) ---
    const PLATFORM_CONTESTS = [
      { contestTitle: "Art Contest" },
      { contestTitle: "Photo Contest" },
      { contestTitle: "Trivia Contest" },
      { contestTitle: "Caption Contest" }
    ];
    const PLATFORM_TITLES = PLATFORM_CONTESTS.map(c => c.contestTitle);
    const DEFAULT_CONTEST_START = new Date('2025-05-30T14:00:00Z');
    const DEFAULT_CONTEST_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
    const DEFAULT_CONTEST_SEED = 1000;
    const DEFAULT_CONTEST_MIN = 200;

    function isPlatformContest(creator) {
      return !creator || (typeof creator === 'string' && creator.trim().toLowerCase() === "contests unlimited");
    }

    function getSeedAndMin(durationMonths, isPlatform) {
      if (isPlatform) {
        return { seed: DEFAULT_CONTEST_SEED, min: DEFAULT_CONTEST_MIN };
      }
      if (durationMonths === 1) return { seed: 250, min: 50 };
      if (durationMonths === 3) return { seed: 500, min: 100 };
      if (durationMonths === 6) return { seed: 750, min: 150 };
      return { seed: 1000, min: 200 };
    }

    function calculatePrizesByContest(uploads, creatorsArray, nowMs = Date.now()) {
      const entriesByContest = {};
      for (const upload of uploads) {
        const contest = upload.contestName || 'Unknown';
        if (!entriesByContest[contest]) entriesByContest[contest] = [];
        entriesByContest[contest].push(upload);
      }

      const contestInfoBySlug = {};
      if (Array.isArray(creatorsArray)) {
        for (const c of creatorsArray) {
          if (c.slug) {
            contestInfoBySlug[c.slug] = c;
          }
        }
      }

      const prizes = {};
      for (const contestName in entriesByContest) {
        const entries = entriesByContest[contestName];
        let contestInfo = Object.values(contestInfoBySlug).find(
          c => c.slug === contestName || c.contestTitle === contestName
        ) || {};
        const creator = contestInfo.creator || 'Contests Unlimited';
        const isPlatform = isPlatformContest(creator);

        const entryFee = 100;

        let durationMonths = 12;
        let seedAmount = DEFAULT_CONTEST_SEED;
        let minEntries = DEFAULT_CONTEST_MIN;

        if (isPlatform) {
          durationMonths = 12;
          seedAmount = DEFAULT_CONTEST_SEED;
          minEntries = DEFAULT_CONTEST_MIN;
        } else {
          if (contestInfo.durationMonths) {
            durationMonths = parseInt(contestInfo.durationMonths, 10) || 1;
          } else if (contestInfo.endDate && contestInfo.startDate) {
            const ms = new Date(contestInfo.endDate).getTime() - new Date(contestInfo.startDate).getTime();
            durationMonths = Math.round(ms / (30 * 24 * 60 * 60 * 1000)) || 1;
          }
          const matrix = getSeedAndMin(durationMonths, isPlatform);
          seedAmount = matrix.seed;
          minEntries = matrix.min;
        }

        let totalEntries = entries.length;
        let pot = 0, reserve = 0, creatorEarnings = 0, platformEarnings = 0;
        let seedIncluded = false;
        let seedEligible = false;

        let endDateMs = null;
        if (contestInfo.endDate) {
          endDateMs = new Date(contestInfo.endDate).getTime();
        }

        if (isPlatform) {
          reserve = totalEntries * entryFee * 0.1;
          platformEarnings = totalEntries * entryFee * 0.3;
        } else {
          reserve = totalEntries * entryFee * 0.10;
          if (totalEntries <= minEntries) {
            creatorEarnings = totalEntries * entryFee * 0.25;
          } else {
            creatorEarnings = minEntries * entryFee * 0.25 + (totalEntries - minEntries) * entryFee * 0.30;
          }
          platformEarnings = totalEntries * entryFee * 0.05;
        }

        if (endDateMs && nowMs > endDateMs) {
          if (totalEntries >= minEntries) {
            pot = seedAmount + (totalEntries * entryFee * 0.6);
            seedIncluded = true;
            seedEligible = true;
          } else {
            pot = totalEntries * entryFee * 0.6;
            seedIncluded = false;
            seedEligible = false;
          }
        } else {
          if (totalEntries >= minEntries) {
            pot = seedAmount + (totalEntries * entryFee * 0.6);
            seedIncluded = true;
            seedEligible = true;
          } else if (totalEntries > 0) {
            pot = totalEntries * entryFee * 0.6;
            seedIncluded = false;
            seedEligible = false;
          } else {
            pot = 0;
            seedIncluded = false;
            seedEligible = false;
          }
        }

        let displayTitle = contestInfo.contestTitle;
        if (!displayTitle && contestName) {
          displayTitle = contestName.replace(/-default$/, '')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());
        }

        prizes[contestName] = {
          totalEntries,
          pot: pot < 0 ? 0 : pot,
          reserve,
          creatorEarnings,
          platformEarnings,
          seedIncluded,
          seedEligible,
          isPlatform,
          endDateMs,
          contestTitle: displayTitle || contestName,
          creator: contestInfo.creator || 'Contests Unlimited',
          seedAmount,
          minEntries,
          durationMonths
        };
      }
      return prizes;
    }

    // ---- NEW: LOAD/SAVE W9 STATUS ----
    const s3W9Key = 'w9-status.json';
    let w9Status = {};
    try {
      const w9Obj = await s3.getObject({ Bucket: BUCKET_NAME, Key: s3W9Key }).promise();
      w9Status = JSON.parse(w9Obj.Body.toString() || '{}');
    } catch (e) {
      w9Status = {};
    }
    // -----------------------------------

    // --- MAIN LOGIC, matches index.js ---
    const now = Date.now();
    let expired = [];
    let pending = [];
    let totalRevenue = 0, totalWinner = 0, totalSeed = 0, totalCreator = 0, totalReserve = 0, totalPlatform = 0, myProfit = 0;
    let outstandingToWinners = 0, outstandingToCreators = 0;

    let prizes = calculatePrizesByContest(uploads, creators, now);

    // Inject platform contests if missing, as in index.js:
    for (const def of PLATFORM_CONTESTS) {
      const key = def.contestTitle;
      if (!prizes[key]) {
        prizes[key] = {
          totalEntries: 0,
          pot: 0,
          reserve: 0,
          creatorEarnings: 0,
          platformEarnings: 0,
          seedIncluded: false,
          seedEligible: false,
          isPlatform: true,
          endDateMs: DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS,
          contestTitle: def.contestTitle,
          creator: 'Contests Unlimited',
          seedAmount: DEFAULT_CONTEST_SEED,
          minEntries: DEFAULT_CONTEST_MIN,
          durationMonths: 12
        };
      }
    }

    // Ensure all platform contests have a valid endDateMs
    for (const def of PLATFORM_CONTESTS) {
      const key = def.contestTitle;
      if (prizes[key] && !prizes[key].endDateMs) {
        prizes[key].endDateMs = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;
      }
    }

    // Deduplicate/merge platform contests by title (matches index.js)
    for (const def of PLATFORM_CONTESTS) {
      const key = def.contestTitle;
      const matchingKeys = Object.keys(prizes).filter(prKey =>
        prizes[prKey].isPlatform && prizes[prKey].contestTitle === key && prKey !== key
      );
      if (matchingKeys.length > 0) {
        const base = prizes[key];
        let mergedEntries = base.totalEntries;
        let mergedEndDateMs = base.endDateMs;
        for (const k of matchingKeys) {
          const p = prizes[k];
          mergedEntries += p.totalEntries;
          if (!mergedEndDateMs || (p.endDateMs && p.endDateMs > mergedEndDateMs)) {
            mergedEndDateMs = p.endDateMs;
          }
          delete prizes[k];
        }
        base.totalEntries = mergedEntries;
        base.endDateMs = mergedEndDateMs;
        if (base.endDateMs && now > base.endDateMs) {
          if (mergedEntries >= DEFAULT_CONTEST_MIN) {
            base.pot = DEFAULT_CONTEST_SEED + (mergedEntries * 100 * 0.6);
            base.seedIncluded = true;
            base.seedEligible = true;
          } else {
            base.pot = mergedEntries * 100 * 0.6;
            base.seedIncluded = false;
            base.seedEligible = false;
          }
        } else {
          if (mergedEntries >= DEFAULT_CONTEST_MIN) {
            base.pot = DEFAULT_CONTEST_SEED + (mergedEntries * 100 * 0.6);
            base.seedIncluded = true;
            base.seedEligible = true;
          } else if (mergedEntries > 0) {
            base.pot = mergedEntries * 100 * 0.6;
            base.seedIncluded = false;
            base.seedEligible = false;
          } else {
            base.pot = 0;
            base.seedIncluded = false;
            base.seedEligible = false;
          }
        }
        base.seedAmount = DEFAULT_CONTEST_SEED;
        base.minEntries = DEFAULT_CONTEST_MIN;
        base.durationMonths = 12;
      }
    }

    // Order for display: platform first, then the rest alpha by title
    const orderedPrizeTitles = [
      ...PLATFORM_CONTESTS.map(c => c.contestTitle),
      ...Object.keys(prizes).filter(title =>
        !PLATFORM_CONTESTS.some(c => c.contestTitle === title)
      ).sort((a, b) => {
        const tA = prizes[a].contestTitle || a;
        const tB = prizes[b].contestTitle || b;
        return tA.localeCompare(tB);
      }),
    ];

    // Build pending/expired tables using prizes (matches index.js logic)
    for (const title of orderedPrizeTitles) {
      const data = prizes[title];
      if (!data) continue;
      const entryFee = 100;
      const isExpired = data.endDateMs && now > data.endDateMs;

      // --- WINNER LOOKUP LOGIC ---
      let winner = 'TBD';
      if (isExpired) {
        const winnerUpload = uploads.find(
          u => u.contestName === title && u.isWinner
        );
        if (winnerUpload) {
          winner = winnerUpload.name || winnerUpload.email || winnerUpload.customerEmail || winnerUpload.sessionId;
        }
      }
      // ---

      const creator = data.creator || 'Contests Unlimited';
      const entriesCount = data.totalEntries;
      const minEntries = data.minEntries;
      const seedAmount = data.seedAmount;

      let pot = data.pot;
      let creatorEarnings = data.creatorEarnings || 0;
      let outstandingToWinner = (isExpired) ? pot : 0;
      let outstandingToCreator = (isExpired && !data.isPlatform) ? creatorEarnings : 0;

      // Totals (platform/creator/reserve/etc)
      totalRevenue += entriesCount * entryFee;
      totalWinner += entriesCount * entryFee * 0.6;
      if (data.isPlatform) {
        totalPlatform += entriesCount * entryFee * 0.3;
        totalReserve += entriesCount * entryFee * 0.1;
        myProfit += entriesCount * entryFee * 0.3;
      } else {
        totalCreator += creatorEarnings;
        totalPlatform += entriesCount * entryFee * 0.05;
        totalReserve += entriesCount * entryFee * 0.1;
        myProfit += entriesCount * entryFee * 0.05;
      }
      if (data.seedIncluded) totalSeed += seedAmount;

      if (isExpired) {
        expired.push({
          title: data.contestTitle,
          slug: null,
          winner,
          winnerPayout: pot,
          creator,
          creatorPayout: creatorEarnings,
          outstandingToWinner,
          outstandingToCreator
        });
        if (outstandingToWinner) outstandingToWinners += outstandingToWinner;
        if (outstandingToCreator) outstandingToCreators += outstandingToCreator;
      } else {
        pending.push({
          title: data.contestTitle,
          creator,
          slug: null,
          entriesCount,
          min: minEntries,
          seed: seedAmount,
          endDate: data.endDateMs
        });
      }
    }

    // ---- YTD CALCULATIONS ----
    // 1. Get start of year
    const nowDate = new Date();
    const startOfYear = new Date(nowDate.getFullYear(), 0, 1).getTime();

    // 2. Filter uploads to YTD uploads
    const uploadsYTD = uploads.filter(u => {
      const ts = new Date(u.timestamp || u.createdAt || u.updatedAt).getTime();
      return ts >= startOfYear;
    });

    // 3. Group YTD by contest
    const ytdByContest = {};
    uploadsYTD.forEach(u => {
      if (!ytdByContest[u.contestName]) ytdByContest[u.contestName] = [];
      ytdByContest[u.contestName].push(u);
    });

    // Map for creator/winner details: payout, email, name, etc
    let ytdByCreator = {};
    let ytdByWinner = {};
    let ytdPlatform = 0;
    let ytdCreatorsDetails = {};
    let ytdWinnersDetails = {};

    for (const contestName in ytdByContest) {
      const contestUploads = ytdByContest[contestName];
      const contestInfo = creators.find(c => c.slug === contestName) || {};
      // Determine if platform/default contest
      const isPlatform = PLATFORM_TITLES.includes(contestName) ||
        (!contestInfo.creator || contestInfo.creator.trim().toLowerCase() === "contests unlimited");
      const creator = contestInfo.creator || "Contests Unlimited";
      const creatorEmail = contestInfo.creatorEmail || contestInfo.email || "";
      const creatorName = contestInfo.creator || "";
      const entryFee = 100;
      const totalEntries = contestUploads.length;
      let creatorEarnings = 0, winnerPayout = 0, platformEarnings = 0;
      let minEntries = contestInfo.minEntries || 50;

      if (isPlatform) {
        // Default contest: $30/entry to platform, $0 to creator
        platformEarnings = totalEntries * 30;
        creatorEarnings = 0;
      } else {
        // Custom contest: $5/entry to platform, 25-30% to creator
        if (totalEntries <= minEntries) {
          creatorEarnings = totalEntries * entryFee * 0.25;
          platformEarnings = totalEntries * 5;
        } else {
          creatorEarnings = minEntries * entryFee * 0.25 + (totalEntries - minEntries) * entryFee * 0.30;
          platformEarnings = totalEntries * 5;
        }
      }
      winnerPayout = totalEntries * entryFee * 0.6;

      // Only add non-platform creators to YTD list
      if (!isPlatform) {
        ytdByCreator[creator] = (ytdByCreator[creator] || 0) + creatorEarnings;
        ytdCreatorsDetails[creator] = ytdCreatorsDetails[creator] || { name: creatorName, email: creatorEmail, payout: 0 };
        ytdCreatorsDetails[creator].payout += creatorEarnings;
      }

      ytdPlatform += platformEarnings;

      // Winner logic is unchanged
      const winnerUpload = contestUploads.find(u => u.isWinner);
      if (winnerUpload) {
        const winner = winnerUpload.name || winnerUpload.customerEmail || winnerUpload.sessionId;
        const winnerEmail = winnerUpload.email || winnerUpload.customerEmail || "";
        ytdByWinner[winner] = (ytdByWinner[winner] || 0) + winnerPayout;
        ytdWinnersDetails[winner] = ytdWinnersDetails[winner] || { name: winner, email: winnerEmail, payout: 0 };
        ytdWinnersDetails[winner].payout += winnerPayout;
      }
    }

    // ----------- HTML RENDER WITH BUTTON LOGIC -----------
    res.send(`
      <html>
      <head>
        <title>Admin Financial Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2em; }
          h2 { color: #007849; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 2em; }
          th, td { border: 1px solid #ccc; padding: 8px; }
          th { background: #e6faf1; }
          .w9notice { color: #d00; font-weight: bold; }
          .w9complete { color: #080; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>Admin Financial Dashboard</h1>
        <nav>
          <a href="/api/admin/dashboard-financials">Dashboard</a> |
          <a href="/api/admin/ytd-snapshots">YTD Snapshots</a> |
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>

        <!-- YTD Snapshot Button -->
        <form method="POST" action="/api/admin/snapshot-ytds" style="margin-bottom:1em;">
          <button type="submit">Snapshot YTDs</button>
        </form>

        <h2>Totals</h2>
        <ul>
          <li><b>Total Revenue:</b> $${totalRevenue.toFixed(2)}</li>
          <li><b>Total Winner Payout (60%):</b> $${totalWinner.toFixed(2)}</li>
          <li><b>Total Seed Paid:</b> $${totalSeed.toFixed(2)}</li>
          <li><b>Total Creator Payout:</b> $${totalCreator.toFixed(2)}</li>
          <li><b>Total Reserve:</b> $${totalReserve.toFixed(2)}</li>
          <li><b>My Profit (Platform + Creator):</b> $${myProfit.toFixed(2)}</li>
          <li><b>Outstanding to Winners:</b> $${outstandingToWinners.toFixed(2)}</li>
          <li><b>Outstanding to Creators:</b> $${outstandingToCreators.toFixed(2)}</li>
        </ul>
        <h2>YTD Totals (This Year)</h2>
        <div style="margin-bottom:1em;">
          <span class="w9notice">NOTICE: You need to send a W-9 request via Tax1099 to anyone whose YTD payout is over $600. When you confirm they have submitted, mark them complete below.</span>
        </div>
        <ul>
          <li><b>Creators:</b>
            <ul>
              ${Object.entries(ytdCreatorsDetails).map(([creator, details]) => {
                const key = `creator:${creator}`;
                if (details.payout > 600) {
                  if (w9Status[key] === 'complete') {
                    return `<li>${creator}: $${details.payout.toFixed(2)} <span class="w9complete">W-9 Complete</span></li>`;
                  } else {
                    return `<li>${creator}: $${details.payout.toFixed(2)}
                      <span class="w9notice">Needs W-9</span>
                      <button onclick="markW9Complete('${key}')">Mark W-9 Complete</button>
                    </li>`;
                  }
                } else {
                  return `<li>${creator}: $${details.payout.toFixed(2)}</li>`;
                }
              }).join('')}
            </ul>
          </li>
          <li><b>Winners:</b>
            <ul>
              ${Object.entries(ytdWinnersDetails).map(([winner, details]) => {
                const key = `winner:${winner}`;
                if (details.payout > 600) {
                  if (w9Status[key] === 'complete') {
                    return `<li>${winner}: $${details.payout.toFixed(2)} <span class="w9complete">W-9 Complete</span></li>`;
                  } else {
                    return `<li>${winner}: $${details.payout.toFixed(2)}
                      <span class="w9notice">Needs W-9</span>
                      <button onclick="markW9Complete('${key}')">Mark W-9 Complete</button>
                    </li>`;
                  }
                } else {
                  return `<li>${winner}: $${details.payout.toFixed(2)}</li>`;
                }
              }).join('')}
            </ul>
          </li>
          <li><b>Platform:</b> $${ytdPlatform.toFixed(2)}</li>
        </ul>
        <h2>Expired Contests</h2>
        <table>
          <tr><th>Title</th><th>Winner</th><th>Winner Payout</th><th>Creator</th><th>Creator Payout</th><th>Owed to Winner</th><th>Owed to Creator</th></tr>
          ${expired.map(c => `<tr>
            <td>${c.title}</td>
            <td>${c.winner}</td>
            <td>$${c.winnerPayout.toFixed(2)}</td>
            <td>${c.creator}</td>
            <td>$${c.creatorPayout.toFixed(2)}</td>
            <td style="color:${c.outstandingToWinner ? '#d00' : '#080'}">$${c.outstandingToWinner.toFixed(2)}</td>
            <td style="color:${c.outstandingToCreator ? '#d00' : '#080'}">$${c.outstandingToCreator.toFixed(2)}</td>
          </tr>`).join('')}
        </table>
        <h2>Open Contests</h2>
        <table>
          <tr><th>Title</th><th>Host</th><th>Entries</th><th>Min</th><th>Seed</th><th>Ends</th></tr>
          ${pending.map(c => `<tr>
            <td>${c.title}</td>
            <td>${c.creator || 'Contests Unlimited'}</td>
            <td>${c.entriesCount}</td>
            <td>${c.min}</td>
            <td>$${c.seed}</td>
            <td>${c.endDate ? new Date(c.endDate).toLocaleString() : ''}</td>
          </tr>`).join('')}
        </table>
        <script>
        async function markW9Complete(key) {
          if (!key) return;
          const confirmed = confirm('Are you sure you want to mark this W-9 as complete?');
          if (!confirmed) return;
          const res = await fetch('/api/admin/mark-w9-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
          });
          if (res.ok) {
            window.location.reload();
          } else {
            alert('Failed to mark W-9 complete');
          }
        }
        </script>
      </body>
      </html>
    `);
    // ----------- END HTML RENDER -----------
  } catch (error) {
    console.error(error);
    res.status(500).send("Failed to load admin dashboard");
  }
});

// --- Winner selection endpoint ---
router.post('/set-winner', express.json(), async (req, res) => {
  const { sessionId, contestName } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  try {
    let uploads = await loadUploads();

    // Allow only one winner per contest: set isWinner true for selected, false for others in same contest
    uploads = uploads.map(u => {
      if (u.contestName === contestName) {
        u.isWinner = (u.sessionId === sessionId);
      }
      return u;
    });

    // Save back to S3
    await s3.putObject({
      Bucket: BUCKET_NAME,
      Key: 'uploads.json',
      Body: JSON.stringify(uploads, null, 2),
      ContentType: 'application/json'
    }).promise();

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to set winner:', err);
    res.status(500).json({ error: 'Failed to set winner' });
  }
});

// --- Mark W9 Complete endpoint ---
router.post('/mark-w9-complete', express.json(), async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const s3W9Key = 'w9-status.json';
  let w9Status = {};
  try {
    // Load existing status
    try {
      const w9Obj = await s3.getObject({ Bucket: BUCKET_NAME, Key: s3W9Key }).promise();
      w9Status = JSON.parse(w9Obj.Body.toString() || '{}');
    } catch (e) {
      w9Status = {};
    }
    w9Status[key] = 'complete';
    await s3.putObject({
      Bucket: BUCKET_NAME,
      Key: s3W9Key,
      Body: JSON.stringify(w9Status, null, 2),
      ContentType: 'application/json'
    }).promise();
    res.json({ success: true });
  } catch (e) {
    console.error('Failed to mark W9 complete:', e);
    res.status(500).json({ error: 'Failed to mark W9 complete' });
  }
});

// --- Snapshot YTDs endpoint ---
router.post('/snapshot-ytds', async (req, res) => {
  try {
    const [uploads, creators] = await Promise.all([
      loadUploads(),
      loadCreators()
    ]);
    // Platform contest titles
    const PLATFORM_TITLES = [
      "Art Contest", "Photo Contest", "Trivia Contest", "Caption Contest"
    ];

    // YTD calculation (same as dashboard)
    const nowDate = new Date();
    const startOfYear = new Date(nowDate.getFullYear(), 0, 1).getTime();
    const uploadsYTD = uploads.filter(u => {
      const ts = new Date(u.timestamp || u.createdAt || u.updatedAt).getTime();
      return ts >= startOfYear;
    });

    const ytdByContest = {};
    uploadsYTD.forEach(u => {
      if (!ytdByContest[u.contestName]) ytdByContest[u.contestName] = [];
      ytdByContest[u.contestName].push(u);
    });

    let ytdCreatorsDetails = {};
    let ytdWinnersDetails = {};

    for (const contestName in ytdByContest) {
      const contestUploads = ytdByContest[contestName];
      const contestInfo = creators.find(c => c.slug === contestName) || {};
      // Determine if platform/default contest
      const isPlatform = PLATFORM_TITLES.includes(contestName) ||
        (!contestInfo.creator || contestInfo.creator.trim().toLowerCase() === "contests unlimited");
      const creator = contestInfo.creator || "Contests Unlimited";
      const creatorEmail = contestInfo.creatorEmail || contestInfo.email || "";
      const creatorName = contestInfo.creator || "";
      const entryFee = 100;
      const totalEntries = contestUploads.length;
      let creatorEarnings = 0, winnerPayout = 0;
      let minEntries = contestInfo.minEntries || 50;
      if (!isPlatform) {
        if (totalEntries <= minEntries) {
          creatorEarnings = totalEntries * entryFee * 0.25;
        } else {
          creatorEarnings = minEntries * entryFee * 0.25 + (totalEntries - minEntries) * entryFee * 0.30;
        }
        ytdCreatorsDetails[creator] = ytdCreatorsDetails[creator] || { name: creatorName, email: creatorEmail, payout: 0 };
        ytdCreatorsDetails[creator].payout += creatorEarnings;
      }
      winnerPayout = totalEntries * entryFee * 0.6;

      const winnerUpload = contestUploads.find(u => u.isWinner);
      if (winnerUpload) {
        const winner = winnerUpload.name || winnerUpload.customerEmail || winnerUpload.sessionId;
        const winnerEmail = winnerUpload.email || winnerUpload.customerEmail || "";
        ytdWinnersDetails[winner] = ytdWinnersDetails[winner] || { name: winner, email: winnerEmail, payout: 0 };
        ytdWinnersDetails[winner].payout += winnerPayout;
      }
    }

    // Save a timestamped snapshot to S3
    const snapshot = {
      timestamp: new Date().toISOString(),
      year: nowDate.getFullYear(),
      creators: ytdCreatorsDetails,
      winners: ytdWinnersDetails
    };

    // Load existing snapshots
    const s3Key = 'ytd-snapshots.json';
    let snapshots = [];
    try {
      const obj = await s3.getObject({ Bucket: BUCKET_NAME, Key: s3Key }).promise();
      snapshots = JSON.parse(obj.Body.toString() || '[]');
    } catch (e) {
      snapshots = [];
    }
    snapshots.push(snapshot);

    await s3.putObject({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(snapshots, null, 2),
      ContentType: 'application/json'
    }).promise();

    res.redirect('/api/admin/dashboard-financials');
  } catch (e) {
    console.error('Failed to snapshot YTDs:', e);
    res.status(500).send('Failed to snapshot YTDs');
  }
});

// --- Automatic Snapshot YTDs at New Year's Eve 11:59:59 PM EST ---
cron.schedule('59 59 23 31 12 *', async () => {
  try {
    const [uploads, creators] = await Promise.all([
      loadUploads(),
      loadCreators()
    ]);
    // Platform contest titles
    const PLATFORM_TITLES = [
      "Art Contest", "Photo Contest", "Trivia Contest", "Caption Contest"
    ];

    // YTD calculation (same as dashboard)
    const nowDate = new Date();
    const startOfYear = new Date(nowDate.getFullYear(), 0, 1).getTime();
    const uploadsYTD = uploads.filter(u => {
      const ts = new Date(u.timestamp || u.createdAt || u.updatedAt).getTime();
      return ts >= startOfYear;
    });

    const ytdByContest = {};
    uploadsYTD.forEach(u => {
      if (!ytdByContest[u.contestName]) ytdByContest[u.contestName] = [];
      ytdByContest[u.contestName].push(u);
    });

    let ytdCreatorsDetails = {};
    let ytdWinnersDetails = {};

    for (const contestName in ytdByContest) {
      const contestUploads = ytdByContest[contestName];
      const contestInfo = creators.find(c => c.slug === contestName) || {};
      // Determine if platform/default contest
      const isPlatform = PLATFORM_TITLES.includes(contestName) ||
        (!contestInfo.creator || contestInfo.creator.trim().toLowerCase() === "contests unlimited");
      const creator = contestInfo.creator || "Contests Unlimited";
      const creatorEmail = contestInfo.creatorEmail || contestInfo.email || "";
      const creatorName = contestInfo.creator || "";
      const entryFee = 100;
      const totalEntries = contestUploads.length;
      let creatorEarnings = 0, winnerPayout = 0;
      let minEntries = contestInfo.minEntries || 50;
      if (!isPlatform) {
        if (totalEntries <= minEntries) {
          creatorEarnings = totalEntries * entryFee * 0.25;
        } else {
          creatorEarnings = minEntries * entryFee * 0.25 + (totalEntries - minEntries) * entryFee * 0.30;
        }
        ytdCreatorsDetails[creator] = ytdCreatorsDetails[creator] || { name: creatorName, email: creatorEmail, payout: 0 };
        ytdCreatorsDetails[creator].payout += creatorEarnings;
      }
      winnerPayout = totalEntries * entryFee * 0.6;

      const winnerUpload = contestUploads.find(u => u.isWinner);
      if (winnerUpload) {
        const winner = winnerUpload.name || winnerUpload.customerEmail || winnerUpload.sessionId;
        const winnerEmail = winnerUpload.email || winnerUpload.customerEmail || "";
        ytdWinnersDetails[winner] = ytdWinnersDetails[winner] || { name: winner, email: winnerEmail, payout: 0 };
        ytdWinnersDetails[winner].payout += winnerPayout;
      }
    }

    // Save a timestamped snapshot to S3
    const snapshot = {
      timestamp: new Date().toISOString(),
      year: nowDate.getFullYear(),
      creators: ytdCreatorsDetails,
      winners: ytdWinnersDetails
    };

    // Load existing snapshots
    const s3Key = 'ytd-snapshots.json';
    let snapshots = [];
    try {
      const obj = await s3.getObject({ Bucket: BUCKET_NAME, Key: s3Key }).promise();
      snapshots = JSON.parse(obj.Body.toString() || '[]');
    } catch (e) {
      snapshots = [];
    }
    snapshots.push(snapshot);

    await s3.putObject({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: JSON.stringify(snapshots, null, 2),
      ContentType: 'application/json'
    }).promise();

    console.log(`[YTD SNAPSHOT]: Successfully snapshotted YTDs at ${snapshot.timestamp}`);
  } catch (e) {
    console.error('[YTD SNAPSHOT]: Failed to snapshot YTDs:', e);
  }
}, {
  timezone: "America/New_York"
});

// --- YTD Snapshots view page ---
router.get('/ytd-snapshots', async (req, res) => {
  try {
    const s3Key = 'ytd-snapshots.json';
    let snapshots = [];
    try {
      const obj = await s3.getObject({ Bucket: BUCKET_NAME, Key: s3Key }).promise();
      snapshots = JSON.parse(obj.Body.toString() || '[]');
    } catch (e) {
      snapshots = [];
    }

    res.send(`
      <html>
      <head>
        <title>YTD Snapshots</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2em; }
          h2 { color: #007849; }
          table { border-collapse: collapse; margin-bottom: 2em; }
          th, td { border: 1px solid #ccc; padding: 8px; }
          th { background: #e6faf1; }
        </style>
      </head>
      <body>
        <h1>YTD Snapshots</h1>
        <nav>
          <a href="/api/admin/dashboard-financials">Dashboard</a> |
          <a href="/api/admin/ytd-snapshots">YTD Snapshots</a> |
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        ${snapshots.length === 0 ? `<p>No YTD snapshots found.</p>` : snapshots.reverse().map(snapshot => `
          <div>
            <h2>Snapshot: ${new Date(snapshot.timestamp).toLocaleString()} (Year: ${snapshot.year})</h2>
            <h3>Creators</h3>
            <table>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Payout</th>
              </tr>
              ${Object.values(snapshot.creators).map(c =>
                `<tr>
                  <td>${c.name || ''}</td>
                  <td>${c.email || ''}</td>
                  <td>$${c.payout.toFixed(2)}</td>
                </tr>`
              ).join('')}
            </table>
            <h3>Winners</h3>
            <table>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Payout</th>
              </tr>
              ${Object.values(snapshot.winners).map(w =>
                `<tr>
                  <td>${w.name || ''}</td>
                  <td>${w.email || ''}</td>
                  <td>$${w.payout.toFixed(2)}</td>
                </tr>`
              ).join('')}
            </table>
          </div>
        `).join('<hr style="margin:2em 0;">')}
      </body>
      </html>
    `);
  } catch (e) {
    console.error('Failed to load YTD snapshots:', e);
    res.status(500).send('Failed to load YTD snapshots');
  }
});

module.exports = router;