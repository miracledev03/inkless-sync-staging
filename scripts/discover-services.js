/**
 * List BLVD services and fill the 4 Acquisition roles in the active service map
 * (SERVICE_MAP_PATH; production default config/service-map.production.json).
 *
 *   npm run discover:services              # print only
 *   npm run discover:services -- --write   # write mapped roles to the file
 *
 * Exact label match (map.labels) wins over the name heuristics. Everything not
 * mapped and not in excludedServiceIds is treated as Treatment Journey.
 */
const fs = require('fs');
const { getConfig, loadServiceMap } = require('../src/config');
const blvd = require('../src/blvd/api');

const ROLES = [
  'virtual_consult_en',
  'virtual_consult_es',
  'in_office_consult',
  'first_session_100',
];

const RULES = {
  // Prefer explicit EN token; avoid matching the "en" inside "Assessment"
  virtual_consult_en: { match: /\bEN\b|english/i, require: /virtual/i },
  virtual_consult_es: { match: /\bES\b|spanish/i, require: /virtual/i },
  in_office_consult: { match: /in[- ]?office|in[- ]?person/i, require: /assessment|consult/i },
  first_session_100: { match: /\b100\b.*first session|first session/i, exclude: /gift|card|package/i },
};

function norm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function main() {
  const write = process.argv.includes('--write');
  const config = getConfig();
  const { path: mapPath, map: existing } = loadServiceMap(config);
  const map = existing || { labels: {}, excludedServiceIds: [], excludedLabels: {} };
  map.env = config.isProduction ? 'production' : config.blvdEnv;
  map.labels = map.labels || {};
  map.excludedServiceIds = map.excludedServiceIds || [];
  map.excludedLabels = map.excludedLabels || {};

  const services = await blvd.listServices(config);
  console.log(`BLVD env: ${config.blvdEnv} — ${services.length} service(s)`);
  console.log(`Service map: ${mapPath}\n`);

  const mapped = {};
  for (const role of ROLES) {
    const label = map.labels[role];
    let hit = label ? services.find((s) => norm(s.name) === norm(label)) : null;
    let how = 'exact label';
    if (!hit) {
      const rule = RULES[role];
      const candidates = services.filter(
        (s) =>
          (!rule.require || rule.require.test(s.name)) &&
          (!rule.exclude || !rule.exclude.test(s.name)) &&
          rule.match.test(s.name)
      );
      hit = candidates.find((s) => s.active) || candidates[0] || null;
      how = candidates.length > 1 ? `heuristic (${candidates.length} candidates — REVIEW)` : 'heuristic';
    }
    if (hit) {
      mapped[role] = hit.id;
      map[role] = hit.id;
      map.labels[role] = hit.name;
      console.log(`MAPPED  ${role.padEnd(20)} ${hit.name}  [${how}]`);
    } else {
      console.log(`MISSING ${role.padEnd(20)} (set by hand in ${mapPath})`);
    }
  }

  const excluded = new Set(map.excludedServiceIds.map((id) => String(id).toLowerCase()));
  const acquisitionIds = new Set(Object.values(mapped).map((id) => id.toLowerCase()));
  console.log('\nAll other services (Treatment Journey unless excluded):');
  for (const s of services) {
    if (acquisitionIds.has(s.id.toLowerCase())) continue;
    const tag = excluded.has(s.id.toLowerCase()) ? 'EXCLUDED ' : 'JOURNEY  ';
    console.log(`${tag}${s.active ? 'Y' : 'N'}  ${s.name}  ${s.id}`);
  }
  console.log(
    '\nTo exclude a service (retail, gift card, etc.), add its id to excludedServiceIds ' +
      '(and optionally its name to excludedLabels) in the service map.'
  );

  if (write) {
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
    console.log(`\nWrote ${mapPath}`);
  } else {
    console.log('\nDry run. Re-run with --write to save mapped roles.');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
