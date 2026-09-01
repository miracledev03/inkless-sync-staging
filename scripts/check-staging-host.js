/**
 * Monday ops check: staging middleware + BLVD/HS health + webhook URL config.
 */
const { getConfig, loadServiceMap } = require('../src/config');

const STAGING = process.env.STAGING_BASE_URL ||
  'https://inkless-sync-staging-rubetech.onrender.com';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const config = getConfig();
  const checks = [];

  for (const path of ['/health', '/health/blvd', '/health/hubspot', '/health/services']) {
    try {
      const r = await fetchJson(`${STAGING}${path}`);
      checks.push({
        name: path,
        ok: r.ok && (path === '/health/services' ? r.body?.ok : r.body?.ok !== false),
        detail: r.ok ? JSON.stringify(r.body).slice(0, 120) : `HTTP ${r.status}`,
      });
    } catch (err) {
      checks.push({ name: path, ok: false, detail: err.message });
    }
  }

  const { map, path: mapPath } = loadServiceMap(config);
  const required = [
    'virtual_consult_en',
    'virtual_consult_es',
    'in_office_consult',
    'first_session_100',
  ];
  const filled = required.filter((k) => map && map[k]);
  checks.push({
    name: 'local service map',
    ok: filled.length === required.length,
    detail: `${filled.length}/${required.length} @ ${mapPath}`,
  });

  checks.push({
    name: 'WEBHOOK_PUBLIC_URL',
    ok: Boolean(config.webhookPublicUrl?.includes('inkless-sync-staging-rubetech')),
    detail: config.webhookPublicUrl || '(empty)',
  });

  checks.push({
    name: 'webhook path',
    ok: config.webhookPath === '/webhooks/boulevard',
    detail: `${STAGING}${config.webhookPath}`,
  });

  console.log(`Staging host check — ${STAGING}\n`);
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
