const express = require('express');
const AWS = require('aws-sdk');
const router = express.Router();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const TRIVIA_KEY = 'trivia-contest.json';
const CUSTOM_TRIVIA_KEY = 'custom-trivia.json';

// GET /api/trivia?slug=default
router.get('/', async (req, res) => {
  const slug = req.query.slug || "default"; // fallback to "default" trivia

  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: TRIVIA_KEY }).promise();
    const allTrivia = JSON.parse(data.Body.toString('utf-8'));

    // allTrivia is an array for default, just return it
    res.json(allTrivia);
  } catch (err) {
    console.error('Error reading trivia questions from S3:', err);
    res.status(500).json({ error: 'Failed to load trivia questions' });
  }
});

// GET /api/custom-trivia/by-slug/:slug
router.get('/by-slug/:slug', async (req, res) => {
  const slug = req.params.slug;
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: CUSTOM_TRIVIA_KEY }).promise();
    const triviaSets = JSON.parse(data.Body.toString('utf-8')); // is an array
    const found = triviaSets.find(c => c.slug === slug);
    if (!found) return res.status(404).json({ error: "Trivia not found" });
    res.json({ questions: found.questions });
  } catch (err) {
    console.error('Error reading custom trivia from S3:', err);
    res.status(500).json({ error: 'Failed to load custom trivia' });
  }
});

module.exports = router;