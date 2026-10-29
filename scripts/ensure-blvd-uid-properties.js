/**
 * Create unique HubSpot properties used for batch/upsert:
 *   blvd_appointments.blvd_appointment_uid
 *   blvd_orders.blvd_order_uid
 *
 * Uniqueness can only be set at property create time.
 *
 * Usage:
 *   ENV_FILE=.env.production node scripts/ensure-blvd-uid-properties.js
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');

async function ensureUniqueProperty(token, objectTypeId, def) {
  let existing = null;
  try {
    existing = await hs.hsRequest(
      token,
      'GET',
      `/crm/v3/properties/${objectTypeId}/${def.name}`
    );
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (existing?.name) {
    const unique = existing.hasUniqueValue === true;
    return {
      name: def.name,
      action: unique ? 'exists_unique' : 'exists_not_unique',
      hasUniqueValue: unique,
    };
  }
  await hs.hsRequest(token, 'POST', `/crm/v3/properties/${objectTypeId}`, {
    name: def.name,
    label: def.label,
    type: 'string',
    fieldType: 'text',
    groupName: def.groupName,
    description: def.description,
    hasUniqueValue: true,
  });
  return { name: def.name, action: 'created', hasUniqueValue: true };
}

async function main() {
  const c = getConfig();
  const apptUid = c.appointmentUidProperty || 'blvd_appointment_uid';
  const orderUid = c.orderUidProperty || 'blvd_order_uid';

  const appt = await hs.resolveObjectTypeId(c.hubspotToken, c.appointmentObject);
  const order = await hs.resolveObjectTypeId(c.hubspotToken, c.orderObject);

  const results = {
    appointment: await ensureUniqueProperty(c.hubspotToken, appt.objectTypeId, {
      name: apptUid,
      label: 'BLVD Appointment UID',
      groupName: 'blvd_appointments_information',
      description:
        'Unique Boulevard appointment URN for HubSpot batch/upsert. Same value as blvd_appointment_id.',
    }),
    order: await ensureUniqueProperty(c.hubspotToken, order.objectTypeId, {
      name: orderUid,
      label: 'BLVD Order UID',
      groupName: 'blvd_orders_information',
      description:
        'Unique Boulevard order URN for HubSpot batch/upsert. Same value as blvd_order_id.',
    }),
  };

  console.log(JSON.stringify({ ok: true, results }, null, 2));
  if (
    results.appointment.action === 'exists_not_unique' ||
    results.order.action === 'exists_not_unique'
  ) {
    console.error(
      'ERROR: uid property exists without hasUniqueValue. Create a new property name via env and retry.'
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
