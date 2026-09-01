const { getConfig } = require('../src/config');
const { loadServiceMap } = require('../src/config');
const blvd = require('../src/blvd/api');
const { classifyAppointmentServices } = require('../src/classify-service');
const { resolveInPersonConsultMatrix } = require('../src/matrix/in-person-consult');

async function main() {
  const config = getConfig();
  const idArg = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  const appointmentId =
    idArg || 'urn:blvd:Appointment:c3253094-cdfc-4730-9b48-daec2bdc98af';
  const eventType =
    process.argv.find((a) => a.startsWith('--event='))?.slice(8) ||
    'APPOINTMENT_CREATED';

  const appointment = await blvd.getAppointment(config, appointmentId);
  if (!appointment) {
    console.error('appointment not found:', appointmentId);
    process.exit(1);
  }

  const classification = classifyAppointmentServices(
    config,
    appointment.appointmentServices || []
  );
  const matrix = resolveInPersonConsultMatrix(
    appointment,
    eventType,
    classification
  );

  console.log('appointment', appointment.id);
  console.log('state', appointment.state);
  console.log('cancelled', appointment.cancelled);
  console.log('cancellation', appointment.cancellation);
  console.log('primary role', classification.primary?.role);
  console.log('outcome driver', classification.primary?.outcomeDriver);
  console.log('--- matrix ---');
  console.log(JSON.stringify(matrix, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
