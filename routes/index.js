const express = require('express');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const router = express.Router();

const s3 = new AWS.S3();
const BUCKET_NAME = 'contests-unlimited';

// === Option 2 fallback start time for default contests ===
const DEFAULT_CONTEST_START = new Date('2025-05-30T14:00:00Z'); // <-- Set to your site "launch" UTC date
const DEFAULT_CONTEST_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

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

// Helper to determine if contest is platform-run
function isPlatformContest(creator) {
  return !creator || (typeof creator === 'string' && creator.trim().toLowerCase() === "contests unlimited");
}

// Main prize calculation logic with correct seed handling
function calculatePrizesByContest(uploads, creatorsArray, nowMs = Date.now()) {
  // Map contestName to array of entries
  const entriesByContest = {};
  for (const upload of uploads) {
    const contest = upload.contestName || 'Unknown';
    if (!entriesByContest[contest]) entriesByContest[contest] = [];
    entriesByContest[contest].push(upload);
  }

  // Build contest info by slug for access to endDate and other props
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
    // Find the right contest info by slug or by contestTitle fallback
    let contestInfo = Object.values(contestInfoBySlug).find(
      c => c.slug === contestName || c.contestTitle === contestName
    ) || {};
    const creator = contestInfo.creator || 'Contests Unlimited';
    const isPlatform = isPlatformContest(creator);

    const entryFee = 100;
    const minEntries = 20;
    const seedAmount = 1000;

    let totalEntries = entries.length;
    let pot = 0, reserve = 0, creatorEarnings = 0, platformEarnings = 0;
    let seedIncluded = false;
    let seedEligible = false;

    // Find contest end time (ms)
    let endDateMs = null;
    if (contestInfo.endDate) {
      endDateMs = new Date(contestInfo.endDate).getTime();
    }

    // For each entry, split $100 according to contest type
    for (let i = 0; i < totalEntries; i++) {
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

    // SEED LOGIC: Only remove seed if contest is over and not enough entries.
    if (totalEntries > 0) {
      if (endDateMs && nowMs > endDateMs) {
        // Contest ended
        if (totalEntries >= minEntries) {
          pot += seedAmount;
          seedIncluded = true;
          seedEligible = true;
        } else {
          // Seed not included, contest ended and not enough entries
          seedIncluded = false;
          seedEligible = false;
        }
      } else {
        // Contest ongoing: seed is potentially available
        pot += seedAmount;
        seedIncluded = true;
        seedEligible = false; // Not yet eligible, but showing as "potential"
      }
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
      contestTitle: contestInfo.contestTitle || contestName,
      creator: contestInfo.creator || 'Contests Unlimited',
    };
  }
  return prizes;
}

