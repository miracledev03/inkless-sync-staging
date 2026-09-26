/**
 * Ensure Contact property BLVD Pre-Cutover Client exists (sandbox or prod token).
 *
 *   node scripts/ensure-pre-cutover-property.js
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');

async function main() {
  const config = getConfig();
  const name = await hs.ensureBlvdPreCutoverClientProperty(
    config.hubspotToken,
    config.blvdPreCutoverClientProperty
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        property: name,
        label: 'BLVD Pre-Cutover Client',
        backfillLifecycle: config.backfillLifecycleValue || 'lead',
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
