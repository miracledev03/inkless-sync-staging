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

function getConfig() {
  // Local: .env.staging; hosted: platform env vars (and optional .env)
  loadEnvFile(path.join(__dirname, '..', '.env.staging'));
  loadEnvFile(path.join(__dirname, '..', '.env'));

  const env = process.env.BLVD_ENV || 'sandbox';
  const adminUrl =
    env === 'prod'
      ? 'https://dashboard.boulevard.io/api/2020-01/admin'
      : 'https://sandbox.joinblvd.com/api/2020-01/admin';

  return {
    hubspotPortalId: process.env.HUBSPOT_PORTAL_ID || '',
    hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN || '',
    blvdEnv: env,
    blvdAdminUrl: adminUrl,
    blvdBusinessId: process.env.BLVD_BUSINESS_ID || '',
    blvdApiKey: process.env.BLVD_API_KEY || '',
    blvdSecretKey: process.env.BLVD_SECRET_KEY || '',
    port: Number(process.env.PORT || 3456),
    webhookPath: process.env.BLVD_WEBHOOK_PATH || '/webhooks/boulevard',
    webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL || '',
    serviceMapPath:
      process.env.SERVICE_MAP_PATH || './config/service-map.staging.json',
    languageProperty: process.env.HUBSPOT_LANGUAGE_PROPERTY || 'language',
    blvdClientIdProperty:
      process.env.HUBSPOT_BLVD_CLIENT_ID_PROPERTY || 'blvd_client_id',
    locationObject: process.env.HUBSPOT_LOCATION_OBJECT || 'locations',
    locationBlvdIdProperty:
      process.env.HUBSPOT_LOCATION_BLVD_ID_PROPERTY ||
      'location_external_id',
    /** Lifecycle label for A6 historical backfill (Joey). */
    importedBlvdLifecycleLabel:
      process.env.HUBSPOT_IMPORTED_BLVD_LIFECYCLE_LABEL || 'Imported - BLVD',
    /**
     * Optional hard-coded lifecyclestage value. When empty, resolved/created
     * via ensureImportedBlvdLifecycleStage (sandbox: 1422909443).
     */
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
  };
}

function loadServiceMap(config = getConfig()) {
  const full = path.isAbsolute(config.serviceMapPath)
    ? config.serviceMapPath
    : path.join(__dirname, '..', config.serviceMapPath);
  if (!fs.existsSync(full)) {
    return { path: full, map: null };
  }
  return { path: full, map: JSON.parse(fs.readFileSync(full, 'utf8')) };
}

module.exports = { getConfig, requireEnv, loadEnvFile, loadServiceMap };
