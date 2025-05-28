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

router.get('/', async (req, res) => {
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: TRIVIA_KEY }).promise();
    const questions = JSON.parse(data.Body.toString('utf-8')).map(q => ({
      question: q.question,
      options: q.options,
      answer: q.answer
    }));

    res.json(questions);
  } catch (err) {
    console.error('Error reading trivia questions from S3:', err);
    res.status(500).json({ error: 'Failed to load trivia questions' });
  }
});

module.exports = router;
