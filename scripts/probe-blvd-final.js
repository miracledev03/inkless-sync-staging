#!/usr/bin/env node
const blvd = require('../src/blvd/api');
const { getConfig } = require('../src/config');

async function main() {
  const config = getConfig();
  const id =
    process.argv.find((a) => a.startsWith('--appointment='))?.slice(14) ||
    'urn:blvd:Appointment:15b13322-68dd-413e-ae4b-2830304d59a6';

  const appt = await blvd.getAppointment(config, id);
  console.log('current', {
    id: appt?.id,
    state: appt?.state,
    cancelled: appt?.cancelled,
    startAt: appt?.startAt,
  });

  for (const state of ['FINAL', 'ARRIVED', 'ACTIVE', 'CONFIRMED']) {
    const response = await blvd.adminExecute(
      config,
      `mutation($input: UpdateAppointmentInput!) {
        updateAppointment(input: $input) {
          appointment { id state cancelled }
        }
      }`,
      { input: { id, state } }
    );
    console.log(
      'try',
      state,
      JSON.stringify({
        data: response.data?.updateAppointment?.appointment || null,
        errors: response.errors || null,
      })
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
