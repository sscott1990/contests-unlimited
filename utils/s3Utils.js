const AWS = require('aws-sdk');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function loadJSONFromS3(key) {
  try {
    const data = await s3.getObject({ Bucket: BUCKET_NAME, Key: key }).promise();
    return JSON.parse(data.Body.toString('utf-8'));
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.code === 'NotFound') {
      return [];
    }
    console.error(`Error loading ${key} from S3:`, err);
    throw err;
  }
}

async function saveJSONToS3(key, jsonData) {
  try {
    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(jsonData, null, 2),
      ContentType: 'application/json',
    };
    await s3.putObject(params).promise();
  } catch (err) {
    console.error(`Error saving ${key} to S3:`, err);
    throw err;
  }
}

module.exports = { loadJSONFromS3, saveJSONToS3 };
