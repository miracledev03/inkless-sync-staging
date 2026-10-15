/**
 * Staging unblock for B10: activate consult services at location and
 * upsert staff service rules with setBookable + setExternallyBookable.
 */
const { getConfig, loadServiceMap } = require('../src/config');
const { formatErrors } = require('../src/blvd/client');
const { listLocations, adminExecute } = require('../src/blvd/api');

const JOEY_STAFF_ID = 'urn:blvd:Staff:42e5b97d-7c6a-4d90-ba3d-908994ef205d';

async function main() {
  const c = getConfig();
  const { map } = loadServiceMap(c);
  const locs = await listLocations(c);
  const locationId = locs[0].id;

  const serviceKeys = [
    'virtual_consult_en',
    'virtual_consult_es',
    'in_office_consult',
    'first_session_100',
  ];

  for (const key of serviceKeys) {
    const serviceId = map[key];
    console.log('\n===', key, serviceId, '===');

    const act = await adminExecute(
      c,
      `mutation($input: ServiceActivateAtLocationInput!) {
        serviceActivateAtLocation(input: $input) {
          serviceId
          locationId
        }
      }`,
      { input: { serviceId, locationId } }
    );
    if (act.errors?.length) {
      console.log('activate', formatErrors(act.errors));
    } else {
      console.log('activate', act.data.serviceActivateAtLocation);
    }

    const upsert = await adminExecute(
      c,
      `mutation($input: StaffServiceRuleUpsertInput!) {
        staffServiceRuleUpsert(input: $input) {
          staffServiceRule {
            staffId
            locationId
            serviceId
            setBookable
            setExternallyBookable
            setDuration
            setPrice
          }
        }
      }`,
      {
        input: {
          staffId: JOEY_STAFF_ID,
          locationId,
          serviceId,
          setBookable: true,
          setExternallyBookable: true,
        },
      }
    );
    if (upsert.errors?.length) {
      console.log('upsert', formatErrors(upsert.errors));
    } else {
      console.log(
        'upsert',
        JSON.stringify(upsert.data.staffServiceRuleUpsert, null, 2)
      );
    }
  }

  // Verify staffServices now populated
  const ss = await adminExecute(
    c,
    `query($id: ID!) {
      location(id: $id) {
        staffServices(first: 50) {
          edges {
            node {
              staff { displayName }
              service { id name }
              price
              totalDuration
            }
          }
        }
      }
    }`,
    { id: locationId }
  );
  const edges = ss.data?.location?.staffServices?.edges || [];
  console.log('\nstaffServices count', edges.length);
  for (const e of edges) {
    console.log(
      ' ',
      e.node.service?.name,
      '->',
      e.node.staff?.displayName
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
