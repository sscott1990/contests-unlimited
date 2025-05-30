const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');
const BUCKET_NAME = process.env.BUCKET_NAME;

// Helper to load creator contests
async function loadCreators() {
  const s3 = new AWS.S3();
  const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: 'creator.json' }).promise();
  return JSON.parse(data.Body.toString());
}

router.get('/contest/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const creators = await loadCreators();
    const contest = creators.find(entry => entry.slug === slug && entry.status === 'approved');

    if (!contest) {
      return res.status(404).send('Contest not found or not approved.');
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${contest.contestName}</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: Arial; padding: 2rem; background: #fff; color: #333; }
          h1 { color: #444; }
          p { margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <h1>${contest.contestName}</h1>
        <p><strong>Creator:</strong> ${contest.name}</p>
        <p><strong>Description:</strong> ${contest.description}</p>
        <p><em>This is a public contest page.</em></p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error loading public contest page:', err);
    res.status(500).send('Internal server error');
  }
});

module.exports = router;
