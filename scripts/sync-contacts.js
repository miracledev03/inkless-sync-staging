const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');
const { upsertContactFromBlvdClient } = require('../src/handlers/clients');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const idArg = process.argv.find(
    (a, i) => i > 1 && !a.startsWith('--') && a.includes('blvd:Client')
  );
  const emailArg = process.argv
    .find((a) => a.startsWith('--email='))
    ?.slice('--email='.length);

  const config = getConfig();
  let clients = await blvd.listClients(config);

  if (idArg) {
    clients = clients.filter((c) => c.id === idArg);
  } else if (emailArg) {
    clients = clients.filter(
      (c) => (c.email || '').toLowerCase() === emailArg.toLowerCase()
    );
  }

  if (!clients.length) {
    console.error('No matching BLVD clients found');
    process.exit(1);
  }

  const results = [];
  for (const client of clients) {
    results.push(await upsertContactFromBlvdClient(config, client, { dryRun }));
  }
  console.log(JSON.stringify({ dryRun, count: results.length, results }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
