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

// GET /api/trivia?slug=some-contest-slug
router.get('/', async (req, res) => {
  const slug = req.query.slug || "default"; // fallback to "default" trivia

  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: TRIVIA_KEY }).promise();
    const allTrivia = JSON.parse(data.Body.toString('utf-8'));
    const questions = allTrivia[slug] || allTrivia["default"] || [];

    res.json(questions);
  } catch (err) {
    console.error('Error reading trivia questions from S3:', err);
    res.status(500).json({ error: 'Failed to load trivia questions' });
  }
});

module.exports = router;