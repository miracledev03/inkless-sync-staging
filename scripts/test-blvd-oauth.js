/**
 * Read-only check of the Boulevard v2026-06 OAuth app (client credentials).
 * Requests an Admin API token, then queries the business and first location.
 *
 *   node scripts/test-blvd-oauth.js
 *   ENV_FILE=.env.production node scripts/test-blvd-oauth.js
 */
const path = require('path');
const { loadEnvFile, isProductionEnv } = require('../src/config');

const root = path.join(__dirname, '..');
loadEnvFile(path.resolve(root, process.env.ENV_FILE || '.env.staging'));
loadEnvFile(path.join(root, '.env'));

const env = process.env.BLVD_ENV || 'sandbox';
const host = isProductionEnv(env) ? 'https://dashboard.boulevard.io' : 'https://sandbox.joinblvd.com';
const version = process.env.BLVD_API_VERSION || '2026-06';
const clientId = process.env.BLVD_CLIENT_ID;
const clientSecret = process.env.BLVD_CLIENT_SECRET;
const businessId = (process.env.BLVD_BUSINESS_ID || '').replace(/^urn:blvd:Business:/, '');

async function main() {
  const missing = ['BLVD_CLIENT_ID', 'BLVD_CLIENT_SECRET', 'BLVD_BUSINESS_ID'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);

  const resource = `${host}/api/${version}/admin`;
  console.log(`Host: ${host}  API: ${version}  Business: ${businessId}`);

  const tokenRes = await fetch(`${host}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      business_id: businessId,
      resource,
    }),
  });
  const tokenText = await tokenRes.text();
  let tokenBody;
  try {
    tokenBody = JSON.parse(tokenText);
  } catch {
    tokenBody = { raw: tokenText.slice(0, 500) };
  }
  if (!tokenRes.ok || !tokenBody.access_token) {
    console.error(`Token request failed: HTTP ${tokenRes.status}`, tokenBody);
    process.exit(1);
  }
  console.log(
    `Token OK: type=${tokenBody.token_type} expires_in=${tokenBody.expires_in}s scope=${tokenBody.scope || '(not returned)'}`
  );

  const gqlRes = await fetch(resource, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenBody.access_token}`,
    },
    body: JSON.stringify({
      query: '{ business { id name } locations(first: 1) { edges { node { id name } } } }',
    }),
  });
  const gqlBody = await gqlRes.json().catch(() => ({}));
  if (!gqlRes.ok || gqlBody.errors) {
    console.error(`Admin query failed: HTTP ${gqlRes.status}`, JSON.stringify(gqlBody.errors || gqlBody, null, 2));
    process.exit(1);
  }
  const loc = gqlBody.data.locations.edges[0]?.node;
  console.log(`Business: ${gqlBody.data.business.name} (${gqlBody.data.business.id})`);
  console.log(`First location: ${loc ? `${loc.name} (${loc.id})` : '(none)'}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
