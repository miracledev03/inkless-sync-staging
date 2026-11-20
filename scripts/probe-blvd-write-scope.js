#!/usr/bin/env node
/**
 * Check whether Admin OAuth can use appointment:write.
 * Dry by default: tries updateAppointment(CONFIRMED) which needs write but is a no-op if already CONFIRMED.
 * Pass --live-cancel only to actually cancel (destructive).
 */
const blvd = require('../src/blvd/api');
const oauth = require('../src/blvd/oauth');
const { getConfig } = require('../src/config');

async function main() {
  const config = getConfig();
  oauth.clearCache();
  const token = await oauth.getAdminToken(config);
  // Decode JWT payload if present (Boulevard tokens are often JWTs).
  let claims = null;
  try {
    const parts = String(token).split('.');
    if (parts.length === 3) {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    }
  } catch {
    claims = null;
  }
  console.log('auth', {
    mode: config.blvdAuthMode,
    env: config.blvdEnv,
    scopeClaim: claims?.scope || claims?.scp || null,
  });

  const id =
    process.argv.find((a) => a.startsWith('--appointment='))?.slice(14) ||
    'urn:blvd:Appointment:15b13322-68dd-413e-ae4b-2830304d59a6';

  const appt = await blvd.getAppointment(config, id);
  console.log('appointment', {
    id: appt?.id,
    state: appt?.state,
    cancelled: appt?.cancelled,
    startAt: appt?.startAt,
  });

  const response = await blvd.adminExecute(
    config,
    `mutation($input: UpdateAppointmentInput!) {
      updateAppointment(input: $input) {
        appointment { id state cancelled }
      }
    }`,
    { input: { id, state: 'CONFIRMED' } }
  );
  if (response.errors?.length) {
    const msg = response.errors.map((e) => e.message).join('; ');
    const scopeMissing = /missing required scope/i.test(msg);
    console.log('write_probe', {
      ok: false,
      scopeMissing,
      errors: response.errors,
    });
    process.exit(scopeMissing ? 2 : 1);
  }
  console.log('write_probe', {
    ok: true,
    appointment: response.data?.updateAppointment?.appointment,
  });
  console.log('appointment:write is granted.');
}

main().catch((err) => {
  console.error(err.code || 'ERROR', err.message || err);
  process.exit(1);
});
