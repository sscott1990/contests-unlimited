const crypto = require('crypto');
const fs = require('fs');

// Load the raw payload from a file (we'll save the EPD webhook body as JSON)
const rawBody = fs.readFileSync('./payload.json'); // must be raw (not parsed)
const endpointSecret = process.env.EPD_WEBHOOK_SECRET || 'your_webhook_secret_here';
const receivedSignature = process.env.EPD_RECEIVED_SIGNATURE || 'paste_signature_here';

// Hash it using the same method
const hmac = crypto.createHmac('sha256', endpointSecret);
hmac.update(rawBody); // must be Buffer or raw string
const digest = hmac.digest('hex');

// Print debug output
console.log('--- RAW PAYLOAD STRING ---');
console.log(rawBody.toString('utf8'));
console.log('--- SHA256 DIGEST GENERATED ---');
console.log(digest);
console.log('--- SIGNATURE FROM HEADER ---');
console.log(receivedSignature);

// Compare
if (digest === receivedSignature) {
  console.log('✅ Signature matches!');
} else {
  console.log('❌ Signature mismatch.');
}
