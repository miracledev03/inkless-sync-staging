/**
 * Smoke / inspect C2 BLVD-first consult ensure.
 * Usage:
 *   node scripts/inspect-blvd-first-consult.js --appointmentId=urn:blvd:Appointment:...
 *   node scripts/inspect-blvd-first-consult.js --appointmentId=... --apply
 */
const { getConfig } = require('../src/config');
const { processAppointmentWebhook } = require('../src/handlers/appointments');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const config = getConfig();
  const appointmentId =
    arg('appointmentId') ||
    'urn:blvd:Appointment:8e2ea4ab-4fa4-4d10-a1c9-2794d2ec65d5';
  const apply = process.argv.includes('--apply');

  console.log({ appointmentId, dryRun: !apply });
  const result = await processAppointmentWebhook(config, {
    eventType: 'APPOINTMENT_CREATED',
    payload: { resourceId: appointmentId },
    dryRun: !apply,
  });
  console.log(
    JSON.stringify(
      {
        action: result.action,
        origin: result.origin,
        role: result.pipeline,
        consultationType: result.consultationType,
        blvdFirstConsult: result.blvdFirstConsult,
        matrix: result.matrix?.matrix || result.matrix,
        associations: result.hubspot?.associations || null,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
