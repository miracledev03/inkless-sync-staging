/**
 * Read-only readiness check for whichever environment is configured
 * (ENV_FILE=.env.production for production). Writes nothing.
 *
 *   $env:ENV_FILE='.env.production'; npm run check:env
 */
const { getConfig, loadServiceMap, loadHubSpotIds } = require('../src/config');
const hs = require('../src/hubspot/client');
const blvd = require('../src/blvd/api');

const results = [];
function report(ok, name, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    report(true, name, detail);
  } catch (err) {
    report(false, name, err.message);
  }
}

async function main() {
  const config = getConfig();
  console.log(
    `Env: BLVD_ENV=${config.blvdEnv} auth=${config.blvdAuthMode} api=${config.blvdApiVersion} production=${config.isProduction} portal=${config.hubspotPortalId || '(unset)'}\n`
  );

  await check('HubSpot ID map', async () => {
    const ids = loadHubSpotIds(config);
    return `${ids.path} (env ${ids.env}, portal ${ids.portalId})`;
  });

  await check('Service map', async () => {
    const { path: p, map } = loadServiceMap(config);
    if (!map) throw new Error(`not found: ${p}`);
    const roles = ['virtual_consult_en', 'virtual_consult_es', 'in_office_consult', 'first_session_100'];
    const empty = roles.filter((r) => !map[r]);
    if (empty.length) throw new Error(`${p} missing ${empty.join(', ')}`);
    if (config.isProduction && map.env !== 'production') {
      throw new Error(`${p} env is "${map.env}"`);
    }
    return `${p} (${(map.excludedServiceIds || []).length} excluded)`;
  });

  await check('Pollers off in production', async () => {
    if (!config.isProduction) return 'n/a (non-production)';
    const on = ['POLL_APPOINTMENTS', 'POLL_CLIENTS'].filter((k) =>
      ['true', '1'].includes(String(process.env[k] || '').toLowerCase())
    );
    if (on.length) throw new Error(`${on.join(', ')} forced on`);
    return 'off';
  });

  await check('Admin token set in production', async () => {
    if (!config.isProduction) return 'n/a (non-production)';
    if (!config.adminApiToken) throw new Error('ADMIN_API_TOKEN is empty (ops endpoints locked)');
    return 'set';
  });

  await check('HubSpot webhook secret', async () => {
    if (!config.hubspotClientSecret) throw new Error('HUBSPOT_CLIENT_SECRET is empty');
    if (config.isProduction && config.hubspotWebhookSkipVerify) {
      throw new Error('HUBSPOT_WEBHOOK_SKIP_VERIFY must not be set in production');
    }
    return 'set';
  });

  await check('BLVD auth mode', async () => {
    const mode = config.blvdAuthMode;
    if (config.isProduction && mode !== 'oauth') {
      throw new Error(`production needs BLVD_AUTH_MODE=oauth, got "${mode}"`);
    }
    if (mode === 'oauth' && (!config.blvdClientId || !config.blvdClientSecret)) {
      throw new Error('BLVD_CLIENT_ID / BLVD_CLIENT_SECRET missing');
    }
    if (mode === 'apikey' && (!config.blvdApiKey || !config.blvdSecretKey)) {
      throw new Error('BLVD_API_KEY / BLVD_SECRET_KEY missing');
    }
    return `${mode} (API ${config.blvdApiVersion})`;
  });

  await check('BLVD webhook verify', async () => {
    if (config.isProduction && config.blvdWebhookSkipVerify) {
      throw new Error('BLVD_WEBHOOK_SKIP_VERIFY must not be set in production');
    }
    return 'enforced';
  });

  await check('HubSpot token / portal', async () => {
    const acct = await hs.hsRequest(config.hubspotToken, 'GET', '/account-info/v3/details');
    if (config.hubspotPortalId && String(acct.portalId) !== String(config.hubspotPortalId)) {
      throw new Error(`token is for portal ${acct.portalId}`);
    }
    return `portal ${acct.portalId}`;
  });

  await check('HubSpot custom objects', async () => {
    const schemas = (await hs.listSchemas(config.hubspotToken)).results || [];
    const names = new Set(
      schemas.flatMap((s) => [s.name, s.fullyQualifiedName, s.objectTypeId].map((n) => String(n || '').toLowerCase()))
    );
    const want = [config.appointmentObject, config.appointmentServiceObject, config.orderObject, config.locationObject];
    const missing = want.filter((w) => ![...names].some((n) => n === w.toLowerCase() || n.endsWith(`_${w.toLowerCase()}`)));
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
    return want.join(', ');
  });

  await check('HubSpot contact properties', async () => {
    const want = [config.blvdClientIdProperty, config.languageProperty];
    const missing = [];
    for (const name of want) {
      try {
        await hs.hsRequest(config.hubspotToken, 'GET', `/crm/v3/properties/contacts/${name}`);
      } catch {
        missing.push(name);
      }
    }
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
    return `${want.join(', ')} (${config.blvdPreCutoverClientProperty} is created by ensure:pre-cutover-property)`;
  });

  await check('Boulevard business', async () => {
    const b = await blvd.getBusiness(config);
    return `${b?.name || '(no name)'} via ${config.blvdAdminUrl}`;
  });

  await check('Boulevard locations', async () => {
    const locs = await blvd.listLocations(config);
    return `${locs.length} location(s)`;
  });

  await check('Boulevard Client API token (booking)', async () => {
    if (config.blvdAuthMode !== 'oauth') return 'n/a (apikey mode signs locally)';
    await require('../src/blvd/oauth').getClientApiToken(config);
    return `issued for ${config.blvdClientApiUrl}`;
  });

  await check('Boulevard webhook', async () => {
    const url = config.webhookPublicUrl;
    if (!url) throw new Error('WEBHOOK_PUBLIC_URL is empty');
    const res = await blvd.adminExecute(
      config,
      `query { webhooks(first: 50) { edges { node { id url subscriptions { eventType enabled } } } } }`
    );
    if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
    const hooks = (res.data.webhooks?.edges || []).map((e) => e.node).filter((w) => w.url === url);
    if (!hooks.length) throw new Error(`none registered for ${url} (run register-blvd-webhooks.js)`);
    const enabled = new Set(
      hooks.flatMap((w) => w.subscriptions.filter((s) => s.enabled).map((s) => s.eventType))
    );
    const want = [
      'APPOINTMENT_CREATED', 'APPOINTMENT_UPDATED', 'APPOINTMENT_RESCHEDULED',
      'APPOINTMENT_CANCELLED', 'APPOINTMENT_COMPLETED', 'ORDER_COMPLETED',
      'ORDER_REFUND_CLOSED', 'CLIENT_CREATED', 'CLIENT_UPDATED', 'CLIENT_MERGED',
    ];
    const missing = want.filter((e) => !enabled.has(e));
    if (missing.length) throw new Error(`missing/disabled: ${missing.join(', ')}`);
    if (hooks.length > 1) throw new Error(`${hooks.length} webhooks share ${url} (duplicate deliveries)`);
    return `${want.length} events enabled`;
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
