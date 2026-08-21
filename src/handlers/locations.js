const blvd = require('../blvd/api');
const hs = require('../hubspot/client');
const log = require('../logger');

function pickLocationProperty(available, candidates) {
  const set = new Set((available || []).map((p) => p.toLowerCase()));
  for (const c of candidates) {
    if (set.has(c.toLowerCase())) return c;
  }
  return null;
}

function mapLocationProperties(loc, propertyNames, blvdIdProp) {
  const available = propertyNames || [];
  const props = {};

  const idProp =
    pickLocationProperty(available, [
      blvdIdProp,
      'location_external_id',
      'blvd_location_id',
      'blvd_id',
      'boulevard_location_id',
      'external_id',
    ]) || blvdIdProp;
  props[idProp] = loc.id;

  const nameProp = pickLocationProperty(available, [
    'name',
    'location_name',
    'blvd_location_name',
  ]);
  if (nameProp) props[nameProp] = loc.name || loc.businessName || '';

  const line1 = pickLocationProperty(available, [
    'location_address',
    'address',
    'address_line_1',
    'street_address',
    'line1',
  ]);
  if (line1) props[line1] = loc.address?.line1 || '';

  const line2 = pickLocationProperty(available, [
    'location_address_2',
    'address_2',
    'line2',
  ]);
  if (line2) props[line2] = loc.address?.line2 || '';

  const city = pickLocationProperty(available, ['location_city', 'city']);
  if (city) props[city] = loc.address?.city || '';

  const state = pickLocationProperty(available, [
    'location_state',
    'state',
    'province',
  ]);
  // HubSpot sandbox location_state is currently an enum with limited options.
  // Skip mapping when the BLVD value would fail validation (e.g. CA).
  if (state && state !== 'location_state') {
    props[state] = loc.address?.state || '';
  } else if (state === 'location_state') {
    const allowed = new Set(['CO', 'NJ', 'NY', 'PA', 'WY']);
    const st = (loc.address?.state || '').toUpperCase();
    if (allowed.has(st)) props[state] = st;
  }

  const zip = pickLocationProperty(available, [
    'location_zip',
    'zip',
    'postal_code',
  ]);
  if (zip) props[zip] = loc.address?.zip || '';

  const phone = pickLocationProperty(available, ['location_phone', 'phone']);
  if (phone) props[phone] = loc.phone || '';

  const email = pickLocationProperty(available, [
    'location_email',
    'email',
    'contact_email',
  ]);
  if (email) props[email] = loc.contactEmail || '';

  const tz = pickLocationProperty(available, [
    'location_timezone',
    'timezone',
    'tz',
  ]);
  if (tz) props[tz] = loc.tz || '';

  return { props, idProp };
}

async function syncLocations(config) {
  const locations = await blvd.listLocations(config);
  const objectMeta = await hs.resolveObjectTypeId(
    config.hubspotToken,
    config.locationObject
  );

  const results = [];
  for (const loc of locations) {
    const { props, idProp } = mapLocationProperties(
      loc,
      objectMeta.properties,
      config.locationBlvdIdProperty
    );

    const existing = await hs.searchByProperty(
      config.hubspotToken,
      objectMeta.objectTypeId,
      idProp,
      loc.id
    );
    const hit = existing.results?.[0];
    if (hit) {
      const updated = await hs.updateObject(
        config.hubspotToken,
        objectMeta.objectTypeId,
        hit.id,
        props
      );
      log.info('location updated', {
        blvdId: loc.id,
        hsId: updated.id,
        name: loc.name,
      });
      results.push({ action: 'update', blvdId: loc.id, hsId: updated.id });
    } else {
      const created = await hs.createObject(
        config.hubspotToken,
        objectMeta.objectTypeId,
        props
      );
      log.info('location created', {
        blvdId: loc.id,
        hsId: created.id,
        name: loc.name,
      });
      results.push({ action: 'create', blvdId: loc.id, hsId: created.id });
    }
  }

  return {
    objectTypeId: objectMeta.objectTypeId,
    objectName: objectMeta.name,
    count: results.length,
    results,
  };
}

module.exports = { syncLocations, mapLocationProperties };
