#!/usr/bin/env node
const blvd = require('../src/blvd/api');
const { getConfig } = require('../src/config');

async function main() {
  const config = getConfig();
  const id =
    process.argv.find((a) => a.startsWith('--appointment='))?.slice(14) ||
    'urn:blvd:Appointment:f7afc613-b058-470e-bf48-4d6ebf285963';

  const before = await blvd.getAppointment(config, id);
  console.log('before', { state: before.state, cancelled: before.cancelled, orderId: before.orderId });

  // Re-run create+complete and print raw GraphQL responses
  const staffId = before.appointmentServices?.find((s) => s.staff?.id)?.staff?.id;
  console.log('staffId', staffId);

  const created = await blvd.adminExecute(
    config,
    `mutation($input: BookingCreateFromAppointmentInput!) {
      bookingCreateFromAppointment(input: $input) {
        booking { id }
        bookingWarnings { code message }
        bookingAppointments { id }
      }
    }`,
    { input: { appointmentId: id } }
  );
  console.log('create', JSON.stringify(created, null, 2));

  const bookingId = created.data?.bookingCreateFromAppointment?.booking?.id;
  if (!bookingId) process.exit(1);

  const completed = await blvd.adminExecute(
    config,
    `mutation($input: BookingCompleteInput!) {
      bookingComplete(input: $input) {
        booking { id }
        bookingWarnings { code message }
        bookingAppointments {
          id
          appointment { id state cancelled orderId }
        }
      }
    }`,
    {
      input: {
        bookingId,
        bookWithStaffId: staffId,
        notifyClient: false,
      },
    }
  );
  console.log('complete', JSON.stringify(completed, null, 2));

  const after = await blvd.getAppointment(config, id);
  console.log('after', { state: after.state, cancelled: after.cancelled, orderId: after.orderId });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
