/** Origin System values — must match HubSpot `blvd_appointment_source` options. */
const ORIGIN = {
  HUBSPOT: 'Hubspot',
  BLVD: 'BLVD',
};

function originFromWebhook() {
  return ORIGIN.BLVD;
}

/**
 * Echo of our own HS→BLVD create: keep Hubspot origin.
 * First BLVD-origin write: set BLVD.
 */
function resolveOrigin(existingOrigin, incomingOrigin) {
  if (existingOrigin === ORIGIN.HUBSPOT) return ORIGIN.HUBSPOT;
  return incomingOrigin || ORIGIN.BLVD;
}

/** Only HubSpot-origin meetings may create a Boulevard appointment (B10 / 4.2). */
function mayCreateBlvdAppointment(origin) {
  return origin === ORIGIN.HUBSPOT;
}

module.exports = {
  ORIGIN,
  originFromWebhook,
  resolveOrigin,
  mayCreateBlvdAppointment,
};
