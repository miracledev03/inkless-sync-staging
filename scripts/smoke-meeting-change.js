#!/usr/bin/env node
/**
 * Feature 4.2.1 Phase C smoke — reschedule / cancel.
 *
 * Usage:
 *   node scripts/smoke-meeting-change.js --appointment=urn:blvd:Appointment:... --start=2026-11-19T18:30:00.000Z
 *   node scripts/smoke-meeting-change.js --appointment=... --start=... --reschedule
 *   node scripts/smoke-meeting-change.js --appointment=... --cancel
 *   node scripts/smoke-meeting-change.js --appointment=... --cancel --dry
 */
const { getConfig } = require('../src/config');
const {
  processMeetingRescheduled,
  processMeetingCanceled,
} = require('../src/handlers/meeting-sync');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

async function main() {
  const config = getConfig();
  const appointmentId = arg('appointment') || arg('appointmentId');
  if (!appointmentId) {
    console.error('Pass --appointment=<blvd appointment id>');
    process.exit(1);
  }

  const dryRun = Boolean(arg('dry')) || !arg('reschedule') && !arg('cancel');
  // Default: dry cancel probe if neither flag; prefer explicit flags.

  if (arg('reschedule') || (arg('start') && !arg('cancel'))) {
    const start = arg('start');
    if (!start) {
      console.error('Reschedule requires --start=ISO or local NaiveDateTime');
      process.exit(1);
    }
    const result = await processMeetingRescheduled(config, {
      appointmentId,
      contactId: arg('contact') || undefined,
      startTime: start,
      dryRun: !arg('reschedule') || Boolean(arg('dry')),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (arg('cancel') || dryRun) {
    const result = await processMeetingCanceled(config, {
      appointmentId,
      contactId: arg('contact') || undefined,
      dryRun: !arg('cancel') || Boolean(arg('dry')),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error('Pass --reschedule or --cancel (add --dry to probe)');
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.localStart) console.error('localStart:', err.localStart);
  if (err.times) console.error('times:', JSON.stringify(err.times.slice(0, 8), null, 2));
  process.exit(1);
});