// Route: main homepage with prize info
router.get('/', (req, res) => {
  loadJsonFromS3('uploads.json', (uploads) => {
    if (!uploads) uploads = [];

    loadJsonFromS3('creator.json', (creatorsArray) => {
      if (!Array.isArray(creatorsArray)) creatorsArray = [];

      // Build a map from slug -> {creator, contestTitle, endDate}
      const contestInfoMap = {};
      for (const c of creatorsArray) {
        if (c.slug) {
          contestInfoMap[c.slug] = {
            creator: c.creator || 'Contests Unlimited',
            contestTitle: c.contestTitle || c.slug,
            endDate: c.endDate ? new Date(c.endDate).getTime() : null
          };
        }
      }

      const prizes = calculatePrizesByContest(uploads, creatorsArray);

      // --- NOW LOAD RULES FROM S3 ---
      loadJsonFromS3('rules.json', (rules) => {
        if (!rules) rules = [];

        // --- PRIZE LIST with fallback countdown ---
        const prizeList = Object.entries(prizes).map(([contestName, data]) => {
          // Find matching contest info by name
          let info = contestInfoMap[contestName];
          // fallback if missing
          if (!info) {
          // Try to match by contestTitle (for legacy)
            info = Object.values(contestInfoMap).find(i => i.contestTitle === contestName);
}
          let endDateMs;
          if (info && info.endDate) {
            endDateMs = info.endDate;
          } else {
            // Fallback for default contests: use 1 year from fixed deploy date
            endDateMs = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;
            info = {
              creator: 'Contests Unlimited',
              contestTitle: contestName
            };
          }
          // Show prize pool and entry count, and note if seed is included/removed
          let seedText = '';
          // If contest is ongoing and at least 1 entry, show seed as "potential"
          if (data.seedIncluded && !data.seedEligible) {
            seedText = `<span style="color: #070;">(Seeded with $1000 if 20+ entries by contest close)</span>`;
          } else if (data.seedIncluded && data.seedEligible) {
            // Contest ended, seed included
            seedText = `<span style="color: #070;">(Seeded with $1000!)</span>`;
          } else if (!data.seedIncluded && data.totalEntries > 0 && data.endDateMs && Date.now() > data.endDateMs) {
            // Contest ended, seed removed
            seedText = `<span style="color: #b00;">(Seed removed - not enough entries)</span>`;
          }
          return `<li>
            <strong>${info.contestTitle} (${contestName})</strong>: $${data.pot.toFixed(2)} — Entries: ${data.totalEntries}
            <em style="color: #666; font-size: 0.9em;">(Hosted by ${info.creator})</em>
            ${seedText}
            <div>Ends in: <span class="countdown" data-endtime="${endDateMs}"></span></div>
          </li>`;
        }).join('');

        // --- RULE CARDS: no timer shown ---
        const rulesHtml = rules.map(r => `
          <div class="rule-card">
            <h3>${r.name}</h3>
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
                Create your own contest to earn <strong>25% of all entry fees!</strong><br>
                <em>Each contest is seeded with $1000, but seed is only awarded if there are at least 20 entries by contest close. Each entry is $100, with 60% to the pot, 25% to you, 10% to reserve, and 5% to platform.</em>
              </p>
              <p style="margin-top: 20px;">
                <button onclick="window.location.href='/create.html'" style="padding: 12px 24px; background-color: #005b96; color: white; border: none; border-radius: 5px; font-size: 1em; cursor: pointer;">
                  Create Contest
                </button>
              </p>
              <p style="margin-top: 10px;">
                <button onclick="window.location.href='/creator-login.html'" style="padding: 10px 20px; background-color: #333; color: white; border: none; border-radius: 5px; font-size: 0.95em; cursor: pointer;">
                  Creator Login
                </button>
              </p>
            </div>

            <div style="margin-top: 40px; padding: 20px; font-size: 0.85em; color: #555; max-width: 800px; margin-left: auto; margin-right: auto;">
              <h3>Terms and Conditions</h3>
              <ul>
                <li>Each contest entry costs <strong>$100.00 USD</strong>. The entry fee is non-refundable.</li>
                <li>Each contest is seeded with $1000, but the seed will only be awarded if the contest reaches at least 20 entries by the time it closes.</li>
                <li>For custom contests: 60% of each entry fee is added to the prize pot, 25% goes to the contest creator, 10% is put in reserve, and 5% goes to the platform.</li>
                <li>For platform-run contests: 60% of each entry fee is added to the prize pot, 10% goes to reserve, and 30% goes to the platform.</li>
                <li>Each contest has a unique prize pool that grows with each valid entry and seed (if qualified).</li>
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
              // Countdown script for all contests (prize list)
              function updateCountdowns() {
                const now = Date.now();
                document.querySelectorAll('.countdown').forEach(el => {
                  const endTime = parseInt(el.getAttribute('data-endtime'));
                  if (!endTime) {
                    el.textContent = 'No end date set';
                    return;
                  }
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
});

// API: Return JSON of prize pools by contest (updated)
router.get('/api/prize', (req, res) => {
  loadJsonFromS3('uploads.json', (uploads) => {
    loadJsonFromS3('creator.json', (creatorsArray) => {
      const prizes = uploads ? calculatePrizesByContest(uploads, creatorsArray) : {};
      res.json(prizes);
    });
  });
});

module.exports = router;