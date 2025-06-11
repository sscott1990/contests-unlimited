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
const PLATFORM_CONTESTS = [
  { contestTitle: 'Art Contest' },
  { contestTitle: 'Photo Contest' },
  { contestTitle: 'Trivia Contest' },
  { contestTitle: 'Caption Contest' }
];

// Map default contest slugs to their titles (expanded for robust mapping, including legacy values)
const PLATFORM_SLUG_MAP = {
  "art-contest-default": "Art Contest",
  "Art Contest": "Art Contest",
  "photo-contest-default": "Photo Contest",
  "Photo Contest": "Photo Contest",
  "trivia-contest-default": "Trivia Contest",
  "Trivia Contest": "Trivia Contest",
  "caption-contest-default": "Caption Contest",
  "Caption Contest": "Caption Contest"
};

// Seed/minimum settings by duration (in months)
const CREATOR_CONTEST_SEED_MATRIX = [
  { months: 1, seed: 250, min: 50 },
  { months: 3, seed: 500, min: 100 },
  { months: 6, seed: 750, min: 150 },
  { months: 12, seed: 1000, min: 200 },
];

const DEFAULT_CONTEST_SEED = 1000;
const DEFAULT_CONTEST_MIN = 200; // CHANGED to match new 1-year min

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

// Helper for seed/minimum logic for creators
function getSeedAndMin(durationMonths, isPlatform) {
  if (isPlatform) {
    return { seed: DEFAULT_CONTEST_SEED, min: DEFAULT_CONTEST_MIN };
  }
  const found = CREATOR_CONTEST_SEED_MATRIX.find(e => e.months === durationMonths);
  if (found) return { seed: found.seed, min: found.min };
  // fallback: use 1 month settings if not specified
  return { seed: 250, min: 50 };
}

