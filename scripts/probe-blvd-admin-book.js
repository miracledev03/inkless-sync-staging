#!/usr/bin/env node
/**
 * Probe Admin bookingCreate → setStaff → setStartTime → setDelivery → complete
 * (exact time; no Client API / Precision Scheduling).
 *
 *   node scripts/probe-blvd-admin-book.js --dry
 *   node scripts/probe-blvd-admin-book.js --apply --start=2026-11-26T15:00:00
 */
process.env.ENV_FILE = process.env.ENV_FILE || '.env.staging';
const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

async function main() {
  const c = getConfig();
  const apply = Boolean(arg('apply'));
  const startLocal = arg('start') || '2026-11-26T15:00:00';

  const locs = await blvd.listLocations(c);
  const locationId = locs[0]?.id;
  console.log('location', locationId, locs[0]?.name, locs[0]?.tz);

  const types = [
    'BookingCreateInput',
    'BookingAddServiceInput',
    'BookingServiceSetStaffInput',
    'BookingSetStartTimeInput',
    'BookingSetDeliveryMethodInput',
    'BookingCompleteInput',
  ];
  for (const name of types) {
    const r = await blvd.adminExecute(
      c,
      `query($name: String!) {
        __type(name: $name) {
          inputFields { name type { kind name ofType { kind name ofType { name } } } }
        }
      }`,
      { name }
    );
    console.log(
      name,
      (r.data?.__type?.inputFields || []).map((f) => f.name).join(', ')
    );
  }

  if (!apply) {
    console.log('Pass --apply to create a real admin booking (needs client/service/staff).');
    return;
  }

  // Use known staging Virtual EN service + Joey staff + fixture client
  const serviceId = 'urn:blvd:Service:fe325443-c17d-4299-b52e-88c08409d708';
  const staffId = 'urn:blvd:Staff:42e5b97d-7c6a-4d90-ba3d-908994ef205d';
  const clientId = 'urn:blvd:Client:633b139d-29bb-4ecd-a1b7-79658b62b32a';

  const result = await blvd.createAdminBooking(c, {
    locationId,
    clientId,
    serviceId,
    staffId,
    startTime: startLocal,
    deliveryMethod: 'VIDEO',
    bookWithStaffId: staffId,
    notes: 'probe admin exact-time book',
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  if (e.body) console.error(JSON.stringify(e.body, null, 2).slice(0, 2000));
  process.exit(1);
});
