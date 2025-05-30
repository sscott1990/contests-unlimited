const express = require('express');
const bcrypt = require('bcrypt');
const AWS = require('aws-sdk');
const router = express.Router();

const s3 = new AWS.S3();
const BUCKET_NAME = 'contests-unlimited';
const CREATORS_KEY = 'creator.json';

function loadJsonFromS3(key, callback) {
  s3.getObject({ Bucket: BUCKET_NAME, Key: key }, (err, data) => {
    if (err) return callback([]);
    try { callback(JSON.parse(data.Body.toString('utf-8'))); }
    catch { callback([]); }
  });
}

router.post('/creator-login', express.urlencoded({ extended: true }), (req, res) => {
  const { email, password } = req.body;
  loadJsonFromS3(CREATORS_KEY, async (creators) => {
    // Use email for login
    const creator = creators.find(c => c.email === email && c.passwordHash);
    if (!creator) return res.send('Invalid email or password');
    const match = await bcrypt.compare(password, creator.passwordHash);
    if (!match) return res.send('Invalid email or password');
    // Redirect to creator dashboard or admin area
    res.redirect(`/api/admin/creator-stats/${creator.slug || creator.contestTitle}`);
  });
});

module.exports = router;