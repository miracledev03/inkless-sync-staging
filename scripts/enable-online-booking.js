/**
 * Enable Client API / online booking for Inkless consult + $100 services.
 * Sets staffServiceRuleUpsert { setBookable, setExternallyBookable } for all
 * active staff × mapped services at the first (or --locationId=) location.
 *
 * Usage: node scripts/enable-online-booking.js
 */
const { getConfig, loadServiceMap } = require('../src/config');
const { generateAdminToken } = require('../src/blvd/auth');
const { executeGraphQL, formatErrors } = require('../src/blvd/client');
const blvd = require('../src/blvd/api');
const clientApi = require('../src/blvd/client-api');

async function adminGql(config, query, variables) {
  const token = generateAdminToken(
    config.blvdBusinessId,
    config.blvdApiKey,
    config.blvdSecretKey
  );
  return executeGraphQL(config.blvdAdminUrl, token, query, variables);
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const config = getConfig();
  const { map } = loadServiceMap(config);
  if (!map) throw new Error('service map missing');

  const locs = await blvd.listLocations(config);
  const locationId = arg('locationId') || locs[0]?.id;
  if (!locationId) throw new Error('no location');

  const services = [
    map.virtual_consult_en,
    map.virtual_consult_es,
    map.in_office_consult,
    map.first_session_100,
  ].filter(Boolean);

  const staffRes = await adminGql(
    config,
    `query {
      staff(first: 50) {
        edges { node { id firstName lastName active } }
      }
    }`
  );
  const staff = (staffRes.data.staff.edges || [])
    .map((e) => e.node)
    .filter((s) => s.active);

  console.log('location', locationId);
  console.log(
    'staff',
    staff.map((s) => `${s.firstName} ${s.lastName}`).join(', ')
  );
  console.log('services', services.length);

  for (const s of staff) {
    for (const serviceId of services) {
      const res = await adminGql(
        config,
        `mutation($input: StaffServiceRuleUpsertInput!) {
          staffServiceRuleUpsert(input: $input) {
            staffServiceRule {
              staffId
              serviceId
              setBookable
              setExternallyBookable
            }
          }
        }`,
        {
          input: {
            staffId: s.id,
            serviceId,
            locationId,
            setBookable: true,
            setExternallyBookable: true,
          },
        }
      );
      if (res.errors?.length) {
        console.error(s.firstName, serviceId, formatErrors(res.errors));
      }
    }
  }

  for (const serviceId of services) {
    const act = await adminGql(
      config,
      `mutation($input: ServiceActivateAtLocationInput!) {
        serviceActivateAtLocation(input: $input) {
          serviceId
          locationId
          active
        }
      }`,
      { input: { serviceId, locationId } }
    );
    if (act.errors?.length) {
      console.error('activate', serviceId, formatErrors(act.errors));
    }
  }

  const cart = await clientApi.createCart(config, { locationId });
  const details = await clientApi.getServiceDetails(config, cart.id, services, {
    includeNonExternallyBookable: true,
  });
  console.log(
    'Client API details:',
    (details.details || []).map((d) => `${d.name} bookable=${d.bookable}`)
  );
  console.log('notFoundIds', details.notFoundIds || []);
  console.log(
    'menu',
    (cart.availableCategories || []).map((cat) => ({
      name: cat.name,
      items: (cat.availableItems || []).map((i) => i.name),
    }))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
