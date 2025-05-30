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
const DEFAULT_ENTRY_FEE = 1;

router.get('/creator-earnings/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const creators = await getCreators();
    const uploads = await getUploads();

    const contests = creators.filter(
      c => (c.email || '').toLowerCase() === email
    );

    const results = [];
    let totalRevenue = 0;
    for (const contest of contests) {
      const contestUploads = uploads.filter(
        u => u.contestName === contest.slug
      );
      const entryFee = parsePrize(contest.prizeModel) || DEFAULT_ENTRY_FEE;
      const revenue = contestUploads.length * entryFee;
      totalRevenue += revenue;

      results.push({
        contestTitle: contest.contestTitle,
        slug: contest.slug,
        prize: contest.prizeModel || "N/A",
        entries: contestUploads.length,
        revenue: revenue
      });
    }

    res.json({ totalRevenue, contests: results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch earnings.' });
  }
});

module.exports = router;