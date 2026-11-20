/**
 * Feature 4.2.1 — resolve Boulevard locationId from Clinic Location on the contact.
 */
const hs = require('../hubspot/client');
const log = require('../logger');

function matchLocation(locations, raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const byId = locations.find(
    (l) =>
      l.id === value ||
      String(l.id).endsWith(value) ||
      (value.includes('Location') && l.id === value)
  );
  if (byId) return byId;
  const lower = value.toLowerCase();
  return (
    locations.find(
      (l) =>
        String(l.name || '').toLowerCase() === lower ||
        String(l.businessName || '').toLowerCase() === lower
    ) || null
  );
}

/**
 * @returns {Promise<{ locationId: string|null, source: string, raw: string|null }>}
 */
async function resolveClinicLocationId(config, opts = {}) {
  const locations = opts.locations || [];
  if (opts.locationId) {
    const hit = matchLocation(locations, opts.locationId);
    return {
      locationId: hit?.id || String(opts.locationId),
      source: 'body',
      raw: String(opts.locationId),
    };
  }

  const prop = config.clinicLocationProperty || 'clinic_location';
  const contactId = opts.contactId;
  if (!contactId) {
    return {
      locationId: locations[0]?.id || null,
      source: 'fallback_first',
      raw: null,
    };
  }

  let raw = null;
  try {
    const contact = await hs.getContact(config.hubspotToken, contactId, [prop]);
    raw = contact?.properties?.[prop] || null;
  } catch (err) {
    log.warn('clinic location contact read failed', {
      contactId,
      error: err.message,
    });
  }

  if (raw) {
    const direct = matchLocation(locations, raw);
    if (direct) {
      return { locationId: direct.id, source: 'contact_property', raw };
    }

    // HubSpot locations custom object id → BLVD external id property
    try {
      const objectType = config.locationObject || 'locations';
      const blvdProp = config.locationBlvdIdProperty || 'location_external_id';
      const loc = await hs.hsRequest(
        config.hubspotToken,
        'GET',
        `/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(
          String(raw)
        )}?properties=${encodeURIComponent(
          [blvdProp, 'name', 'location_name'].join(',')
        )}`
      );
      const blvdId = loc?.properties?.[blvdProp];
      if (blvdId) {
        const hit = matchLocation(locations, blvdId) || { id: String(blvdId) };
        return {
          locationId: hit.id,
          source: 'hs_location_object',
          raw: String(raw),
        };
      }
      const byName = matchLocation(
        locations,
        loc?.properties?.name || loc?.properties?.location_name
      );
      if (byName) {
        return {
          locationId: byName.id,
          source: 'hs_location_object_name',
          raw: String(raw),
        };
      }
    } catch (err) {
      log.warn('clinic location HS object lookup failed', {
        contactId,
        raw,
        error: err.message,
      });
    }
  }

  return {
    locationId: locations[0]?.id || null,
    source: raw ? 'fallback_unresolved' : 'fallback_first',
    raw,
  };
}

module.exports = {
  matchLocation,
  resolveClinicLocationId,
};
