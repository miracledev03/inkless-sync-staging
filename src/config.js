const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const PRODUCTION_ENV_NAMES = new Set(['prod', 'production', 'live']);

function isProductionEnv(env) {
  return PRODUCTION_ENV_NAMES.has(String(env || '').trim().toLowerCase());
}

function getConfig() {
  // Local: ENV_FILE (e.g. .env.production) or .env.staging; hosted: platform env vars.
  const root = path.join(__dirname, '..');
  if (process.env.ENV_FILE) {
    loadEnvFile(path.resolve(root, process.env.ENV_FILE));
  } else {
    loadEnvFile(path.join(root, '.env.staging'));
  }
  loadEnvFile(path.join(root, '.env'));

  const rawEnv = String(process.env.BLVD_ENV || 'sandbox').trim().toLowerCase();
  const isProduction = isProductionEnv(rawEnv);
  const env = isProduction ? 'production' : rawEnv;
  const blvdHost = isProduction
    ? 'https://dashboard.boulevard.io'
    : 'https://sandbox.joinblvd.com';
  // oauth = v2026-06 app (client credentials); apikey = legacy 2020-01 key + secret.
  const blvdAuthMode = String(
    process.env.BLVD_AUTH_MODE || (isProduction ? 'oauth' : 'apikey')
  )
    .trim()
    .toLowerCase();
  const blvdOAuth = blvdAuthMode === 'oauth';
  const blvdApiVersion = blvdOAuth
    ? process.env.BLVD_API_VERSION || '2026-06'
    : '2020-01';
  const blvdBusinessId = process.env.BLVD_BUSINESS_ID || '';
  const adminUrl = `${blvdHost}/api/${blvdApiVersion}/admin`;
  const clientApiUrl = blvdOAuth
    ? `${blvdHost}/api/${blvdApiVersion}/client`
    : `${blvdHost}/api/2020-01/${blvdBusinessId}/client`;

  const hubspotIdMapPath =
    process.env.HUBSPOT_ID_MAP_PATH ||
    (isProduction
      ? './config/hubspot-ids.production.json'
      : './config/hubspot-ids.staging.json');
  const ids = readJsonIfExists(resolveFromRoot(hubspotIdMapPath));

  return {
    hubspotPortalId: process.env.HUBSPOT_PORTAL_ID || '',
    hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN || '',
    isProduction,
    blvdEnv: env,
    blvdHost,
    blvdAuthMode,
    blvdApiVersion,
    blvdAdminUrl: adminUrl,
    blvdClientApiUrl: clientApiUrl,
    hubspotIdMapPath,
    /** Required on ops endpoints (backfill, create-client, sync-*) when set; mandatory in production. */
    adminApiToken: process.env.ADMIN_API_TOKEN || '',
    /** BLVD listClients page cap (50 per page). Default 2000 pages = 100,000 clients. */
    blvdListClientsMaxPages: Number(
      process.env.BLVD_LIST_CLIENTS_MAX_PAGES || 2000
    ),
    blvdBusinessId,
    blvdApiKey: process.env.BLVD_API_KEY || '',
    blvdSecretKey: process.env.BLVD_SECRET_KEY || '',
    blvdClientId: process.env.BLVD_CLIENT_ID || '',
    /** Base64 text exactly as shown in the Boulevard Developer Portal. */
    blvdClientSecret: process.env.BLVD_CLIENT_SECRET || '',
    /** Reject OAuth-signed webhooks whose salt timestamp is older than this. */
    blvdWebhookMaxAgeSec: Number(process.env.BLVD_WEBHOOK_MAX_AGE_SEC || 300),
    port: Number(process.env.PORT || 3456),
    webhookPath: process.env.BLVD_WEBHOOK_PATH || '/webhooks/boulevard',
    webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL || '',
    hubspotWebhookPath:
      process.env.HUBSPOT_WEBHOOK_PATH || '/webhooks/hubspot',
    hubspotWebhookPublicUrl:
      process.env.HUBSPOT_WEBHOOK_PUBLIC_URL ||
      (process.env.WEBHOOK_PUBLIC_URL
        ? String(process.env.WEBHOOK_PUBLIC_URL).replace(
            /\/webhooks\/boulevard\/?$/,
            '/webhooks/hubspot'
          )
        : ''),
    hubspotClientSecret: process.env.HUBSPOT_CLIENT_SECRET || '',
    hubspotWebhookSkipVerify: process.env.HUBSPOT_WEBHOOK_SKIP_VERIFY || '',
    /** Staging escape hatch if BLVD HMAC secret drift rejects deliveries. */
    blvdWebhookSkipVerify: process.env.BLVD_WEBHOOK_SKIP_VERIFY || '',
    /** Poll BLVD appointments when webhooks are unreliable (sandbox default on). */
    pollAppointments: process.env.POLL_APPOINTMENTS,
    pollAppointmentsIntervalMs: Number(
      process.env.POLL_APPOINTMENTS_INTERVAL_MS || 15000
    ),
    /** Poll BLVD clients for Test B when CLIENT_* webhooks are quiet (sandbox default on). */
    pollClients: process.env.POLL_CLIENTS,
    pollClientsIntervalMs: Number(
      process.env.POLL_CLIENTS_INTERVAL_MS || 60000
    ),
    /** Qualified & Engaged lifecycle internal value (defaults from the HubSpot ID map). */
    qualifiedLifecycleValue:
      process.env.HUBSPOT_QUALIFIED_LIFECYCLE_VALUE ||
      ids?.lifecycle?.qualifiedEngaged ||
      '',
    /** Skipped-consult cancel lifecycle (defaults from the HubSpot ID map). */
    consultationNoShowCancelLifecycle:
      process.env.HUBSPOT_CONSULTATION_NOSHOW_LIFECYCLE_VALUE ||
      ids?.lifecycle?.consultationNoShowCancel ||
      '',
    serviceMapPath:
      process.env.SERVICE_MAP_PATH ||
      (isProduction
        ? './config/service-map.production.json'
        : './config/service-map.staging.json'),
    languageProperty: process.env.HUBSPOT_LANGUAGE_PROPERTY || 'language',
    blvdClientIdProperty:
      process.env.HUBSPOT_BLVD_CLIENT_ID_PROPERTY || 'blvd_client_id',
    locationObject: process.env.HUBSPOT_LOCATION_OBJECT || 'locations',
    locationBlvdIdProperty:
      process.env.HUBSPOT_LOCATION_BLVD_ID_PROPERTY ||
      'location_external_id',
    /**
     * Durable pre-cutover marker (Dan/Joey Sep 22). Boolean Yes/No.
     * Set on A6 backfill; never cleared when lifecycle advances.
     */
    blvdPreCutoverClientProperty:
      process.env.HUBSPOT_BLVD_PRE_CUTOVER_CLIENT_PROPERTY ||
      'blvd_pre_cutover_client',
    /**
     * Lifecycle written on A6 backfill for new / eligible Contacts.
     * Dan approved: Lead (not Imported - BLVD). Standard HubSpot value: lead.
     */
    backfillLifecycleValue:
      process.env.HUBSPOT_BACKFILL_LIFECYCLE_VALUE || 'lead',
    /** @deprecated Prefer blvdPreCutoverClientProperty; kept for docs/migration. */
    importedBlvdLifecycleLabel:
      process.env.HUBSPOT_IMPORTED_BLVD_LIFECYCLE_LABEL || 'Imported - BLVD',
    /** @deprecated A6 no longer sets Imported - BLVD. */
    importedBlvdLifecycleValue:
      process.env.HUBSPOT_IMPORTED_BLVD_LIFECYCLE_VALUE || '',
    appointmentObject:
      process.env.HUBSPOT_APPOINTMENT_OBJECT || 'blvd_appointments',
    appointmentIdProperty:
      process.env.HUBSPOT_APPOINTMENT_ID_PROPERTY || 'blvd_appointment_id',
    appointmentOriginProperty:
      process.env.HUBSPOT_APPOINTMENT_ORIGIN_PROPERTY ||
      'blvd_appointment_source',
    appointmentServiceObject:
      process.env.HUBSPOT_APPOINTMENT_SERVICE_OBJECT ||
      'blvd_appointment_services',
    appointmentServiceIdProperty:
      process.env.HUBSPOT_APPOINTMENT_SERVICE_ID_PROPERTY ||
      'blvd_appointment_service_id',
    orderObject: process.env.HUBSPOT_ORDER_OBJECT || 'blvd_orders',
    orderIdProperty:
      process.env.HUBSPOT_ORDER_ID_PROPERTY || 'blvd_order_id',
  };
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
}

