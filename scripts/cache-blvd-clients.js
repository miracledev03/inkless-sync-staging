/**
 * Dump all Boulevard clients to JSON for offline/chunked HubSpot backfill.
 *
 *   ENV_FILE=.env.production node scripts/cache-blvd-clients.js
 *   ... --out=backfill-clients-cache.json --retries=8
 */
const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');

function argValue(prefix, fallback) {
  const raw = process.argv.find((a) => a.startsWith(prefix));
  if (!raw) return fallback;
  return raw.slice(prefix.length);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const out = path.resolve(
    process.cwd(),
    argValue('--out=', 'backfill-clients-cache.json')
  );
  const retries = Number(argValue('--retries=', '8')) || 8;
  const config = getConfig();

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      console.log(`listClients attempt ${attempt}/${retries}…`);
      const t0 = Date.now();
      const clients = await blvd.listClients(config);
      const payload = {
        fetchedAt: new Date().toISOString(),
        count: clients.length,
        clients,
      };
      fs.writeFileSync(out, JSON.stringify(payload));
      console.log(
        JSON.stringify(
          {
            ok: true,
            count: clients.length,
            out,
            seconds: Math.round((Date.now() - t0) / 1000),
          },
          null,
          2
        )
      );
      return;
    } catch (err) {
      lastErr = err;
      console.error(`attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        const waitMs = Math.min(attempt * 120_000, 900_000);
        console.warn(`waiting ${Math.round(waitMs / 1000)}s before retry`);
        await sleep(waitMs);
      }
    }
  }
  console.error(lastErr?.message || 'cache failed');
  process.exit(1);
}

main();
