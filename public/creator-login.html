const express = require('express');
const bcrypt = require('bcrypt');
const AWS = require('aws-sdk');
const router = express.Router();

const s3 = new AWS.S3();
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'contests-unlimited';
const CREATORS_KEY = 'creator.json';

async function getCreators() {
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: CREATORS_KEY }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    return [];
  }
}

router.post('/api/creator-login', express.urlencoded({ extended: true }), async (req, res) => {
  const { email, password } = req.body;
  const creators = await getCreators();
  const creator = creators.find(c => c.email === email && c.passwordHash);
  if (!creator) return res.status(401).send('Invalid email or password');
  const match = await bcrypt.compare(password, creator.passwordHash);
  if (!match) return res.status(401).send('Invalid email or password');
  // You could redirect to a dashboard, or just send success
  res.send(`Welcome, ${creator.creator || creator.email}!`);
});

module.exports = router;