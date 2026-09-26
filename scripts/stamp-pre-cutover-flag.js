/**
 * Stamp BLVD Pre-Cutover Client = true on Contacts that still have
 * Lifecycle = Imported - BLVD (sandbox staging leftovers). Does not change lifecycle.
 *
 *   node scripts/stamp-pre-cutover-flag.js
 *   node scripts/stamp-pre-cutover-flag.js --apply
 *   node scripts/stamp-pre-cutover-flag.js --apply --limit=20
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');

const IMPORTED_SANDBOX = '1422909443';

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 100;

  const config = getConfig();
  const flagProp = config.blvdPreCutoverClientProperty;
  await hs.ensureBlvdPreCutoverClientProperty(
    config.hubspotToken,
    flagProp
  );

  const importedValue =
    config.importedBlvdLifecycleValue || IMPORTED_SANDBOX;

  const search = await hs.searchContacts(
    config.hubspotToken,
    [
      {
        filters: [
          {
            propertyName: 'lifecyclestage',
            operator: 'EQ',
            value: importedValue,
          },
        ],
      },
    ],
    ['email', 'firstname', 'lastname', 'lifecyclestage', flagProp],
    Math.min(limit || 100, 100)
  );

  const results = search.results || [];
  const summary = {
    dryRun: !apply,
    importedLifecycleValue: importedValue,
    flagProperty: flagProp,
    found: results.length,
    would_stamp: 0,
    stamped: 0,
    already: 0,
    errors: 0,
    rows: [],
  };

  for (const c of results) {
    const p = c.properties || {};
    const already = String(p[flagProp] || '').toLowerCase() === 'true';
    if (already) {
      summary.already += 1;
      summary.rows.push({ contactId: c.id, email: p.email, action: 'already' });
      continue;
    }
    if (!apply) {
      summary.would_stamp += 1;
      summary.rows.push({
        contactId: c.id,
        email: p.email,
        action: 'would_stamp',
      });
      continue;
    }
    try {
      await hs.updateContact(config.hubspotToken, c.id, {
        [flagProp]: 'true',
      });
      summary.stamped += 1;
      summary.rows.push({ contactId: c.id, email: p.email, action: 'stamped' });
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      summary.errors += 1;
      summary.rows.push({
        contactId: c.id,
        email: p.email,
        action: 'error',
        error: err.message,
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
