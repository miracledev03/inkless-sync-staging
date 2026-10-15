/**
 * Checks every Boulevard query/mutation the sync uses against the configured API
 * (e.g. BLVD_AUTH_MODE=oauth → v2026-06). Writes nothing to Boulevard:
 * - Queries run for real (read-only), through the same functions the sync uses.
 * - Mutations are sent without their $input variable, so Boulevard validates the
 *   document (fields, types, scopes) and stops before executing anything.
 * The guest cart created by the Client API read checks is an unbooked, empty cart.
 *
 *   $env:BLVD_AUTH_MODE='oauth'; node scripts/check-blvd-api.js
 */
const clientMod = require('../src/blvd/client');

const realExecute = clientMod.executeGraphQL;
let validateOnly = false;
let lastValidation = null;
const ABORT = Symbol('validated');

clientMod.executeGraphQL = async (url, auth, query, variables) => {
  if (!validateOnly) return realExecute(url, auth, query, variables);
  try {
    lastValidation = await realExecute(url, auth, query, {});
  } catch (err) {
    const json = String(err.message).replace(/^HTTP \d+: /, '');
    try {
      lastValidation = JSON.parse(json);
    } catch {
      lastValidation = { errors: [{ message: err.message }] };
    }
  }
  throw ABORT;
};

const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');
const clientApi = require('../src/blvd/client-api');

