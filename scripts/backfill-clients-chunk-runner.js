/**
 * Apply Boulevard → HubSpot client backfill in fixed-size chunks and
 * rewrite docs/Inkless_4.1_Client_Import_Status.md after each chunk.
 *
 *   ENV_FILE=.env.production node scripts/backfill-clients-chunk-runner.js
 *   ... --start-offset=1000 --chunk-size=1000 --total=19771
 */
const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const { backfillBlvdClients } = require('../src/handlers/clients');
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

function renderStatusMd({
  total,
  chunkSize,
  chunks,
  hsCounts,
  statusLabel,
  softErrors = [],
}) {
  const planned = Math.ceil(total / chunkSize);
  const processed = chunks.reduce((s, c) => s + (c.totalClients || 0), 0);
  const last = chunks[chunks.length - 1];
  const lastUpdated = last?.finishedUtc || new Date().toISOString();

  const rows = chunks
    .map((c) => {
      const dur =
        c.durationSec != null ? `~${Math.round(c.durationSec / 60)} min` : '—';
      return `| ${c.n} | ${c.offset} | ${c.limit} | ${c.finishedUtc} | ${c.create} | ${c.update} | ${c.skipped_lifecycle} | ${c.errors} | ${c.exit} | ${dur} | ${c.notes || ''} |`;
    })
    .join('\n');

  const softRows =
    softErrors.length === 0
      ? '| — | — | — | — |'
      : softErrors
          .map(
            (e) =>
              `| ${e.chunk} | \`${e.blvdClientId}\` | ${e.email || '—'} | ${e.error} |`
          )
          .join('\n');

  return `# Inkless 4.1 — Client import status

**Portal:** HubSpot production \`50955637\`  
**Source:** Boulevard production clients (~${total.toLocaleString()})  
**Mode:** Contacts only — \`blvd_pre_cutover_client\` + Lead when eligible. No historical appointments/orders.  
**Chunk size:** ${chunkSize.toLocaleString()}  
**Script:** \`npm run backfill:clients -- --apply --limit=${chunkSize} --offset=N --summary\`  
**Last updated:** ${lastUpdated}

## Overall

| Metric | Value |
|---|---|
| Boulevard clients (total) | ${total.toLocaleString()} |
| Chunks planned | ${planned} (offsets 0…${(planned - 1) * chunkSize}) |
| Chunks completed | ${chunks.length} / ${planned} |
| Clients processed (sum of chunk totals) | ${processed.toLocaleString()} |
| HubSpot contacts with BLVD client id | ${hsCounts.contactsWithBlvdClientId ?? '—'} |
| HubSpot contacts with pre-cutover flag | ${hsCounts.contactsWithPreCutoverFlag ?? '—'} |
| Status | **${statusLabel}** |

## Chunk log

| # | Offset | Limit | Finished (UTC) | create | update | skipped_lifecycle | errors | exit | Duration | Notes |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|
${rows || '| — | — | — | — | — | — | — | — | — | — | — |'}

## Soft errors (skipped clients)

| Chunk | BLVD client | Email | Error |
|---|---|---|---|
${softRows}

## Notes for Joey

- Historical appointments still appear in HubSpot only when Boulevard next changes them.
- Protected lifecycles are never overwritten (Qualified & Engaged through Churned).
`;
}

