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

// ---- DEFAULT CONTESTS ALWAYS DISPLAYED ----
// Remove slug, use contestTitle as key for all logic
const PLATFORM_CONTESTS = [
  { contestTitle: 'Art Contest' },
  { contestTitle: 'Photo Contest' },
  { contestTitle: 'Trivia Contest' },
  { contestTitle: 'Caption Contest' }
];

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

// Revised prize calculation logic: seed is only counted if min entries reached (at end), or shown as "potential" if ongoing.
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
    // Find the right contest info by slug (for user contests) or by contestTitle (for platform contests)
    let contestInfo = Object.values(contestInfoBySlug).find(
      c => c.slug === contestName || c.contestTitle === contestName
    ) || {};
    const creator = contestInfo.creator || 'Contests Unlimited';
    const isPlatform = isPlatformContest(creator);

    const entryFee = 100;
    const minEntries = 70; // changed from 20 to 70 for both default and creator contests
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

    // Calculate non-pot splits (these always accumulate)
    if (isPlatform) {
      reserve = totalEntries * entryFee * 0.1;
      platformEarnings = totalEntries * entryFee * 0.3;
    } else {
      reserve = totalEntries * entryFee * 0.10;
      creatorEarnings = totalEntries * entryFee * 0.25;
      platformEarnings = totalEntries * entryFee * 0.05;
    }

    // ---- POT/SEED LOGIC ----
    // If contest has ended:
    if (endDateMs && nowMs > endDateMs) {
      if (totalEntries >= minEntries) {
        // Seed is awarded + all entry growth
        pot = seedAmount + (totalEntries * entryFee * 0.6);
        seedIncluded = true;
        seedEligible = true;
      } else {
        // Contest ended & not enough entries: 60% of entry fees only, no seed
        pot = totalEntries * entryFee * 0.6;
        seedIncluded = false;
        seedEligible = false;
      }
    } else {
      // Contest is ongoing (not ended)
      if (totalEntries >= minEntries) {
        // Now eligible: seed + 60% of all entry fees
        pot = seedAmount + (totalEntries * entryFee * 0.6);
        seedIncluded = true;
        seedEligible = true;
      } else if (totalEntries > 0) {
        // Not enough entries yet: show 60% of entry fees (actual), and show "potential" seed as a message
        pot = totalEntries * entryFee * 0.6;
        seedIncluded = false;
        seedEligible = false;
      } else {
        // No entries yet, but show seed as "potential"
        pot = 0;
        seedIncluded = false;
        seedEligible = false;
      }
    }

    // --- Improved contestTitle fallback: prettify contestName if no title ---
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

      const seedAmount = 1000;
      const entryFee = 100;

      let prizes = calculatePrizesByContest(uploads, creatorsArray);

      // ---- INJECT DEFAULT CONTESTS IF MISSING OR ADJUST FOR SEED ----
      for (const def of PLATFORM_CONTESTS) {
        const key = def.contestTitle;
        if (!prizes[key]) {
          // If there are no entries, pot is $0, but potential seed will be messaged
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
            creator: 'Contests Unlimited'
          };
        } else if (prizes[key].isPlatform) {
          // If platform contest exists (with entries), recalc pot for platform default
          let totalEntries = prizes[key].totalEntries || 0;
          let endDateMs = prizes[key].endDateMs || (DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS);
          let nowMs = Date.now();

          let pot = 0;
          if (endDateMs && nowMs > endDateMs) {
            if (totalEntries >= 70) {
              pot = seedAmount + (totalEntries * entryFee * 0.6);
              prizes[key].seedIncluded = true;
              prizes[key].seedEligible = true;
            } else {
              pot = totalEntries * entryFee * 0.6;
              prizes[key].seedIncluded = false;
              prizes[key].seedEligible = false;
            }
          } else {
            if (totalEntries >= 70) {
              pot = seedAmount + (totalEntries * entryFee * 0.6);
              prizes[key].seedIncluded = true;
              prizes[key].seedEligible = true;
            } else if (totalEntries > 0) {
              pot = totalEntries * entryFee * 0.6;
              prizes[key].seedIncluded = false;
              prizes[key].seedEligible = false;
            } else {
              pot = 0;
              prizes[key].seedIncluded = false;
              prizes[key].seedEligible = false;
            }
          }
          prizes[key].pot = pot;
        }
      }

      // Ensure all platform contests have a valid endDateMs for countdowns
      for (const def of PLATFORM_CONTESTS) {
        const key = def.contestTitle;
        if (prizes[key] && !prizes[key].endDateMs) {
          prizes[key].endDateMs = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;
        }
      }

      // ---- DEDUPLICATE/MERGE PLATFORM CONTESTS BY TITLE ----
      for (const def of PLATFORM_CONTESTS) {
        const key = def.contestTitle;
        // Find all contest keys that match this contestTitle and are platform
        const matchingKeys = Object.keys(prizes).filter(prKey =>
          prizes[prKey].isPlatform && prizes[prKey].contestTitle === key && prKey !== key
        );
        if (matchingKeys.length > 0) {
          // Merge all data into the main (canonical) key, then delete the rest
          const base = prizes[key];
          let mergedEntries = base.totalEntries;
          let mergedEndDateMs = base.endDateMs;
          for (const k of matchingKeys) {
            const p = prizes[k];
            mergedEntries += p.totalEntries;
            // Use the later end date if both exist
            if (!mergedEndDateMs || (p.endDateMs && p.endDateMs > mergedEndDateMs)) {
              mergedEndDateMs = p.endDateMs;
            }
            delete prizes[k];
          }
          // After summing entries, recalculate the pot from scratch based on mergedEntries
          base.totalEntries = mergedEntries;
          base.endDateMs = mergedEndDateMs;

          // Correct pot/seed logic for platform contest
          if (base.endDateMs && Date.now() > base.endDateMs) {
            if (mergedEntries >= 70) {
              base.pot = 1000 + (mergedEntries * 60);
              base.seedIncluded = true;
              base.seedEligible = true;
            } else {
              base.pot = mergedEntries * 60;
              base.seedIncluded = false;
              base.seedEligible = false;
            }
          } else {
            if (mergedEntries >= 70) {
              base.pot = 1000 + (mergedEntries * 60);
              base.seedIncluded = true;
              base.seedEligible = true;
            } else if (mergedEntries > 0) {
              base.pot = mergedEntries * 60;
              base.seedIncluded = false;
              base.seedEligible = false;
            } else {
              base.pot = 0;
              base.seedIncluded = false;
              base.seedEligible = false;
            }
          }
        }
      }
      // ---- END DEDUPLICATION ----

      // --- NOW LOAD RULES FROM S3 ---
      loadJsonFromS3('rules.json', (rules) => {
        if (!rules) rules = [];

        // --- PRIZE LIST with improved display ---
        // Always display platform contests first, then others alpha by title
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

        const prizeList = orderedPrizeTitles.map((title) => {
          const data = prizes[title];
          if (!data) return '';
          let seedText = '';
          if (data.seedIncluded && data.seedEligible) {
            seedText = `<span style="color: #070;">(Seeded with $1000!)</span>`;
          } else if (!data.seedIncluded && data.totalEntries < 70 && data.totalEntries > 0) {
            seedText = `<span style="color: #070;">(Seed will be added ONLY if entries reach 70 or more by contest close. Winner always receives 60% of entry fees regardless of entry count.)</span>`;
          } else if (!data.seedIncluded && data.totalEntries === 0) {
            seedText = `<span style="color: #070;">(Seed will be added ONLY if entries reach 70 or more by contest close. Winner always receives 60% of entry fees regardless of entry count.)</span>`;
          } else if (!data.seedIncluded && data.totalEntries > 0 && data.endDateMs && Date.now() > data.endDateMs) {
            seedText = `<span style="color: #b00;">(Seed not awarded - not enough entries. Winner receives 60% of entry fees.)</span>`;
          }
          return `<li>
            <strong>${data.contestTitle}</strong>: $${data.pot.toFixed(2)} — Entries: ${data.totalEntries}
            <em style="color: #666; font-size: 0.9em;">(Hosted by ${data.creator})</em>
            ${seedText}
            <div>Ends in: <span class="countdown" data-endtime="${data.endDateMs}"></span></div>
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
                <em>Each contest is seeded with $1000, but seed is only awarded if there are at least <strong>70 entries</strong> by the time it closes. Each entry is $100, with 60% to the pot (always paid to the winner), 25% to you, 10% to reserve, and 5% to platform.</em>
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
                <li>Each contest is seeded with $1000, but the seed will only be awarded if the contest reaches at least <strong>70 entries</strong> by the time it closes.</li>
                <li><strong>Even if the minimum for the seed is not met, the winner will always receive 60% of all entry fees collected for that contest.</strong></li>
                <li>For custom contests: 60% of each entry fee is added to the prize pot (always paid to winner), 25% goes to the contest creator, 10% is put in reserve, and 5% goes to the platform.</li>
                <li>For platform-run contests: 60% of each entry fee is added to the prize pot (always paid to winner), 10% goes to reserve, and 30% goes to the platform.</li>
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