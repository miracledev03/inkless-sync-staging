/**
 * Boulevard v2026-06 OAuth (client credentials) token cache.
 * Admin API and Client API tokens have different audiences (`resource`);
 * Client API tokens can also be bound to one client (`blvd_client_id`).
 */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const MAX_CLIENT_TOKENS = 500;

const cache = new Map();
const inflight = new Map();

function bareUuid(id, type) {
  if (!id) return '';
  const s = String(id);
  const prefix = `urn:blvd:${type}:`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function cacheKey(resource, clientUuid) {
  return `${resource}|${clientUuid || ''}`;
}

function evictOldClientTokens() {
  const clientKeys = [...cache.keys()].filter((k) => !k.endsWith('|'));
  if (clientKeys.length <= MAX_CLIENT_TOKENS) return;
  const byExpiry = clientKeys.sort(
    (a, b) => cache.get(a).expiresAt - cache.get(b).expiresAt
  );
  for (const k of byExpiry.slice(0, clientKeys.length - MAX_CLIENT_TOKENS)) {
    cache.delete(k);
  }
}

async function requestToken(config, { resource, clientUuid }) {
  if (!config.blvdClientId || !config.blvdClientSecret) {
    throw new Error('BLVD_CLIENT_ID and BLVD_CLIENT_SECRET are required for BLVD_AUTH_MODE=oauth');
  }
  const body = {
    grant_type: 'client_credentials',
    client_id: config.blvdClientId,
    client_secret: config.blvdClientSecret,
    business_id: bareUuid(config.blvdBusinessId, 'Business'),
    resource,
  };
  if (clientUuid) body.blvd_client_id = clientUuid;

  const res = await fetch(`${config.blvdHost}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: 'non_json', error_description: text.slice(0, 300) };
  }
  if (!res.ok || !payload.access_token) {
    const err = new Error(
      `BLVD token request failed (HTTP ${res.status}): ${payload.error || 'unknown'}${
        payload.error_description ? ` — ${payload.error_description}` : ''
      }`
    );
    err.code = payload.error || 'BLVD_TOKEN';
    err.status = res.status;
    throw err;
  }
  const ttlMs = Number(payload.expires_in || 3600) * 1000;
  return {
    accessToken: payload.access_token,
    scope: payload.scope || '',
    expiresAt: Date.now() + ttlMs,
  };
}

async function getToken(config, { resource, clientId } = {}) {
  const clientUuid = bareUuid(clientId, 'Client');
  const key = cacheKey(resource, clientUuid);
  const hit = cache.get(key);
  if (hit && hit.expiresAt - Date.now() > RENEW_BEFORE_MS) return hit.accessToken;

  if (!inflight.has(key)) {
    inflight.set(
      key,
      requestToken(config, { resource, clientUuid })
        .then((token) => {
          cache.set(key, token);
          if (clientUuid) evictOldClientTokens();
          return token;
        })
        .finally(() => inflight.delete(key))
    );
  }
  return (await inflight.get(key)).accessToken;
}

function getAdminToken(config) {
  return getToken(config, { resource: config.blvdAdminUrl });
}

function getClientApiToken(config, { clientId } = {}) {
  return getToken(config, { resource: config.blvdClientApiUrl, clientId });
}

/** Drop a cached token (e.g. after a 401) so the next call mints a new one. */
function invalidate(resource, clientId) {
  cache.delete(cacheKey(resource, bareUuid(clientId, 'Client')));
}

function clearCache() {
  cache.clear();
}

module.exports = {
  getAdminToken,
  getClientApiToken,
  invalidate,
  clearCache,
  bareUuid,
};
