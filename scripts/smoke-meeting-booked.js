#!/usr/bin/env node
/**
 * Feature 4.2.1 smoke — Meeting Type / Outcome / same-slot / optional book.
 *
 * Usage:
 *   node scripts/smoke-meeting-booked.js
 *   node scripts/smoke-meeting-booked.js --contact=242617729455
 *   node scripts/smoke-meeting-booked.js --contact=... --start=2026-11-17T17:00:00.000Z
 *   node scripts/smoke-meeting-booked.js --contact=... --start=2026-11-17T09:00:00 --book
 */
const { getConfig } = require('../src/config');
const {
  loadMeetingTypes,
  resolveServiceKeyFromMeeting,
  resolveOutcomeMapping,
} = require('../src/meeting-types');
const {
  matchBookableTime,
  toLocationLocalNaive,
} = require('../src/time');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

function assertSameSlot() {
  const tz = 'America/Los_Angeles';
  const times = [
    { id: 't1', startTime: '2026-11-17T09:00:00-08:00' },
    { id: 't2', startTime: '2026-11-17T10:30:00-08:00' },
  ];
  const utc = '2026-11-17T17:00:00.000Z'; // 09:00 PT
  const local = toLocationLocalNaive(utc, tz);
  const hit = matchBookableTime(times, utc, tz);
  if (local.slice(0, 16) !== '2026-11-17T09:00') {
    throw new Error(`expected local 09:00 PT, got ${local}`);
  }
  if (!hit || hit.id !== 't1') {
    throw new Error(`same-slot match failed for UTC→PT (got ${hit && hit.id})`);
  }
  const naive = matchBookableTime(times, '2026-11-17T09:00:00', tz);
  if (!naive || naive.id !== 't1') {
    throw new Error('same-slot match failed for naive local');
  }
  console.log('same-slot OK:', { utc, local, matched: hit.id });
}

async function main() {
  assertSameSlot();

  const config = getConfig();
  const { path, map } = loadMeetingTypes(config);
  console.log('meeting-types:', path);
  console.log(
    'types:',
    Object.entries(map?.types || {}).map(([k, v]) => ({
      key: k,
      serviceKey: v.serviceKey,
      meetingTypeId: v.meetingTypeId || '(fill from HubSpot)',
      meetingTypeName: v.meetingTypeName,
    }))
  );
  console.log(
    'staff:',
    (map?.staff || []).map((s) => ({
      label: s.label,
      blvdStaffId: s.blvdStaffId || '(fill)',
      namePatterns: s.namePatterns,
    }))
  );
  console.log('clinicLocationProperty:', config.clinicLocationProperty);

  for (const sample of ['Completed', 'No show', 'Canceled', 'bogus']) {
    console.log('outcome', sample, '→', resolveOutcomeMapping(map, sample));
  }

  const contactId = arg('contact') || arg('contactId');
  if (!contactId) {
    console.log(
      '\nMap + same-slot OK. Pass --contact=<id> [--start=ISO] to probe /meeting-booked.'
    );
    return;
  }

  const serviceKey =
    arg('service') ||
    resolveServiceKeyFromMeeting(map, {
      meetingTypeName: arg('type') || 'Virtual EN',
    }) ||
    'virtual_consult_en';

  const doBook = Boolean(arg('book'));
  const body = {
    contactId: String(contactId),
    serviceKey,
    startTime: arg('start') || undefined,
    dryRun: !doBook,
    availabilityOnly: !doBook && !arg('start'),
  };

  const { processMeetingBooked } = require('../src/handlers/meeting-sync');
  const result = await processMeetingBooked(config, body);
  console.log(JSON.stringify(result, null, 2));
  if (result.action === 'booked') {
    console.log('\nOK — Meeting booked path created Boulevard appointment.');
  } else if (result.action === 'availability' || result.action === 'needs_start_time') {
    console.log('\nOK — availability probe. Re-run with --start=… and optional --book.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.localStart) console.error('localStart:', err.localStart);
  if (err.times) console.error('times sample:', err.times.slice(0, 6));
  process.exit(1);
});
