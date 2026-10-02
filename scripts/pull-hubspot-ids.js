/**
 * Read pipeline / stage / lifecycle internal IDs from the configured HubSpot portal
 * by label and fill the active HubSpot ID map (HUBSPOT_ID_MAP_PATH;
 * production default config/hubspot-ids.production.json).
 *
 *   $env:ENV_FILE='.env.production'; npm run pull:hubspot-ids              # print only
 *   $env:ENV_FILE='.env.production'; npm run pull:hubspot-ids -- --write   # save
 *
 * Labels come from the target file, falling back to config/hubspot-ids.staging.json.
 */
const fs = require('fs');
const path = require('path');
const { getConfig, resolveFromRoot, missingHubSpotIds } = require('../src/config');
const hs = require('../src/hubspot/client');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function findByLabel(items, label) {
  const want = norm(label);
  return items.find((i) => norm(i.label) === want) || null;
}

async function main() {
  const write = process.argv.includes('--write');
  const config = getConfig();
  if (!config.hubspotToken) throw new Error('HUBSPOT_ACCESS_TOKEN is not set');

  const targetPath = resolveFromRoot(config.hubspotIdMapPath);
  const template = readJson(path.join(__dirname, '..', 'config', 'hubspot-ids.staging.json'));
  const target = readJson(targetPath) || JSON.parse(JSON.stringify(template));

  const labelsOf = (section, key) =>
    target[section]?.[key] || template[section]?.[key] || {};

  let portalId = config.hubspotPortalId || '';
  try {
    const acct = await hs.hsRequest(config.hubspotToken, 'GET', '/account-info/v3/details');
    if (acct?.portalId) portalId = String(acct.portalId);
  } catch (err) {
    console.warn(`account-info lookup failed (${err.message}); using HUBSPOT_PORTAL_ID`);
  }
  if (config.hubspotPortalId && portalId && String(config.hubspotPortalId) !== portalId) {
    throw new Error(
      `Token belongs to portal ${portalId} but HUBSPOT_PORTAL_ID is ${config.hubspotPortalId}`
    );
  }

  console.log(`Portal: ${portalId || '(unknown)'}  →  ${targetPath}\n`);

  const pipelines = (await hs.hsRequest(config.hubspotToken, 'GET', '/crm/v3/pipelines/deals')).results || [];

  for (const [section, fallback] of [
    ['acquisition', /acquisition/i],
    ['treatmentJourney', /treatment\s*journey/i],
  ]) {
    const pipelineLabel = target[section]?.pipelineLabel || template[section].pipelineLabel;
    const pl =
      findByLabel(pipelines, pipelineLabel) ||
      pipelines.find((p) => fallback.test(p.label)) ||
      null;
    target[section] = target[section] || {};
    target[section].pipelineLabel = pipelineLabel;
    target[section].stageLabels = labelsOf(section, 'stageLabels');
    target[section].stages = target[section].stages || {};
    if (!pl) {
      console.log(`MISSING pipeline "${pipelineLabel}"`);
      continue;
    }
    target[section].pipelineId = pl.id;
    console.log(`PIPELINE ${section}: ${pl.id}  "${pl.label.trim()}"`);
    for (const [key, label] of Object.entries(target[section].stageLabels)) {
      const st = findByLabel(pl.stages || [], label);
      if (st) {
        target[section].stages[key] = st.id;
        console.log(`  ${key.padEnd(30)} ${st.id}  "${st.label.trim()}"`);
      } else {
        target[section].stages[key] = '';
        console.log(`  ${key.padEnd(30)} MISSING (label "${label}")`);
      }
    }
    const unmatched = (pl.stages || []).filter(
      (s) => !Object.values(target[section].stages).includes(s.id)
    );
    for (const s of unmatched) {
      console.log(`  (unmapped stage in portal) ${s.id}  "${s.label.trim()}"`);
    }
  }

  const lc = await hs.hsRequest(config.hubspotToken, 'GET', '/crm/v3/properties/contacts/lifecyclestage');
  const options = lc.options || [];
  target.lifecycleLabels = Object.keys(target.lifecycleLabels || {}).length
    ? target.lifecycleLabels
    : template.lifecycleLabels;
  target.lifecycle = target.lifecycle || {};
  console.log('\nLIFECYCLE');
  const STANDARD = { lead: 'lead', activeCustomer: 'customer' };
  for (const [key, label] of Object.entries(target.lifecycleLabels)) {
    const opt =
      findByLabel(options, label) ||
      (STANDARD[key] ? options.find((o) => o.value === STANDARD[key]) : null);
    if (opt) {
      target.lifecycle[key] = opt.value;
      console.log(`  ${key.padEnd(30)} ${opt.value}  "${opt.label.trim()}"`);
    } else {
      target.lifecycle[key] = '';
      console.log(`  ${key.padEnd(30)} MISSING (label "${label}")`);
    }
  }

  target.env = config.isProduction ? 'production' : 'sandbox';
  target.portalId = portalId;
  target.notes = `Pulled from portal ${portalId} on ${new Date().toISOString().slice(0, 10)} by npm run pull:hubspot-ids.`;

  const stillMissing = missingHubSpotIds(target);
  console.log(
    stillMissing.length
      ? `\n${stillMissing.length} ID(s) missing: ${stillMissing.join(', ')}\nFix labels in the portal or set these by hand.`
      : '\nAll required IDs found.'
  );

  if (write) {
    fs.writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n');
    console.log(`Wrote ${targetPath}`);
  } else {
    console.log('Dry run. Re-run with --write to save.');
  }
  if (stillMissing.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
