/**
 * Staging: publish bookable staff shifts so Client API cartBookableDates
 * returns slots (needed for B10 checkout smoke).
 */
const { getConfig } = require('../src/config');
const { generateAdminToken } = require('../src/blvd/auth');
const { executeGraphQL, formatErrors } = require('../src/blvd/client');
const { listLocations } = require('../src/blvd/api');

const JOEY_STAFF_ID = 'urn:blvd:Staff:42e5b97d-7c6a-4d90-ba3d-908994ef205d';

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function nextWeekdays(count) {
  const out = [];
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay(); // 0 Sun .. 6 Sat
    if (day >= 1 && day <= 5) out.push(ymd(d));
  }
  return out;
}

async function main() {
  const c = getConfig();
  const token = generateAdminToken(
    c.blvdBusinessId,
    c.blvdApiKey,
    c.blvdSecretKey
  );
  const locs = await listLocations(c);
  const locationId = locs[0].id;
  const dates = nextWeekdays(10);

  console.log('Creating shifts for Joey at', locs[0].name);
  console.log('dates', dates);

  for (const date of dates) {
    const res = await executeGraphQL(
      c.blvdAdminUrl,
      token,
      `mutation($input: CreateShiftInput!) {
        createShift(input: $input) {
          shift {
            id
            date
            startTime
            endTime
            available
            staff { displayName }
          }
        }
      }`,
      {
        input: {
          locationId,
          staffId: JOEY_STAFF_ID,
          date,
          startTime: '09:00:00',
          endTime: '17:00:00',
          available: true,
        },
      }
    );
    if (res.errors?.length) {
      console.log(date, formatErrors(res.errors));
    } else {
      const s = res.data.createShift.shift;
      console.log(
        date,
        s.id,
        s.startTime,
        '-',
        s.endTime,
        'available',
        s.available
      );
    }
  }

  // List shifts
  const list = await executeGraphQL(
    c.blvdAdminUrl,
    token,
    `query($locationId: ID!, $start: Date!, $end: Date!, $staffIds: [ID!]) {
      shifts(
        locationId: $locationId
        startIso8601: $start
        endIso8601: $end
        staffIds: $staffIds
      ) {
        staffId
        shifts {
          id
          date
          startTime
          endTime
          available
        }
      }
    }`,
    {
      locationId,
      start: dates[0],
      end: dates[dates.length - 1],
      staffIds: [JOEY_STAFF_ID],
    }
  );
  if (list.errors?.length) {
    console.log('list err', formatErrors(list.errors));
    console.log(JSON.stringify(list.errors, null, 2).slice(0, 1500));
  } else {
    console.log('\nlisted', JSON.stringify(list.data, null, 2).slice(0, 2500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