const results = [];
function report(ok, name, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function read(name, fn) {
  try {
    report(true, name, (await fn()) || '');
  } catch (err) {
    report(false, name, err.message);
  }
}

const MISSING_VAR = /not provided|required type|non-null|must be provided|expected value of type|found null/i;

async function mutation(name, fn) {
  validateOnly = true;
  lastValidation = null;
  try {
    await fn();
  } catch (err) {
    if (err !== ABORT) {
      validateOnly = false;
      report(false, name, err.message);
      return;
    }
  }
  validateOnly = false;
  const errors = lastValidation?.errors || [];
  const real = errors.filter((e) => !MISSING_VAR.test(e.message || ''));
  if (!errors.length) {
    report(false, name, 'executed without errors (expected a missing-variable error)');
  } else if (real.length) {
    report(false, name, real.map((e) => e.message).join('; '));
  } else {
    report(true, name, 'document valid');
  }
}

async function main() {
  const c = getConfig();
  console.log(`BLVD ${c.blvdEnv} · auth ${c.blvdAuthMode} · API ${c.blvdApiVersion}`);
  console.log(`Admin:  ${c.blvdAdminUrl}\nClient: ${c.blvdClientApiUrl}\n`);

  let location;
  let client;
  let appointment;
  let orderId;

  console.log('Admin API — queries');
  await read('getBusiness', async () => (await blvd.getBusiness(c)).name);
  await read('listLocations', async () => {
    const locs = await blvd.listLocations(c);
    location = locs[0];
    return `${locs.length} location(s); first: ${location?.name} (tz ${location?.tz})`;
  });
  await read('listClients (1 page)', async () => {
    const list = await blvd.listClients(c, { first: 5, maxPages: 1 });
    client = list.find((x) => x.email) || list[0];
    const sample = client
      ? `email ${client.email ? 'yes' : 'no'}, phone ${client.mobilePhone ? 'yes' : 'no'}, dob ${client.dob ? 'yes' : 'null'}`
      : '';
    return `${list.length} client(s); ${sample}`;
  });
  await read('getClient', async () => {
    if (!client) return 'skipped (no clients)';
    const got = await blvd.getClient(c, client.id);
    return got ? `${got.firstName} ${got.lastName}` : 'not found';
  });
  await read('findClientsByEmails', async () => {
    if (!client?.email) return 'skipped (no email)';
    return `${(await blvd.findClientsByEmails(c, [client.email])).length} match(es)`;
  });
  await read('listServices', async () => `${(await blvd.listServices(c, 50, 1)).length} service(s)`);
  await read('listRecentAppointments', async () => {
    const appts = await blvd.listRecentAppointments(c, { locationId: location?.id, first: 40 });
    const withOrder = appts.find((a) => a.clientId);
    if (withOrder) appointment = withOrder;
    return `${appts.length} appointment(s)`;
  });
  await read('getAppointment (full node)', async () => {
    if (!appointment) return 'skipped (no appointments)';
    const full = await blvd.getAppointment(c, appointment.id);
    orderId = full?.orderId || null;
    const svc = full?.appointmentServices?.[0];
    return `${full?.state}; services ${full?.appointmentServices?.length}; staff ${svc?.staff ? 'yes' : 'null'}; client email ${full?.client?.email ? 'yes' : 'null'}`;
  });
  await read('getOrder', async () => {
    if (!orderId) {
      const appts = await blvd.listRecentAppointments(c, { locationId: location?.id, first: 40 });
      for (const a of appts) {
        const full = await blvd.getAppointment(c, a.id);
        if (full?.orderId) {
          orderId = full.orderId;
          appointment = full;
          break;
        }
      }
    }
    if (!orderId) return 'skipped (no appointment with an order)';
    const order = await blvd.getOrder(c, orderId);
    return order ? `${order.number}; total ${order.summary?.currentTotal}; lineGroups ${order.lineGroups?.length}` : 'not found';
  });
  await read('findAppointmentByOrderId', async () => {
    if (!orderId || !appointment) return 'skipped';
    const hit = await blvd.findAppointmentByOrderId(c, {
      orderId,
      clientId: appointment.clientId,
      locationId: appointment.locationId,
    });
    return hit ? 'matched' : 'no match';
  });
  await read('webhooks list', async () => {
    const res = await blvd.adminExecute(c, 'query { webhooks(first: 5) { edges { node { id url } } } }');
    if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
    return `${res.data.webhooks.edges.length} visible`;
  });

  console.log('\nAdmin API — mutations (validated, not executed)');
  await mutation('createClient', () => blvd.createClient(c, undefined));
  const webhookMutations = {
    createWebhook: 'mutation($input: CreateWebhookInput!) { createWebhook(input: $input) { webhook { id url subscriptions { id eventType enabled } } } }',
    updateWebhook: 'mutation($input: UpdateWebhookInput!) { updateWebhook(input: $input) { webhook { id url subscriptions { id eventType enabled } } } }',
    deleteWebhook: 'mutation($input: DeleteWebhookInput!) { deleteWebhook(input: $input) { webhook { id } } }',
  };
  for (const [name, doc] of Object.entries(webhookMutations)) {
    await mutation(name, () => blvd.adminExecute(c, doc, {}));
  }

  console.log('\nClient API — queries (guest cart)');
  let cart;
  let consultItem;
  await read('createCart (guest)', async () => {
    cart = await clientApi.createCart(c, { locationId: location?.id });
    const items = cart.availableCategories.flatMap((cat) => cat.availableItems);
    consultItem = items.find((i) => !i.disabled) || items[0];
    return `${cart.availableCategories.length} categories, ${items.length} items`;
  });
  await read('listAvailableBookableServices', async () => {
    if (!cart) return 'skipped';
    return `${(await clientApi.listAvailableBookableServices(c, cart.id, { first: 10 })).length} service(s)`;
  });
  await read('getAvailableItem', async () => {
    if (!cart || !consultItem) return 'skipped';
    const item = await clientApi.getAvailableItem(c, cart.id, consultItem.id);
    return `${item?.name}; staff variants ${item?.staffVariants?.length ?? 'n/a'}`;
  });
  await read('getServiceDetails', async () => {
    if (!cart || !consultItem) return 'skipped';
    const d = await clientApi.getServiceDetails(c, cart.id, [consultItem.id]);
    return `${d?.details?.length || 0} detail(s)`;
  });
  await read('cartBookableDates (empty cart)', async () => {
    if (!cart) return 'skipped';
    try {
      const dates = await clientApi.cartBookableDates(c, { cartId: cart.id, tz: location?.tz, limit: 3 });
      return `${dates.length} date(s)`;
    } catch (err) {
      if (/no.*(item|selected)|empty/i.test(err.message)) return `query valid (${err.message})`;
      throw err;
    }
  });
  await read('createCart (as existing client)', async () => {
    if (!client) return 'skipped (no clients)';
    const own = await clientApi.createCart(c, { locationId: location?.id, clientId: client.id });
    return `cart ${own.id ? 'created' : 'missing'} with client-bound token`;
  });

  console.log('\nClient API — mutations (validated, not executed)');
  await mutation('addCartSelectedBookableItem', () => clientApi.addBookableItem(c, {}));
  await mutation('reserveCartBookableItems', () => clientApi.reserveBookableTime(c, {}));
  await mutation('updateCart', () => clientApi.updateCart(c, {}));
  await mutation('checkoutCart', () => clientApi.checkoutCart(c, {}));
  await mutation('cartBookableTimes', () => clientApi.cartBookableTimes(c, {}));

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? `${failed} check(s) failed` : `All ${results.length} checks passed`}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
