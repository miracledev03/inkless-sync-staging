const { getConfig, loadServiceMap } = require('../src/config');
const blvd = require('../src/blvd/api');
const { hsRequest, listSchemas } = require('../src/hubspot/client');

async function main() {
  const config = getConfig();
  const checks = [];

  try {
    const business = await blvd.getBusiness(config);
    checks.push({
      name: 'BLVD auth',
      ok: true,
      detail: `${business.name}`,
    });
  } catch (err) {
    checks.push({ name: 'BLVD auth', ok: false, detail: err.message });
  }

  try {
    await hsRequest(
      config.hubspotToken,
      'GET',
      '/crm/v3/objects/contacts?limit=1'
    );
    checks.push({
      name: 'HubSpot contacts',
      ok: true,
      detail: `portal ${config.hubspotPortalId}`,
    });
  } catch (err) {
    checks.push({ name: 'HubSpot contacts', ok: false, detail: err.message });
  }

  try {
    const schemas = await listSchemas(config.hubspotToken);
    const names = (schemas.results || []).map((s) => s.name);
    const need = ['location', 'appointment', 'order'];
    const found = need.filter((n) =>
      names.some((x) => String(x).toLowerCase().includes(n))
    );
    checks.push({
      name: 'HubSpot custom objects',
      ok: found.length >= 3,
      detail: names.join(', '),
    });
  } catch (err) {
    checks.push({
      name: 'HubSpot custom objects',
      ok: false,
      detail: err.message,
    });
  }

  const { map } = loadServiceMap(config);
  const required = [
    'virtual_consult_en',
    'virtual_consult_es',
    'in_office_consult',
    'first_session_100',
  ];
  const filled = required.filter((k) => map && map[k]);
  checks.push({
    name: 'Service map',
    ok: filled.length === required.length,
    detail: `${filled.length}/${required.length} filled (sandbox catalog may be empty)`,
  });

  try {
    const locations = await blvd.listLocations(config);
    checks.push({
      name: 'BLVD locations readable',
      ok: locations.length > 0,
      detail: `${locations.length} location(s)`,
    });
  } catch (err) {
    checks.push({
      name: 'BLVD locations readable',
      ok: false,
      detail: err.message,
    });
  }

  console.log('Ready-for-Phase-A smoke gate\n');
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  // Service map empty is known sandbox gap; don't fail the gate hard this week
  // if only that check fails.
  const hardFails = checks.filter(
    (c) => !c.ok && c.name !== 'Service map'
  ).length;
  console.log(
    hardFails === 0
      ? '\nGATE: OK for Phase A location + createClient work'
      : '\nGATE: blocked — fix FAIL items above'
  );
  process.exit(hardFails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