// --- MAIN LOGIC PATCHED ---
function calculatePrizesByContest(uploads, creatorsArray, nowMs = Date.now()) {
  const entriesByContest = {};
  for (const upload of uploads) {
    let rawContestName = upload.contestName;
    if (Array.isArray(rawContestName)) rawContestName = rawContestName[0];

    // PATCH: Ensure platform contests and custom contests never overwrite each other
    let contestKey;
    if (PLATFORM_SLUG_MAP[rawContestName]) {
      contestKey = PLATFORM_SLUG_MAP[rawContestName];
    } else if (upload.contestSlug) {
      contestKey = `custom:${upload.contestSlug}`;
    } else if (upload.slug) {
      contestKey = `custom:${upload.slug}`;
    } else {
      contestKey = rawContestName || 'Unknown';
    }

    if (!entriesByContest[contestKey]) entriesByContest[contestKey] = [];
    entriesByContest[contestKey].push(upload);
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
  for (const contestKey in entriesByContest) {
    const entries = entriesByContest[contestKey];

    let isPlatform = false;
    let contestInfo = null;
    let displayTitle = contestKey;
    let creator = 'Contests Unlimited';
    let endDateMs = null;

    if (PLATFORM_CONTESTS.some(c => c.contestTitle === contestKey)) {
      isPlatform = true;
      displayTitle = contestKey;
    } else {
      let slug = contestKey.startsWith("custom:") ? contestKey.slice(7) : contestKey;
      contestInfo = contestInfoBySlug[slug];
      if (contestInfo) {
        creator = contestInfo.creator || 'Contests Unlimited';
        displayTitle = contestInfo.contestTitle || slug;
        if (contestInfo.endDate) endDateMs = new Date(contestInfo.endDate).getTime();
      }
    }
    if (!contestInfo && !isPlatform) contestInfo = {};

    const entryFee = 100;
    let durationMonths = 12;
    let seedAmount = DEFAULT_CONTEST_SEED;
    let minEntries = DEFAULT_CONTEST_MIN;
    if (isPlatform) {
      durationMonths = 12;
      seedAmount = DEFAULT_CONTEST_SEED;
      minEntries = DEFAULT_CONTEST_MIN;
      endDateMs = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;
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

    prizes[contestKey] = {
      totalEntries,
      pot: pot < 0 ? 0 : pot,
      reserve,
      creatorEarnings,
      platformEarnings,
      seedIncluded,
      seedEligible,
      isPlatform,
      endDateMs,
      contestTitle: displayTitle || contestKey,
      creator: creator,
      seedAmount,
      minEntries,
      durationMonths
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

      let prizes = calculatePrizesByContest(uploads, creatorsArray);

      // ---- INJECT DEFAULT CONTESTS IF MISSING OR ADJUST FOR SEED ----
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
        } else if (prizes[key].isPlatform) {
          let totalEntries = prizes[key].totalEntries || 0;
          let endDateMs = prizes[key].endDateMs || (DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS);
          let nowMs = Date.now();
          let pot = 0;
          if (endDateMs && nowMs > endDateMs) {
            if (totalEntries >= DEFAULT_CONTEST_MIN) {
              pot = DEFAULT_CONTEST_SEED + (totalEntries * 100 * 0.6);
              prizes[key].seedIncluded = true;
              prizes[key].seedEligible = true;
            } else {
              pot = totalEntries * 100 * 0.6;
              prizes[key].seedIncluded = false;
              prizes[key].seedEligible = false;
            }
          } else {
            if (totalEntries >= DEFAULT_CONTEST_MIN) {
              pot = DEFAULT_CONTEST_SEED + (totalEntries * 100 * 0.6);
              prizes[key].seedIncluded = true;
              prizes[key].seedEligible = true;
            } else if (totalEntries > 0) {
              pot = totalEntries * 100 * 0.6;
              prizes[key].seedIncluded = false;
              prizes[key].seedEligible = false;
            } else {
              pot = 0;
              prizes[key].seedIncluded = false;
              prizes[key].seedEligible = false;
            }
          }
          prizes[key].pot = pot;
          prizes[key].seedAmount = DEFAULT_CONTEST_SEED;
          prizes[key].minEntries = DEFAULT_CONTEST_MIN;
          prizes[key].durationMonths = 12;
        }
      }

      // Ensure all platform contests have a valid endDateMs for countdowns
      for (const def of PLATFORM_CONTESTS) {
        const key = def.contestTitle;
        if (prizes[key] && !prizes[key].endDateMs) {
          prizes[key].endDateMs = DEFAULT_CONTEST_START.getTime() + DEFAULT_CONTEST_DURATION_MS;
        }
      }

      // --- PATCH: REMOVE DEDUPLICATION/MERGE LOGIC ---
      // (Do NOT merge by contestTitle. Each contestKey is unique for platform or custom.)

      // --- PRIZE LIST order: always display platform contests first, then others alpha by title ---
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
          seedText = `<span style="color: #070;">(Seeded with $${data.seedAmount}!)</span>`;
        } else if (!data.seedIncluded && data.totalEntries < data.minEntries && data.totalEntries > 0) {
          seedText = `<span style="color: #070;">(Seed will be added ONLY if entries reach ${data.minEntries} or more by contest close. Winner always receives 60% of entry fees regardless of entry count.)</span>`;
        } else if (!data.seedIncluded && data.totalEntries === 0) {
          seedText = `<span style="color: #070;">(Seed will be added ONLY if entries reach ${data.minEntries} or more by contest close. Winner always receives 60% of entry fees regardless of entry count.)</span>`;
        } else if (!data.seedIncluded && data.totalEntries > 0 && data.endDateMs && Date.now() > data.endDateMs) {
          seedText = `<span style="color: #b00;">(Seed not awarded - not enough entries. Winner receives 60% of entry fees.)</span>`;
        }
        let durationText = data.isPlatform ? '1 year' : (data.durationMonths === 1 ? '1 month' : `${data.durationMonths} months`);
        return `<li>
          <strong>${data.contestTitle}</strong>: $${data.pot.toFixed(2)} — Entries: ${data.totalEntries} — Duration: ${durationText}
          <em style="color: #666; font-size: 0.9em;">(Hosted by ${data.creator})</em>
          ${seedText}
          <div>Ends in: <span class="countdown" data-endtime="${data.endDateMs}"></span></div>
        </li>`;
      }).join('');

      // --- RULE CARDS: no timer shown ---
      loadJsonFromS3('rules.json', (rules) => {
        if (!rules) rules = [];

        const rulesHtml = rules.map(r => `
          <div class="rule-card">
            <h3>${r.name}</h3>
            <ul>${r.rules.map(rule => `<li>${rule}</li>`).join('')}</ul>
          </div>
        `).join('');

        // --- Judging Criteria Section ---
        const judgingCriteriaHtml = `
        <div style="margin-top: 40px; margin-bottom: 30px; background: #f5f9f7; border-left: 5px solid #0BD992; border-radius: 8px; padding: 18px 22px; max-width: 750px; margin-left: auto; margin-right: auto;">
          <h2>Judging Criteria</h2>
          <ul style="font-size:1.07em; color:#222;">
            <li><b>Art Contest:</b> Creativity and originality, artistic technique and skill, adherence to theme or prompt, overall impression.</li>
            <li><b>Photo Contest:</b> Creativity and originality, technical quality (focus, lighting, composition), relevance to theme or prompt, overall impact.</li>
            <li><b>Caption Contest:</b> Creativity, wit, or humor; relevance to the image or prompt; clarity and conciseness.</li>
            <li><b>Trivia Contest:</b> Number of correct answers, speed of response (if applicable). Top scorer or fastest correct responder wins; no random selection.</li>
          </ul>
          <div style="color:#555; font-size:0.96em; margin-top:8px;">All judging is performed solely by the contest administrator, based on these published criteria. The administrator’s decisions are final.</div>
        </div>
        `;

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
              .gallery-link {
                position: fixed;
                bottom: 10px;
                right: 10px;
                font-size: 14px;
              }
              /* Scrollable prize/host info section */
              .contest-info-scroll {
                max-height: 350px;
                overflow-y: auto;
                border: 1px solid #ddd;
                border-radius: 6px;
                background: #fafbfd;
                padding: 16px;
                margin: 20px 0 30px 0;
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

            <h2>Current Prize Info</h2>
            <div class="contest-info-scroll">
              <ul>${prizeList || '<li>No entries yet</li>'}</ul>
            </div>

<!-- Judging Criteria Block -->
${judgingCriteriaHtml}

<!-- Seed/Minimum Matrix Section -->
<div style="margin: 35px auto 14px auto; text-align:center; max-width:550px; background:#ecf7f2; border-left:5px solid #007849; border-radius:8px; padding:14px 16px;">
  <b>Seed Amounts & Entry Minimums:</b>
  <ul style="list-style:none; padding-left:0; font-size:1.07em; margin:8px 0 0 0; color:#222;">
    <li>1 month: <b>$250 seed</b>, 50 entries minimum</li>
    <li>3 months: <b>$500 seed</b>, 100 entries minimum</li>
    <li>6 months: <b>$750 seed</b>, 150 entries minimum</li>
    <li>1 year: <b>$1000 seed</b>, 200 entries minimum</li>
  </ul>
  <span style="font-size:0.97em; color:#007849;">Seed is added to the prize pot if the minimum is met by contest close. Winner always receives 60% of entry fees regardless.</span>
</div>

            <h2>Contest Rules</h2>
            <div class="rules-container">
              ${rulesHtml || '<p>No rules available.</p>'}
            </div>

            <!-- New section promoting contest creation -->
            <div style="margin-top: 40px; text-align: center;">
              <h2>Start Your Own Contest</h2>
              <p style="font-size: 1.1em; max-width: 600px; margin: 0 auto;">
                Create your own contest to earn <strong>25% of each entry up to the minimum, and 30% of every entry above the minimum!</strong><br>
                <em>
                  Choose your contest duration:<br>
                  1 month: $250 seed, 50 entries minimum<br>
                  3 months: $500 seed, 100 entries minimum<br>
                  6 months: $750 seed, 150 entries minimum<br>
                  1 year: $1000 seed, 200 entries minimum<br>
                  <br>
                  <strong>Winner always receives 60% of entry fees, plus the seed if the minimum is met. Creators earn 25% for each entry up to the minimum, and 30% for every entry above the minimum.</strong>
                </em>
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

            <div style="margin:28px 0 0 0; background:#f9f9ff; border-left:4px solid #005b96; border-radius:6px; padding:14px 18px;">
      <b>Eligibility, Payments & Tax Requirements:</b>
      <ul style="margin:10px 0 0 15px;">
        <li>Contest winners and creators must be U.S. citizens, legal residents, or legal entities (such as businesses) with a valid U.S. tax identification number (SSN, TIN, or EIN).</li>
        <li>Before any winner or creator payments totaling $600 or more in a calendar year can be issued, you must submit a completed IRS Form W-9. Failure to provide required tax documentation will result in forfeiture of creator payments exceeding this threshold.</li>
        <li>All winner and creator earnings are reported in accordance with IRS regulations.</li>
      </ul>
    </div>

            <div style="margin-top: 40px; padding: 20px; font-size: 0.85em; color: #555; max-width: 800px; margin-left: auto; margin-right: auto;">
              <h3>Terms and Conditions</h3>
              <ul>
                <li>Each contest entry costs <strong>$100.00 USD</strong>. The entry fee is non-refundable.</li>
                <li>Each contest is seeded according to its duration:<br>
                  1 month: $250 seed, 50 entries minimum<br>
                  3 months: $500 seed, 100 entries minimum<br>
                  6 months: $750 seed, 150 entries minimum<br>
                  1 year: $1000 seed, 200 entries minimum<br>
                </li>
                <li><strong>Even if the minimum for the seed is not met, the winner will always receive 60% of all entry fees collected for that contest.</strong></li>
                <li>For custom contests: 60% of each entry fee is added to the prize pot (always paid to winner), 25% goes to the contest creator for each entry up to the minimum, 30% for each entry above the minimum, 10% is put in reserve, and 5% goes to the platform.</li>
                <li>For platform-run contests: 60% of each entry fee is added to the prize pot (always paid to winner), 10% goes to reserve, and 30% goes to the platform.</li>
                <li>Each contest has a unique prize pool that grows with each valid entry and seed (if qualified).</li>
                <li>At the end of the contest, one winner will be selected and awarded the full prize pool amount.</li>
                <li>Winners will be notified and paid within 7–14 business days after verification.</li>
                <li>Only participants aged 18 and older are eligible to enter.</li>
                <li>Any attempt to manipulate or defraud the contest will result in disqualification.</li>
                <li>By entering, you agree to the official rules and the final decisions of the contest administrators.</li>
                <li><strong>Judging Criteria:</strong> Winners are selected based solely on skill, creativity, accuracy, or merit as outlined in the contest description. No element of chance is used to determine winners. Judging is performed according to clear and objective criteria by the contest administrator. All entries will be judged solely by the contest administrator. The administrator’s decisions are final and based on the published judging criteria.</li>
              </ul>
              <h3>Refund Policy</h3>
              <p>All contest entry fees are <strong>non-refundable</strong>. Once payment is submitted, no refunds will be issued under any circumstances, including disqualification or withdrawal.</p>
              <h3>Privacy Policy</h3>
              <p>We collect participant information including names, email address, uploaded files, and contest answers solely for the purpose of operating and managing contest entries. All data is securely stored and not shared, sold, or disclosed to third parties. Files are stored in AWS S3 and processed only for contest verification and winner selection. We use this information to ensure contest fairness and compliance. By participating, you consent to this data usage.</p>
            </div>

            <a class="admin-link" href="/api/admin/uploads">Admin</a>
            <a class="gallery-link" href="/gallery">Gallery</a>

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