async function main() {
  const total = argNum('--total=', 19771);
  const chunkSize = argNum('--chunk-size=', 1000);
  const startOffset = argNum('--start-offset=', 0);
  const cacheArg = process.argv.find((a) => a.startsWith('--cache='));
  const cachePath = cacheArg
    ? path.resolve(process.cwd(), cacheArg.slice('--cache='.length))
    : path.resolve(__dirname, '../backfill-clients-cache.json');
  const statusPath = path.resolve(
    __dirname,
    '../../docs/Inkless_4.1_Client_Import_Status.md'
  );
  const progressPath = path.resolve(
    __dirname,
    '../backfill-chunk-progress.json'
  );

  let chunks = [];
  let softErrors = [];
  if (fs.existsSync(progressPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      chunks = saved.chunks || [];
      softErrors = saved.softErrors || [];
    } catch {
      chunks = [];
      softErrors = [];
    }
  }

  // Seed chunk #1 if runner starts mid-way and progress file is empty.
  if (chunks.length === 0 && startOffset >= 1000) {
    chunks.push({
      n: 1,
      offset: 0,
      limit: 1000,
      finishedUtc: '2026-11-03T07:30:41Z',
      create: 306,
      update: 694,
      skipped_lifecycle: 52,
      errors: 0,
      exit: 0,
      totalClients: 1000,
      durationSec: 2138,
      notes: 'Includes re-touch of rows from stopped full run',
    });
  }

  const config = getConfig();
  let statusLabel = 'In progress';
  let entryNotesHard = '';
  let cachedClients = null;
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cachedClients = cached.clients || cached;
    if (!Array.isArray(cachedClients)) {
      throw new Error(`Invalid client cache at ${cachePath}`);
    }
    console.log(
      `using client cache ${cachePath} (${cachedClients.length} clients, fetchedAt=${cached.fetchedAt || 'unknown'})`
    );
  } else {
    console.warn(
      `no client cache at ${cachePath} — each chunk will list Boulevard (slower / Cloudflare risk)`
    );
  }

  const effectiveTotal =
    cachedClients != null ? cachedClients.length : total;

  for (let offset = startOffset; offset < effectiveTotal; offset += chunkSize) {
    entryNotesHard = '';
    const n = Math.floor(offset / chunkSize) + 1;
    // Skip chunks already attempted (including soft-error finishes).
    if (chunks.some((c) => c.offset === offset && c.exit !== 1)) {
      console.log(`skip already-recorded chunk offset=${offset}`);
      continue;
    }

    console.log(`\n=== chunk #${n} offset=${offset} limit=${chunkSize} ===`);
    const t0 = Date.now();
    let result;
    let exit = 0;
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        result = await backfillBlvdClients(config, {
          dryRun: false,
          limit: chunkSize,
          offset,
          summaryOnly: true,
          clients: cachedClients || undefined,
        });
        exit = result.errors > 0 ? 2 : 0;
        break;
      } catch (err) {
        const msg = String(err.message || err);
        console.error(`chunk #${n} attempt ${attempt}/${maxAttempts}: ${msg}`);
        const transient =
          /403|429|Cloudflare|Just a moment|ECONNRESET|ETIMEDOUT|socket|Non-JSON response/i.test(
            msg
          );
        if (!transient || attempt === maxAttempts) {
          result = {
            totalClients: 0,
            create: 0,
            update: 0,
            skipped_lifecycle: 0,
            errors: 1,
          };
          exit = 1;
          entryNotesHard = msg.slice(0, 180);
          break;
        }
        const waitMs = attempt * 60_000;
        console.warn(`transient BLVD/HS error — waiting ${waitMs / 1000}s then retry`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    const durationSec = Math.round((Date.now() - t0) / 1000);
    const finishedUtc = new Date().toISOString();

    const entry = {
      n,
      offset,
      limit: chunkSize,
      finishedUtc,
      create: result.create || 0,
      update: result.update || 0,
      skipped_lifecycle: result.skipped_lifecycle || 0,
      errors: result.errors || 0,
      exit,
      totalClients: result.totalClients || 0,
      durationSec,
      notes: entryNotesHard
        ? `Hard failure: ${entryNotesHard}`
        : result.totalClients === 0
          ? 'No clients in range — end of list'
          : '',
    };
    if (exit === 2) {
      entry.notes = `${result.errors} soft HubSpot errors (invalid emails etc.)`;
    }
    chunks = chunks.filter((c) => c.offset !== offset).concat(entry);
    chunks.sort((a, b) => a.offset - b.offset);

    let hsCounts = {
      contactsWithBlvdClientId: null,
      contactsWithPreCutoverFlag: null,
    };
    try {
      hsCounts = await hubspotStatus(config);
    } catch (err) {
      console.error('status refresh failed', err.message);
    }

    if (exit === 1) statusLabel = `Stopped — chunk #${n} hard failure`;
    else if (offset + chunkSize >= effectiveTotal || result.totalClients === 0) {
      statusLabel = 'Complete';
    } else if (exit === 2) {
      statusLabel = 'In progress (soft errors recorded)';
    } else {
      statusLabel = 'In progress';
    }

    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        { total: effectiveTotal, chunkSize, chunks, softErrors, cachePath },
        null,
        2
      )
    );

    fs.writeFileSync(
      statusPath,
      renderStatusMd({
        total: effectiveTotal,
        chunkSize,
        chunks,
        hsCounts,
        statusLabel,
        softErrors,
      })
    );
    console.log(JSON.stringify({ entry, hsCounts, statusLabel }, null, 2));

    // Soft per-client HubSpot errors: record and continue. Hard throw = stop.
    if (exit === 1) {
      process.exitCode = 1;
      return;
    }
    if (exit === 2) {
      console.warn(
        `chunk #${n} finished with ${result.errors} soft errors — continuing`
      );
    }
    if (result.totalClients === 0) {
      statusLabel = 'Complete';
      fs.writeFileSync(
        statusPath,
        renderStatusMd({
          total: effectiveTotal,
          chunkSize,
          chunks,
          hsCounts,
          statusLabel,
          softErrors,
        })
      );
      return;
    }
  }

  const hsCounts = await hubspotStatus(config);
  statusLabel = 'Complete';
  fs.writeFileSync(
    statusPath,
    renderStatusMd({
      total: effectiveTotal,
      chunkSize,
      chunks,
      hsCounts,
      statusLabel,
      softErrors,
    })
  );
  console.log('all chunks finished');
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
