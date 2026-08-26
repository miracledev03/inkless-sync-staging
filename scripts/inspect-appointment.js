const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const { classifyServiceId } = require('../src/classify-service');
const { loadServiceMap } = require('../src/config');
const { processAppointmentWebhook } = require('../src/handlers/appointments');

async function main() {
  const config = getConfig();
  const { map } = loadServiceMap(config);
  const idArg = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  const fileArg = process.argv.find((a) => a.startsWith('--file='))?.slice(7);

  console.log('--- service map classification ---');
  for (const role of [
    'virtual_consult_en',
    'virtual_consult_es',
    'in_office_consult',
    'first_session_100',
  ]) {
    const classified = classifyServiceId(config, map?.[role]);
    console.log(role, classified.consultationType, classified.pipeline);
  }

  let payload;
  if (fileArg) {
    payload = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  } else {
    const appointmentId =
      idArg || 'urn:blvd:Appointment:c3253094-cdfc-4730-9b48-daec2bdc98af';
    payload = {
      eventType: 'APPOINTMENT_CREATED',
      resourceId: appointmentId,
    };
  }

  const eventType = payload.eventType || payload.event || 'APPOINTMENT_CREATED';
  const apply = process.argv.includes('--apply');
  const result = await processAppointmentWebhook(config, {
    eventType,
    payload,
    headers: {},
    dryRun: !apply,
  });
  console.log(
    apply
      ? '--- HubSpot upsert ---'
      : '--- planned HubSpot upsert (dry-run) ---'
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
