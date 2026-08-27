const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const { processOrderWebhook } = require('../src/handlers/orders');

async function main() {
  const config = getConfig();
  const idArg = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  const fileArg = process.argv.find((a) => a.startsWith('--file='))?.slice(7);
  const apply = process.argv.includes('--apply');

  let payload;
  if (fileArg) {
    payload = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  } else {
    const orderId =
      idArg || 'urn:blvd:Order:00000000-0000-0000-0000-000000000000';
    payload = {
      eventType: 'ORDER_COMPLETED',
      resourceId: orderId,
    };
  }

  const eventType = payload.eventType || payload.event || 'ORDER_COMPLETED';
  const result = await processOrderWebhook(config, {
    eventType,
    payload,
    headers: {},
    dryRun: !apply,
  });

  console.log(
    apply ? '--- HubSpot order upsert ---' : '--- planned order upsert (dry-run) ---'
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
