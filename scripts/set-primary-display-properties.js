/**
 * Point HubSpot custom-object primary display at human labels (not IDs / "none").
 *
 * Usage: npm run staging:set-primary-display
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');

async function setPrimary(token, objectTypeId, primaryDisplayProperty) {
  const updated = await hs.hsRequest(
    token,
    'PATCH',
    `/crm/v3/schemas/${objectTypeId}`,
    { primaryDisplayProperty }
  );
  return {
    objectTypeId,
    primaryDisplayProperty: updated.primaryDisplayProperty,
  };
}

async function main() {
  const c = getConfig();
  const appt = await hs.resolveObjectTypeId(c.hubspotToken, c.appointmentObject);
  const order = await hs.resolveObjectTypeId(c.hubspotToken, c.orderObject);
  const results = {
    appointment: await setPrimary(
      c.hubspotToken,
      appt.objectTypeId,
      'blvd_appointment_label'
    ),
    order: await setPrimary(
      c.hubspotToken,
      order.objectTypeId,
      'blvd_order_label'
    ),
  };
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
