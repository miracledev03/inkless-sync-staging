/**
 * Finish client backfill via production Render (bypasses local Cloudflare).
 * Requires deployed /backfill-clients that honors body.offset.
 *
 *   ENV_FILE=.env.production node scripts/backfill-clients-remote-chunks.js
 *   ... --start-offset=13000 --chunk-size=1000 --total=19771
 */
const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');

function argNum(prefix, fallback) {
  const raw = process.argv.find((a) => a.startsWith(prefix));
  if (!raw) return fallback;
  const n = Number(raw.slice(prefix.length));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function hubspotStatus(config) {
  const idProp = config.blvdClientIdProperty;
  const flagProp = config.blvdPreCutoverClientProperty;
  const withBlvdId = await hs.searchContacts(
    config.hubspotToken,
    [{ filters: [{ propertyName: idProp, operator: 'HAS_PROPERTY' }] }],
    [idProp],
    1
  );
  const withFlag = await hs.searchContacts(
    config.hubspotToken,
    [{ filters: [{ propertyName: flagProp, operator: 'EQ', value: 'true' }] }],
    [flagProp],
    1
  );
  return {
    contactsWithBlvdClientId: withBlvdId.total ?? null,
    contactsWithPreCutoverFlag: withFlag.total ?? null,
  };
}

function renderStatusMd({ total, chunkSize, chunks, hsCounts, statusLabel }) {
  const planned = Math.ceil(total / chunkSize);
  const processed = chunks.reduce((s, c) => s + (c.totalClients || 0), 0);
  const last = chunks[chunks.length - 1];
  const rows = chunks
    .map((c) => {
      const dur =
        c.durationSec != null ? `~${Math.round(c.durationSec / 60)} min` : '—';
      return `| ${c.n} | ${c.offset} | ${c.limit} | ${c.finishedUtc} | ${c.create} | ${c.update} | ${c.skipped_lifecycle} | ${c.errors} | ${c.exit} | ${dur} | ${c.notes || ''} |`;
    })
    .join('\n');
  return `# Inkless 4.1 — Client import status

**Portal:** HubSpot production \`50955637\`  
**Source:** Boulevard production clients (~${total.toLocaleString()})  
**Mode:** Contacts only — via **Render** \`/backfill-clients\` (local BLVD Cloudflare blocked).  
**Chunk size:** ${chunkSize.toLocaleString()}  
**Last updated:** ${last?.finishedUtc || new Date().toISOString()}

## Overall

| Metric | Value |
|---|---|
| Boulevard clients (total) | ${total.toLocaleString()} |
| Chunks planned | ${planned} |
| Chunks completed | ${chunks.length} / ${planned} |
| Clients processed (sum of chunk totals) | ${processed.toLocaleString()} |
| HubSpot contacts with BLVD client id | ${hsCounts.contactsWithBlvdClientId ?? '—'} |
| HubSpot contacts with pre-cutover flag | ${hsCounts.contactsWithPreCutoverFlag ?? '—'} |
| Status | **${statusLabel}** |

## Chunk log

| # | Offset | Limit | Finished (UTC) | create | update | skipped_lifecycle | errors | exit | Duration | Notes |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|
${rows}
`;
}

async function postBackfill(baseUrl, token, body) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/backfill-clients`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

async function main() {
  const total = argNum('--total=', 19771);
  const chunkSize = argNum('--chunk-size=', 1000);
  const startOffset = argNum('--start-offset=', 13000);
  const baseUrl =
    process.argv
      .find((a) => a.startsWith('--url='))
      ?.slice('--url='.length) ||
    'https://inkless-hubspot-boulevard-sync.onrender.com';

  const config = getConfig();
  if (!config.adminApiToken) {
    throw new Error('ADMIN_API_TOKEN missing (set ENV_FILE=.env.production)');
  }

  const progressPath = path.resolve(__dirname, '../backfill-chunk-progress.json');
  const statusPath = path.resolve(
    __dirname,
    '../../docs/Inkless_4.1_Client_Import_Status.md'
  );

  let chunks = [];
  if (fs.existsSync(progressPath)) {
    chunks = JSON.parse(fs.readFileSync(progressPath, 'utf8')).chunks || [];
  }

  // Probe offset support once.
  const probe = await postBackfill(baseUrl, config.adminApiToken, {
    apply: false,
    limit: 1,
    offset: startOffset,
    summaryOnly: true,
  });
  if (Number(probe.offset) !== startOffset) {
    throw new Error(
      `Render ignored offset (got ${probe.offset}, wanted ${startOffset}). Deploy src/server.js offset pass-through, Manual Deploy, then re-run.`
    );
  }
  console.log('offset support OK on Render');

  let statusLabel = 'In progress (via Render)';

  for (let offset = startOffset; offset < total; offset += chunkSize) {
    const n = Math.floor(offset / chunkSize) + 1;
    if (chunks.some((c) => c.offset === offset && c.exit !== 1)) {
      console.log(`skip offset=${offset}`);
      continue;
    }
    console.log(`\n=== remote chunk #${n} offset=${offset} ===`);
    const t0 = Date.now();
    let result;
    let exit = 0;
    try {
      result = await postBackfill(baseUrl, config.adminApiToken, {
        apply: true,
        limit: chunkSize,
        offset,
        summaryOnly: true,
      });
      if (Number(result.offset) !== offset) {
        throw new Error(
          `offset not applied on apply (got ${result.offset}). Aborting.`
        );
      }
      if (result.errors > 0) exit = 2;
    } catch (err) {
      console.error(err.message);
      result = {
        totalClients: 0,
        create: 0,
        update: 0,
        skipped_lifecycle: 0,
        errors: 1,
      };
      exit = 1;
    }

    const entry = {
      n,
      offset,
      limit: chunkSize,
      finishedUtc: new Date().toISOString(),
      create: result.create || 0,
      update: result.update || 0,
      skipped_lifecycle: result.skipped_lifecycle || 0,
      errors: result.errors || 0,
      exit,
      totalClients: result.totalClients || 0,
      durationSec: Math.round((Date.now() - t0) / 1000),
      notes: exit === 1 ? 'Render/hard failure' : exit === 2 ? `${result.errors} soft errors` : 'via Render',
    };
    chunks = chunks.filter((c) => c.offset !== offset).concat(entry);
    chunks.sort((a, b) => a.offset - b.offset);

    const hsCounts = await hubspotStatus(config);
    if (exit === 1) statusLabel = `Stopped — chunk #${n}`;
    else if (offset + chunkSize >= total || result.totalClients === 0) {
      statusLabel = 'Complete';
    } else if (exit === 2) statusLabel = 'In progress (soft errors; via Render)';
    else statusLabel = 'In progress (via Render)';

    fs.writeFileSync(
      progressPath,
      JSON.stringify({ total, chunkSize, chunks, via: 'render' }, null, 2)
    );
    fs.writeFileSync(
      statusPath,
      renderStatusMd({ total, chunkSize, chunks, hsCounts, statusLabel })
    );
    console.log(JSON.stringify({ entry, hsCounts, statusLabel }, null, 2));

    if (exit === 1) {
      process.exitCode = 1;
      return;
    }
    if (result.totalClients === 0) return;
  }

  const hsCounts = await hubspotStatus(config);
  fs.writeFileSync(
    statusPath,
    renderStatusMd({
      total,
      chunkSize,
      chunks,
      hsCounts,
      statusLabel: 'Complete',
    })
  );
  console.log('all remote chunks finished');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
