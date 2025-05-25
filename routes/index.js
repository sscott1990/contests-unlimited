const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// ✅ Load uploads.json
function loadUploads() {
  try {
    // Use absolute path for consistency
    const data = fs.readFileSync(path.join(__dirname, '..', 'uploads.json'));
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading uploads.json:', err);
    return [];
  }
}

// ✅ Calculate prize pool by contest using uploads
function calculatePrizesByContest(uploads) {
  const prizes = {};
  for (const upload of uploads) {
    const contest = upload.contestName || 'Unknown';
    if (!prizes[contest]) prizes[contest] = 0;
    prizes[contest] += 2.5; // $2.50 per valid upload
  }
  return prizes;
}

// ✅ Load contest rules from rules.json (fixed path)
function loadRules() {
  try {
    const data = fs.readFileSync(path.join(__dirname, '..', 'rules.json'));
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading rules.json:', err);
    return [];
  }
}

// ✅ Serve home page with updated jackpot info and contest rules
router.get('/', (req, res) => {
  const uploads = loadUploads();
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
  const contestEndTimestamp = nextYearMidnight.getTime(); // milliseconds

  const prizeList = Object.entries(prizes).map(([contest, total]) =>
    `<li><strong>${contest}</strong>: $${total.toFixed(2)}</li>`
  ).join('');

  // Add countdown span with data-endtime attribute
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
      </style>
    </head>
    <body>
      <h1>Contest Website</h1>
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
      </div>

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


// ✅ API: Return JSON of prize pools by contest
router.get('/api/prize', (req, res) => {
  const uploads = loadUploads();
  const prizes = calculatePrizesByContest(uploads);

  res.json(prizes);
});

module.exports = router;
