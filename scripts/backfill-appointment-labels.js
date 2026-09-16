/**
 * Backfill blvd_appointment_label on existing HubSpot BLVD Appointments
 * by re-running appointment upsert (also refreshes sync health fields).
 *
 * Usage:
 *   node scripts/backfill-appointment-labels.js --limit=20
 *   node scripts/backfill-appointment-labels.js --id=urn:blvd:Appointment:...
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');
const { processAppointmentWebhook } = require('../src/handlers/appointments');

async function main() {
  const c = getConfig();
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const idArg = process.argv.find((a) => a.startsWith('--id='));
  const limit = Number(limitArg?.slice(8) || 25);
  const onlyId = idArg?.slice(5) || null;

  const meta = await hs.resolveObjectTypeId(
    c.hubspotToken,
    c.appointmentObject
  );
  const props = [
    c.appointmentIdProperty || 'blvd_appointment_id',
    'blvd_appointment_label',
  ];

  let appointments = [];
  if (onlyId) {
    appointments = [{ properties: { [props[0]]: onlyId } }];
  } else {
    const found = await hs.hsRequest(
      c.hubspotToken,
      'POST',
      `/crm/v3/objects/${meta.objectTypeId}/search`,
      {
        filterGroups: [],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        properties: props,
        limit: Math.min(100, Math.max(1, limit)),
      }
    );
    appointments = found.results || [];
  }

  const summary = { total: appointments.length, updated: 0, errors: 0, results: [] };
  for (const row of appointments) {
    const appointmentId =
      row.properties?.[c.appointmentIdProperty || 'blvd_appointment_id'];
    if (!appointmentId) {
      summary.errors += 1;
      summary.results.push({ action: 'skip', reason: 'missing_blvd_id' });
      continue;
    }
    try {
      const result = await processAppointmentWebhook(c, {
        eventType: 'APPOINTMENT_UPDATED',
        payload: { resourceId: appointmentId },
      });
      summary.updated += 1;
      summary.results.push({
        appointmentId,
        hsId: result.hubspot?.appointment?.hsId || row.id,
        label: result.appointmentProperties?.blvd_appointment_label || null,
      });
    } catch (err) {
      summary.errors += 1;
      summary.results.push({
        appointmentId,
        error: err.message,
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors && !summary.updated) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
