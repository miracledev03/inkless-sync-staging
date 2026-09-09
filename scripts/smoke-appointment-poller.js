/**
 * Prove appointment poller syncs a new BLVD book without webhooks.
 */
const { getConfig, loadServiceMap } = require('../src/config');
const clientApi = require('../src/blvd/client-api');
const blvd = require('../src/blvd/api');
const hs = require('../src/hubspot/client');
const { createAppointmentPoller } = require('../src/pollers/appointments');

async function main() {
  const c = getConfig();
  const { map } = loadServiceMap(c);
  const locationId = (await blvd.listLocations(c))[0].id;
  const clientId = 'urn:blvd:Client:6c5449f6-94e9-42d5-9502-c0674f4bfebb';

  const cart = await clientApi.createCart(c, { locationId });
  const item = await clientApi.getAvailableItem(c, cart.id, map.in_office_consult);
  await clientApi.addBookableItem(c, {
    cartId: cart.id,
    itemId: map.in_office_consult,
    itemStaffVariantId: item.staffVariants?.[0]?.id,
  });
  const dates = await clientApi.cartBookableDates(c, {
    cartId: cart.id,
    searchRangeLower: '2026-09-11',
    searchRangeUpper: '2026-09-22',
    tz: 'America/Los_Angeles',
    limit: 5,
  });
  const searchDate = dates[0].date;
  const times = await clientApi.cartBookableTimes(c, {
    cartId: cart.id,
    searchDate,
    tz: 'America/Los_Angeles',
  });
  const slot = times[Math.min(3, times.length - 1)];
  await clientApi.reserveBookableTime(c, {
    cartId: cart.id,
    bookableTimeId: slot.id,
  });
  await clientApi.updateCart(c, {
    cartId: cart.id,
    clientInformation: {
      clientId,
      email: 'staging.inperson@example.com',
      firstName: 'STAGING-Contact-InPerson',
      lastName: 'Fixture',
      phoneNumber: '+15555550100',
    },
    clientMessage: 'poller demo proof',
  });
  const checkout = await clientApi.checkoutCart(c, { cartId: cart.id });
  const appointmentId = checkout.appointments?.[0]?.appointmentId;
  console.log('booked', appointmentId, slot.startTime);
  if (!appointmentId) process.exit(1);

  const poller = createAppointmentPoller(c, { enabled: true, intervalMs: 60000 });
  await poller.tick();

  const meta = await hs.resolveObjectTypeId(c.hubspotToken, c.appointmentObject);
  const found = await hs.searchByProperty(
    c.hubspotToken,
    meta.objectTypeId,
    c.appointmentIdProperty,
    appointmentId,
    [
      c.appointmentIdProperty,
      c.appointmentOriginProperty,
      'blvd_appointment_status',
      'consultation_type',
      'blvd_appointment_service_name',
    ]
  );
  const hit = found.results?.[0];
  if (!hit) {
    console.error('FAIL: poller did not sync appointment');
    process.exit(1);
  }
  console.log('PASS poller synced', {
    hsId: hit.id,
    source: hit.properties[c.appointmentOriginProperty],
    status: hit.properties.blvd_appointment_status,
    type: hit.properties.consultation_type,
    service: hit.properties.blvd_appointment_service_name,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
