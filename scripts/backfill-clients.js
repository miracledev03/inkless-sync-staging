const { getConfig } = require('../src/config');
const { backfillBlvdClients } = require('../src/handlers/clients');
const hs = require('../src/hubspot/client');

function argValue(prefix) {
  const raw = process.argv.find((a) => a.startsWith(prefix));
  if (!raw) return null;
  const n = Number(raw.slice(prefix.length));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function statusOnly(config) {
  const idProp = config.blvdClientIdProperty;
  const flagProp = config.blvdPreCutoverClientProperty;

  const withBlvdId = await hs.searchContacts(
    config.hubspotToken,
    [
      {
        filters: [
          { propertyName: idProp, operator: 'HAS_PROPERTY' },
        ],
      },
    ],
    [idProp, flagProp, 'email', 'lifecyclestage'],
    1
  );

  const withFlag = await hs.searchContacts(
    config.hubspotToken,
    [
      {
        filters: [
          { propertyName: flagProp, operator: 'EQ', value: 'true' },
        ],
      },
    ],
    [idProp, flagProp, 'email'],
    1
  );

  console.log(
    JSON.stringify(
      {
        mode: 'status',
        hubspotPortalHint: 'production if ENV_FILE=.env.production',
        contactsWithBlvdClientId: withBlvdId.total ?? null,
        contactsWithPreCutoverFlag: withFlag.total ?? null,
        note:
          'Live sync also writes blvd client id. Pre-cutover flag is set only by this import (or stamp script). Re-running import is safe: matched contacts update; protected lifecycles are left alone.',
      },
      null,
      2
    )
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const status = process.argv.includes('--status');
  const summaryOnly = process.argv.includes('--summary');
  const limit = argValue('--limit=');
  const offset = argValue('--offset=') || 0;

  const config = getConfig();

  if (status) {
    await statusOnly(config);
    return;
  }

  const result = await backfillBlvdClients(config, {
    dryRun: !apply,
    limit: limit != null && limit > 0 ? limit : null,
    offset,
    summaryOnly,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.errors > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
