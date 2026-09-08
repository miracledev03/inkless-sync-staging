/**
 * Seed weekday staff shifts so Client API cartBookableDates returns slots.
 * Default: Larry + Joey, next 14 days, 09:00–17:00 local.
 *
 * Usage: node scripts/seed-staff-shifts.js
 */
const { getConfig } = require('../src/config');
const { generateAdminToken } = require('../src/blvd/auth');
const { executeGraphQL, formatErrors } = require('../src/blvd/client');
const blvd = require('../src/blvd/api');

const DEFAULT_STAFF = [
  'urn:blvd:Staff:6d53de6d-64a2-42d1-8ada-e9d85949ee33', // Larry
  'urn:blvd:Staff:42e5b97d-7c6a-4d90-ba3d-908994ef205d', // Joey
];

async function adminGql(config, query, variables) {
  const token = generateAdminToken(
    config.blvdBusinessId,
    config.blvdApiKey,
    config.blvdSecretKey
  );
  return executeGraphQL(config.blvdAdminUrl, token, query, variables);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const config = getConfig();
  const locs = await blvd.listLocations(config);
  const locationId = locs[0]?.id;
  if (!locationId) throw new Error('no location');

  const start = new Date();
  start.setUTCHours(12, 0, 0, 0);
  let created = 0;
  let skipped = 0;

  for (let i = 0; i < 14; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    const date = ymd(d);
    for (const staffId of DEFAULT_STAFF) {
      const res = await adminGql(
        config,
        `mutation($input: CreateShiftInput!) {
          createShift(input: $input) {
            shift { id date staffId }
          }
        }`,
        {
          input: {
            locationId,
            staffId,
            date,
            startTime: '09:00:00',
            endTime: '17:00:00',
            available: true,
          },
        }
      );
      if (res.errors?.length) {
        skipped += 1;
        console.warn(date, formatErrors(res.errors));
      } else {
        created += 1;
        console.log('ok', date, res.data.createShift.shift.id);
      }
    }
  }
  console.log({ created, skipped, locationId });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
