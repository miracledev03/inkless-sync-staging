/**
 * Verify qualify path: POST /create-client → BLVD Client ID + Acquisition Deal.
 *
 * Usage:
 *   npm run verify:qualify -- <contactId>
 *   npm run verify:qualify -- <contactId> --staging
 */
const { getConfig } = require('../src/config');
const { processQualifyPath } = require('../src/handlers/clients');

const STAGING =
  process.env.STAGING_BASE_URL ||
  'https://inkless-sync-staging-rubetech.onrender.com';

async function verifyRemote(contactId) {
  const warm = await fetch(`${STAGING}/health`);
  if (!warm.ok) throw new Error(`staging health failed: ${warm.status}`);

  const res = await fetch(`${STAGING}/create-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`create-client ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function checkResult(result) {
  const checks = [];
  const blvdId = result.blvd?.blvdClientId || result.blvdClientId;
  checks.push({
    name: 'BLVD Client ID',
    ok: Boolean(blvdId),
    detail: blvdId || '(missing)',
  });
  checks.push({
    name: 'BLVD action',
    ok: ['existing', 'linked', 'created'].includes(result.blvd?.action || result.action),
    detail: result.blvd?.action || result.action || '(missing)',
  });
  const dealId = result.acquisitionDeal?.dealId;
  checks.push({
    name: 'Acquisition Deal',
    ok: Boolean(dealId),
    detail: `${result.acquisitionDeal?.action || '?'} — ${dealId || '(missing)'}`,
  });
  return checks;
}

async function main() {
  const args = process.argv.slice(2);
  const staging = args.includes('--staging');
  const contactId = args.find((a) => !a.startsWith('--'));
  if (!contactId) {
    console.error('Usage: npm run verify:qualify -- <contactId> [--staging]');
    process.exit(1);
  }

  const result = staging
    ? await verifyRemote(contactId)
    : await processQualifyPath(getConfig(), contactId);

  console.log(JSON.stringify(result, null, 2));
  console.log('\nChecks:');
  let failed = 0;
  for (const c of checkResult(result)) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
