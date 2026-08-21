/**
 * Copy BLVD_* keys from Boulevard Auth test .env into sync-middleware .env.staging
 * without printing secret values.
 */
const fs = require('fs');
const path = require('path');

function parseEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function writeEnv(filePath, values) {
  const keys = Object.keys(values);
  const lines = keys.map((k) => `${k}=${values[k] ?? ''}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

const authEnvPath = path.join(
  __dirname,
  '..',
  '..',
  'Boulevard',
  'Auth test',
  '.env'
);
const stagingPath = path.join(__dirname, '..', '.env.staging');
const examplePath = path.join(__dirname, '..', '.env.staging.example');

const auth = parseEnv(authEnvPath);
const staging = {
  ...parseEnv(examplePath),
  ...parseEnv(stagingPath),
};

const copyKeys = [
  'BLVD_BUSINESS_ID',
  'BLVD_API_KEY',
  'BLVD_SECRET_KEY',
  'BLVD_ENV',
  'WEBHOOK_PUBLIC_URL',
  'WEBHOOK_PORT',
];

for (const key of copyKeys) {
  if (auth[key]) staging[key] = auth[key];
}
if (auth.WEBHOOK_PORT && !staging.PORT) staging.PORT = auth.WEBHOOK_PORT;

writeEnv(stagingPath, staging);

const report = copyKeys.map((k) => `${k}=${auth[k] ? 'copied' : 'missing'}`);
console.log('Merged BLVD env into .env.staging');
console.log(report.join('\n'));
console.log(
  `HUBSPOT_ACCESS_TOKEN=${staging.HUBSPOT_ACCESS_TOKEN ? 'present' : 'MISSING'}`
);