function readJsonIfExists(full) {
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function loadServiceMap(config = getConfig()) {
  const full = resolveFromRoot(config.serviceMapPath);
  return { path: full, map: readJsonIfExists(full) };
}

const REQUIRED_ACQUISITION_STAGES = [
  'newOpportunity',
  'consultationBooked',
  'consultationAttended',
  'consultationNoShowCancelled',
  'firstSessionBooked',
  'firstSessionNoShowCancelled',
  'closedWon',
  'closedLost',
];
const REQUIRED_JOURNEY_STAGES = [
  'inTreatment',
  'atRisk',
  'treatmentCompleted',
  'discontinued',
];
const REQUIRED_LIFECYCLES = [
  'lead',
  'qualifiedEngaged',
  'consultationBooked',
  'consultationAttended',
  'consultationNoShowCancel',
  'activeCustomer',
  'completedCustomer',
  'churned',
];

/** Returns a list of empty / missing ID paths in a HubSpot ID map. */
function missingHubSpotIds(ids) {
  if (!ids) return ['<file>'];
  const missing = [];
  if (!ids.acquisition?.pipelineId) missing.push('acquisition.pipelineId');
  for (const k of REQUIRED_ACQUISITION_STAGES) {
    if (!ids.acquisition?.stages?.[k]) missing.push(`acquisition.stages.${k}`);
  }
  if (!ids.treatmentJourney?.pipelineId) {
    missing.push('treatmentJourney.pipelineId');
  }
  for (const k of REQUIRED_JOURNEY_STAGES) {
    if (!ids.treatmentJourney?.stages?.[k]) {
      missing.push(`treatmentJourney.stages.${k}`);
    }
  }
  for (const k of REQUIRED_LIFECYCLES) {
    if (!ids.lifecycle?.[k]) missing.push(`lifecycle.${k}`);
  }
  return missing;
}

/**
 * Load + validate the per-environment HubSpot pipeline / stage / lifecycle IDs.
 * Throws when the file is missing, incomplete, or belongs to a different portal
 * than HUBSPOT_PORTAL_ID (prevents production token + sandbox IDs).
 */
function loadHubSpotIds(config = getConfig()) {
  const full = resolveFromRoot(config.hubspotIdMapPath);
  const ids = readJsonIfExists(full);
  if (!ids) {
    throw new Error(`HubSpot ID map not found: ${full}`);
  }
  const missing = missingHubSpotIds(ids);
  if (missing.length) {
    throw new Error(
      `HubSpot ID map ${full} is incomplete (${missing.join(', ')}). ` +
        'Run npm run pull:hubspot-ids -- --write against this portal.'
    );
  }
  if (
    config.hubspotPortalId &&
    ids.portalId &&
    String(config.hubspotPortalId) !== String(ids.portalId)
  ) {
    throw new Error(
      `HubSpot ID map ${full} is for portal ${ids.portalId} but HUBSPOT_PORTAL_ID is ${config.hubspotPortalId}.`
    );
  }
  return { path: full, ...ids };
}

module.exports = {
  getConfig,
  requireEnv,
  loadEnvFile,
  loadServiceMap,
  loadHubSpotIds,
  missingHubSpotIds,
  isProductionEnv,
  resolveFromRoot,
};
