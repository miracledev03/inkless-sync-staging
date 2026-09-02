const crypto = require('crypto');

const MAX_AGE_MS = 5 * 60 * 1000;

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function decodeUriForV3(uri) {
  const decodeMap = {
    '%3A': ':',
    '%2F': '/',
    '%3F': '?',
    '%40': '@',
    '%21': '!',
    '%24': '$',
    '%27': "'",
    '%28': '(',
    '%29': ')',
    '%2A': '*',
    '%2C': ',',
    '%3B': ';',
  };
  let out = String(uri);
  for (const [enc, plain] of Object.entries(decodeMap)) {
    out = out.split(enc).join(plain);
    out = out.split(enc.toLowerCase()).join(plain);
  }
  return out;
}

function verifyV3({ method, requestUri, rawBody, timestamp, signature, clientSecret }) {
  if (!signature || !timestamp || !clientSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Date.now() - ts);
  if (age > MAX_AGE_MS) return false;

  const uri = decodeUriForV3(requestUri);
  const source = `${method}${uri}${rawBody}${timestamp}`;
  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(source, 'utf8')
    .digest('base64');
  return timingSafeEqualString(expected, signature);
}

function verifyV2({ method, requestUri, rawBody, signature, clientSecret }) {
  if (!signature || !clientSecret) return false;
  const source = `${clientSecret}${method}${requestUri}${rawBody}`;
  const expected = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  return timingSafeEqualString(expected, signature);
}

function verifyV1({ method, requestUri, rawBody, signature, clientSecret }) {
  if (!signature || !clientSecret) return false;
  const source = `${clientSecret}${method}${requestUri}${rawBody}`;
  const expected = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  return timingSafeEqualString(expected, signature);
}

/**
 * Verify HubSpot webhook request (v3 preferred, v2/v1 fallback).
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.requestUri - full URL HubSpot called (https://host/path)
 * @param {string} opts.rawBody
 * @param {object} opts.headers - lower-cased header map
 * @param {string} opts.clientSecret
 */
function verifyHubSpotWebhook(opts) {
  const headers = opts.headers || {};
  const version = headers['x-hubspot-signature-version'];
  const v3Sig = headers['x-hubspot-signature-v3'];
  const v2Sig = headers['x-hubspot-signature'];
  const timestamp = headers['x-hubspot-request-timestamp'];

  if (v3Sig || version === 'v3') {
    return verifyV3({
      method: opts.method,
      requestUri: opts.requestUri,
      rawBody: opts.rawBody,
      timestamp,
      signature: v3Sig,
      clientSecret: opts.clientSecret,
    });
  }
  if (version === 'v2' || v2Sig) {
    return verifyV2({
      method: opts.method,
      requestUri: opts.requestUri,
      rawBody: opts.rawBody,
      signature: v2Sig,
      clientSecret: opts.clientSecret,
    });
  }
  if (version === 'v1') {
    return verifyV1({
      method: opts.method,
      requestUri: opts.requestUri,
      rawBody: opts.rawBody,
      signature: v2Sig,
      clientSecret: opts.clientSecret,
    });
  }
  return false;
}

module.exports = {
  verifyHubSpotWebhook,
  decodeUriForV3,
};
