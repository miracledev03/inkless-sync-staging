const crypto = require('crypto');

function generateAdminToken(businessId, apiKey, apiSecret) {
  const prefix = 'blvd-admin-v1';
  const timestamp = Math.floor((Date.now() - 1000) / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, 'base64');
  const signature = crypto
    .createHmac('sha256', rawKey)
    .update(payload, 'utf8')
    .digest('base64');
  const token = `${signature}${payload}`;
  return Buffer.from(`${apiKey}:${token}`, 'utf8').toString('base64');
}

function verifyWebhookSignature(rawBody, secretKey, salt, signature) {
  const rawKey = Buffer.from(secretKey, 'base64');
  const payload = `${salt}:${rawBody}`;
  const expected = crypto
    .createHmac('sha256', rawKey)
    .update(payload, 'utf8')
    .digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateAdminToken, verifyWebhookSignature };
