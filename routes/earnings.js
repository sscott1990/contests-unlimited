const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');
const ENTRIES_BUCKET = process.env.S3_BUCKET_NAME;
const UPLOADS_KEY = 'uploads.json';
const CREATORS_KEY = 'creator.json';

const s3 = new AWS.S3({ region: process.env.AWS_REGION });

async function getUploads() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: UPLOADS_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

async function getCreators() {
  try {
    const data = await s3.getObject({
      Bucket: ENTRIES_BUCKET,
      Key: CREATORS_KEY,
    }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

function parsePrize(prizeModel) {
  if (!prizeModel) return null;
  const match = String(prizeModel).match(/([\d,.]+)/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

const DEFAULT_ENTRY_FEE = 100;

router.get('/creator-earnings/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const creators = await getCreators();
    const uploads = await getUploads();

    const contests = creators.filter(
      c => (c.email || '').toLowerCase() === email
    );

    const results = [];
    let totalProfit = 0;
    for (const contest of contests) {
      // Find contest name for uploads matching this contest
      const contestName = contest.contestTitle || contest.slug;
      const contestUploads = uploads.filter(
        u => u.contestName === contestName
      );
      const entries = contestUploads.length;
      const entryFee = parsePrize(contest.prizeModel) || DEFAULT_ENTRY_FEE;

      // Determine duration, min, seed
      let duration = contest.durationMonths ? parseInt(contest.durationMonths, 10) : 1;
      let minEntries = contest.minEntries;
      if (!minEntries) {
        if (duration === 1) minEntries = 50;
        else if (duration === 3) minEntries = 100;
        else if (duration === 6) minEntries = 150;
        else minEntries = 200;
      }

      // Revised creator revenue logic: 25% per entry up to min, 30% above
      let creatorRevenue = 0;
      if (entries <= minEntries) {
        creatorRevenue = entries * entryFee * 0.25;
      } else {
        creatorRevenue = minEntries * entryFee * 0.25 + (entries - minEntries) * entryFee * 0.30;
      }
      totalProfit += creatorRevenue;

      results.push({
        contestTitle: contest.contestTitle,
        slug: contest.slug,
        prize: contest.prizeModel || "N/A",
        entries,
        entryFee,
        creatorRevenue
      });
    }

    res.json({ 
      totalProfit,
      contests: results 
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch earnings.' });
  }
});

module.exports = router;