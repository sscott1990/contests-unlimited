const express = require('express');
const AWS = require('aws-sdk');
const router = express.Router();
const { loadJSONFromS3 } = require('../utils/s3Utils');
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

// HTML view of entries with search bar (name, email, address, contest, date)
router.get('/entries-view', async (req, res) => {
  try {
    const entries = await loadEntries();
    const creators = await loadCreators();
    if (!entries || entries.length === 0) {
      return res.send('<h2>No entries found</h2>');
    }

    // --- SEARCH LOGIC ---
    const search = (req.query.search || '').trim().toLowerCase();
    let filteredEntries = entries;
    if (search) {
      filteredEntries = entries.filter(entry => {
        // Construct name, email, address as below for search as well
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

    const rows = paginatedEntries.map(entry => {
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
      const date = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
      return `
        <tr>
          <td>${name}</td>
          <td>${email}</td>
          <td>${address}</td>
          <td>${contest}</td>
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
        </style>
      </head>
      <body>
        <h1>Admin Panel</h1>
        <nav>
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
              <th>Contest</th>
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

    // Add host/creator lookup logic
    const uploadsWithHost = uploadsWithPresignedUrls.map(upload => {
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

    const rows = uploadsWithHost.map(upload => {
      const date = new Date(upload.timestamp).toLocaleString();
      const filename = upload.fileUrl ? upload.fileUrl.split('/').pop() : 'No file';
      const viewUrl = upload.presignedUrl;

      return `
        <tr>
          <td>${upload.name || ''}</td>
          <td>${upload.contestName || ''}</td>
          <td>${upload.host || ''}</td>
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
          div.pagination { margin-top: 1rem; }
          .search-bar { margin-bottom: 1rem; }
          .search-bar input { padding: 6px 10px; font-size: 1em; min-width: 200px; }
          .search-bar button { padding: 6px 14px; }
        </style>
      </head>
      <body>
        <h1>Admin Panel</h1>
        <nav>
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

// Trivia results view with search bar and host
router.get('/trivia', async (req, res) => {
  try {
    const uploads = await loadUploads();
    const creators = await loadCreators();
    const triviaData = await loadJSONFromS3('trivia-contest.json');
    const correctAnswers = triviaData.map(q => q.answer);

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

    // Updated logic to support correctCount fallback if triviaAnswers is missing
    const scored = filteredUploads
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
        // Host lookup
        let host = "Contests Unlimited";
        if (creators && creators.length) {
          const found = creators.find(c =>
            (c.slug && entry.contestName === c.slug) ||
            (c.contestTitle && entry.contestName === c.contestTitle)
          );
          if (found && found.creator) host = found.creator;
        }
        return { ...entry, score, host };
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
        <td>${entry.score} / ${correctAnswers.length}</td>
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

// Creators view with search bar and host
router.get('/creators', async (req, res) => {
  try {
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
        (c.description || '').toLowerCase().includes(search) ||
        (c.slug || '').toLowerCase().includes(search)
      );
    }

    const page = parseInt(req.query.page) || 1;
    const perPage = 25;
    const totalCreators = filteredCreators.length;
    const totalPages = Math.ceil(totalCreators / perPage);
    const start = (page - 1) * perPage;
    const paginatedCreators = filteredCreators.slice(start, start + perPage);

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
        </style>
      </head>
      <body>
        <h1>Contest Creators</h1>
        <nav>
          <a href="/api/admin/uploads">Uploads</a> |
          <a href="/api/admin/entries-view">Entries</a> |
          <a href="/api/admin/trivia">Trivia Results</a> |
          <a href="/api/admin/creators">Creators</a> |
          <a href="/api/admin/logout">Logout</a>
        </nav>
        <form class="search-bar" method="get" action="/api/admin/creators">
          <input type="text" name="search" value="${search.replace(/"/g, "&quot;")}" placeholder="Search by name, email, or contest..." />
          <button type="submit">Search</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Contest Name</th>
              <th>Description</th>
              <th>Submitted</th>
              <th>Status</th>
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
    const minEntries = 20;
    const seedAmount = 1000;

    // Prize calculation
    let pot = 0, reserve = 0, creatorEarnings = 0, platformEarnings = 0, seedInPot = false;
    // Add seed if at least one entry
    if (numEntries > 0) {
      pot += seedAmount;
      seedInPot = true;
    }
    // Remove seed if not enough entries
    if (numEntries < minEntries && seedInPot) {
      pot -= seedAmount;
      seedInPot = false;
    }
    // Split per entry
    for (let i = 0; i < numEntries; i++) {
      if (isPlatform) {
        pot += entryFee * 0.6;
        reserve += entryFee * 0.1;
        platformEarnings += entryFee * 0.3;
      } else {
        pot += entryFee * 0.6;
        creatorEarnings += entryFee * 0.25;
        reserve += entryFee * 0.10;
        platformEarnings += entryFee * 0.05;
      }
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
        </style>
      </head>
      <body>
        <h1>Stats for "${contestName}"</h1>
        <div class="stat"><strong>Number of Entries:</strong> ${numEntries}</div>
        <div class="stat"><strong>Current Prize Pot:</strong> $${pot < 0 ? 0 : pot.toFixed(2)} ${seedInPot ? '(Seeded)' : (numEntries > 0 && numEntries < 20 ? '(Seed removed - not enough entries)' : '')}</div>
        <div class="stat"><strong>Reserve:</strong> $${reserve.toFixed(2)}</div>
        <div class="stat"><strong>Creator Earnings:</strong> $${creatorEarnings.toFixed(2)}</div>
        <div class="stat"><strong>Platform Earnings:</strong> $${platformEarnings.toFixed(2)}</div>
        <div class="stat"><strong>Contest Type:</strong> ${isPlatform ? 'Platform (Contests Unlimited)' : 'Custom'}</div>
        <div class="stat"><strong>Seed Rule:</strong> $1000 is seeded in the prize pot if there is at least 1 entry, but removed if the contest does not reach 20 entries.</div>
        <div class="stat"><strong>Split:</strong> ${
          isPlatform
            ? "60% pot, 10% reserve, 30% platform"
            : "60% pot, 25% creator, 10% reserve, 5% platform"
        }</div>
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

  if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });

  try {
    const creators = await loadCreators();
    const index = creators.findIndex(entry => entry.id === id || entry.timestamp === id);

    if (index === -1) return res.status(404).json({ error: 'Submission not found' });

    creators[index].status = status;

    let slug = null;
    if (status === 'approved') {
      slug = slugify(`${creators[index].contestTitle}-${Date.now()}`, { lower: true, strict: true });
      creators[index].slug = slug;
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

module.exports = router;