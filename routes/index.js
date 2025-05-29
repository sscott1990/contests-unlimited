const express = require('express');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const router = express.Router();

const s3 = new AWS.S3();
const BUCKET_NAME = 'contests-unlimited';

// Load JSON file from S3
function loadJsonFromS3(key, callback) {
  s3.getObject({
    Bucket: BUCKET_NAME,
    Key: key
  }, (err, data) => {
    if (err) {
      console.error(`Error loading ${key} from S3:`, err);
      return callback(null);
    }
    try {
      const json = JSON.parse(data.Body.toString('utf-8'));
      callback(json);
    } catch (e) {
      console.error(`Invalid JSON in ${key}:`, e);
      callback(null);
    }
  });
}

// Calculate prize pool by contest using uploads
function calculatePrizesByContest(uploads) {
  const prizes = {};
  for (const upload of uploads) {
    const contest = upload.contestName || 'Unknown';
    if (!prizes[contest]) prizes[contest] = 0;
    prizes[contest] += 2.5; // $2.50 per valid upload
  }
  return prizes;
}

// Load contest rules from rules.json (local)
function loadRules() {
  try {
    const data = fs.readFileSync(path.join(__dirname, '..', 'rules.json'));
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading rules.json:', err);
    return [];
  }
}

// Serve home page with jackpot info, contest rules, and hosted by info
router.get('/', (req, res) => {
  loadJsonFromS3('uploads.json', (uploads) => {
    if (!uploads) uploads = [];

    loadJsonFromS3('creator.json', (creatorsArray) => {
      if (!Array.isArray(creatorsArray)) creatorsArray = [];

      // Build a map from slug -> {creator, contestTitle}
      const contestInfoMap = {};
      for (const c of creatorsArray) {
        if (c.slug) {
          contestInfoMap[c.slug] = {
            creator: c.creator || 'Contests Unlimited',
            contestTitle: c.contestTitle || c.slug
          };
        }
      }

      const prizes = calculatePrizesByContest(uploads);
      const rules = loadRules();

      // Calculate contest end date = 1 year from today at midnight
      const now = new Date();
      const nextYearMidnight = new Date(
        now.getFullYear() + 1,
        now.getMonth(),
        now.getDate(),
        0, 0, 0, 0
      );
      const contestEndTimestamp = nextYearMidnight.getTime();

      // Build prizeList: show contestTitle and slug + host
      const prizeList = Object.entries(prizes).map(([contestSlug, total]) => {
        const info = contestInfoMap[contestSlug] || { creator: 'Contests Unlimited', contestTitle: contestSlug };
        return `<li>
          <strong>${info.contestTitle} (${contestSlug})</strong>: $${total.toFixed(2)} — Entries: ${Math.floor(total / 2.5)}
          <em style="color: #666; font-size: 0.9em;">(Hosted by ${info.creator})</em>
        </li>`;
      }).join('');

      const rulesHtml = rules.map(r => `
        <div class="rule-card">
          <h3>${r.name}</h3>
          <p>Ends in: <span class="countdown" data-endtime="${contestEndTimestamp}"></span></p>
          <ul>${r.rules.map(rule => `<li>${rule}</li>`).join('')}</ul>
        </div>
      `).join('');

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Contest Website</title>
          <link rel="stylesheet" href="/styles.css">
          <style>
            .rules-container {
              display: flex;
              flex-wrap: wrap;
              gap: 20px;
              margin-top: 30px;
              justify-content: center;
            }
            .rule-card {
              background-color: #ffffff;
              border: 2px solid #007849;
              border-radius: 10px;
              padding: 20px;
              max-width: 300px;
              box-shadow: 0 3px 8px rgba(0,0,0,0.15);
            }
            .rule-card h3 {
              margin-top: 0;
              color: #005b96;
            }
            .rule-card ul {
              padding-left: 20px;
              text-align: left;
            }
            .admin-link {
              position: fixed;
              bottom: 10px;
              left: 10px;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <h1>Contests Unlimited</h1>
          <p>
            <button onclick="window.location.href='/payment.html'" style="padding: 10px 20px; background-color: #007849; color: white; border: none; border-radius: 5px; cursor: pointer;">
              Enter Contest
            </button>
          </p>

          <h2>Current Jackpot Info</h2>
          <ul>${prizeList || '<li>No entries yet</li>'}</ul>

          <h2>Contest Rules</h2>
          <div class="rules-container">
            ${rulesHtml || '<p>No rules available.</p>'}
          </div>

          <!-- New section promoting contest creation -->
          <div style="margin-top: 40px; text-align: center;">
            <h2>Start Your Own Contest</h2>
            <p style="font-size: 1.1em; max-width: 600px; margin: 0 auto;">
              Create your own contest to earn <strong>$1 per entry!</strong><br>
              <em>Subject to approval. Refunds only if denied. You are responsible for chargeback fees.</em>
            </p>
            <p style="margin-top: 20px;">
              <button onclick="window.location.href='/create.html'" style="padding: 12px 24px; background-color: #005b96; color: white; border: none; border-radius: 5px; font-size: 1em; cursor: pointer;">
                Create Contest
              </button>
            </p>
          </div>

          <!-- Original Terms and Conditions Section -->
          <div style="margin-top: 40px; padding: 20px; font-size: 0.85em; color: #555; max-width: 800px; margin-left: auto; margin-right: auto;">
            <h3>Terms and Conditions</h3>
            <ul>
              <li>Each contest entry costs $5.00 USD. The entry fee is non-refundable.</li>
              <li>50% of each entry fee ($2.50) is added to the prize pool for that specific contest.</li>
              <li>Each contest has a unique prize pool that grows with each valid entry.</li>
              <li>At the end of the contest, one winner will be selected and awarded the full prize pool amount.</li>
              <li>Winners will be notified and paid within 7–14 business days after verification.</li>
              <li>Only participants aged 18 and older are eligible to enter.</li>
              <li>Any attempt to manipulate or defraud the contest will result in disqualification.</li>
              <li>By entering, you agree to the official rules and the final decisions of the contest administrators.</li>
            </ul>

            <h3>Refund Policy</h3>
            <p>All contest entry fees are <strong>non-refundable</strong>. Once payment is submitted, no refunds will be issued under any circumstances, including disqualification or withdrawal.</p>

            <h3>Privacy Policy</h3>
            <p>We collect participant information including names, email address, uploaded files, and contest answers solely for the purpose of operating and managing contest entries. All data is securely stored and not shared, sold, or disclosed to third parties. Files are stored in AWS S3 and processed only for contest verification and winner selection. We use this information to ensure contest fairness and compliance. By participating, you consent to this data usage.</p>
          </div>

          <a class="admin-link" href="/api/admin/uploads">Admin</a>

          <script>
            // Countdown script for all contests
            function updateCountdowns() {
              const now = Date.now();
              document.querySelectorAll('.countdown').forEach(el => {
                const endTime = parseInt(el.getAttribute('data-endtime'));
                let diff = endTime - now;

                if (diff <= 0) {
                  el.textContent = 'Contest ended';
                  return;
                }

                const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                diff -= days * (1000 * 60 * 60 * 24);
                const hours = Math.floor(diff / (1000 * 60 * 60));
                diff -= hours * (1000 * 60 * 60);
                const minutes = Math.floor(diff / (1000 * 60));
                diff -= minutes * (1000 * 60);
                const seconds = Math.floor(diff / 1000);

                el.textContent = 
                  (days > 0 ? days + 'd ' : '') +
                  hours.toString().padStart(2, '0') + 'h ' +
                  minutes.toString().padStart(2, '0') + 'm ' +
                  seconds.toString().padStart(2, '0') + 's';
              });
            }

            updateCountdowns();
            setInterval(updateCountdowns, 1000);
          </script>
        </body>
        </html>
      `);
    });
  });
});

// API: Return JSON of prize pools by contest (unchanged)
router.get('/api/prize', (req, res) => {
  loadJsonFromS3('uploads.json', (uploads) => {
    const prizes = uploads ? calculatePrizesByContest(uploads) : {};
    res.json(prizes);
  });
});

module.exports = router;
