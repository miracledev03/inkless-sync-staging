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

/** Scoped Client API token (B10 cart) — clientUuid is the bare UUID, not URN. */
function generateClientToken(businessId, clientUuid, apiKey, apiSecret) {
  const prefix = 'blvd-client-v1';
  const timestamp = Math.floor((Date.now() - 1000) / 1000);
  const payload = `${prefix}${businessId}${clientUuid}${timestamp}`;
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

/**
 * v2026-06 OAuth webhooks: salt is `blvd-webhook-oauth-v1:<delivery id>:<unix ts>`,
 * HMAC key is the Base64-decoded OAuth client secret.
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyOAuthWebhookSignature(
  rawBody,
  clientSecret,
  salt,
  signature,
  { maxAgeSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}
) {
  const parts = String(salt || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'blvd-webhook-oauth-v1') {
    return { valid: false, reason: 'bad_salt' };
  }
  const ts = Number(parts[2]);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'bad_salt' };
  if (maxAgeSec > 0 && Math.abs(nowSec - ts) > maxAgeSec) {
    return { valid: false, reason: 'stale' };
  }
  if (!verifyWebhookSignature(rawBody, clientSecret, salt, signature)) {
    return { valid: false, reason: 'bad_signature' };
  }
  return { valid: true };
}

module.exports = {
  generateAdminToken,
  generateClientToken,
  verifyWebhookSignature,
  verifyOAuthWebhookSignature,
};
