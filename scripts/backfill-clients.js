const { getConfig } = require('../src/config');
const { backfillBlvdClients } = require('../src/handlers/clients');

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  const config = getConfig();
  const result = await backfillBlvdClients(config, {
    dryRun: !apply,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.errors > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
