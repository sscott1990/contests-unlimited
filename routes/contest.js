const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');
require('dotenv').config();

const s3 = new AWS.S3({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET_NAME;
const CREATORS_KEY = 'creator.json';

// Helper: Load creator submissions from S3
async function loadCreators() {
  try {
    const data = await s3.getObject({
      Bucket: BUCKET,
      Key: CREATORS_KEY,
    }).promise();

    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey') return [];
    throw err;
  }
}

// Public route: /contest/:slug
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const creators = await loadCreators();
    const creator = creators.find(c => c.slug === slug);

    if (!creator) {
      return res.status(404).send('Contest not found');
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>${creator.contestTitle}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2rem; background: #f9f9f9; color: #333; }
          h1 { color: #444; }
          p { margin: 0.5rem 0; }
        </style>
      </head>
      <body>
        <h1>${creator.contestTitle}</h1>
        <p><strong>Hosted by:</strong> ${creator.creator}</p>
        <p><strong>Email:</strong> ${creator.email}</p>
        <p><strong>Description:</strong></p>
        <p>${creator.description}</p>
        <p><strong>Status:</strong> ${creator.status || (creator.approved ? 'approved' : 'pending')}</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading public contest page:', err);
    res.status(500).send('Internal server error');
  }
});

module.exports = router;
