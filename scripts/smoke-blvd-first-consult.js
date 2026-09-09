/**
 * End-to-end C2 smoke: book Virtual EN via Client API for a NEW email
 * (no prior HS contact), then run appointment webhook processor and
 * verify Contact + Deal + Meeting Type signal.
 *
 * Usage: node scripts/smoke-blvd-first-consult.js
 */
const { getConfig, loadServiceMap } = require('../src/config');
const blvd = require('../src/blvd/api');
const clientApi = require('../src/blvd/client-api');
const hs = require('../src/hubspot/client');
const { processAppointmentWebhook } = require('../src/handlers/appointments');
const { STAGE, LIFECYCLE } = require('../src/acquisition-stages');

async function main() {
  const config = getConfig();
  const { map } = loadServiceMap(config);
  const locs = await blvd.listLocations(config);
  const locationId = locs[0].id;
  const stamp = Date.now();
  const email = `c2.smoke.${stamp}@example.com`;
  const firstName = 'C2Smoke';
  const lastName = `T${stamp.toString().slice(-6)}`;

  console.log('Booking new BLVD client', { email, locationId });

  const cart = await clientApi.createCart(config, { locationId });
  const item = await clientApi.getAvailableItem(
    config,
    cart.id,
    map.virtual_consult_en
  );
  const larryVariant = (item?.staffVariants || []).find((v) =>
    /Larry|6d53de6d/i.test(`${v.staff?.displayName} ${v.id}`)
  );
  await clientApi.addBookableItem(config, {
    cartId: cart.id,
    itemId: map.virtual_consult_en,
    itemStaffVariantId: larryVariant?.id,
  });

  const dates = await clientApi.cartBookableDates(config, {
    cartId: cart.id,
    searchRangeLower: new Date().toISOString().slice(0, 10),
    searchRangeUpper: '2026-09-30',
    tz: 'America/Los_Angeles',
    limit: 14,
  });
  if (!dates.length) throw new Error('No bookable dates — run blvd:seed-shifts');
  const searchDate = dates[0].date;
  const times = await clientApi.cartBookableTimes(config, {
    cartId: cart.id,
    searchDate,
    tz: 'America/Los_Angeles',
  });
  if (!times.length) throw new Error('No bookable times');
  // Prefer afternoon slot to avoid colliding with prior smoke
  const slot = times[Math.min(2, times.length - 1)];

  await clientApi.reserveBookableTime(config, {
    cartId: cart.id,
    bookableTimeId: slot.id,
  });
  await clientApi.updateCart(config, {
    cartId: cart.id,
    clientInformation: {
      email,
      firstName,
      lastName,
      phoneNumber: '+15555550199',
    },
    clientMessage: 'C2 smoke BLVD-first',
  });
  const checkout = await clientApi.checkoutCart(config, { cartId: cart.id });
  const appointmentId = checkout.appointments?.[0]?.appointmentId;
  if (!appointmentId) throw new Error('checkout returned no appointmentId');
  console.log('Booked', { appointmentId, start: slot.startTime });

  // Confirm no HS contact yet by email
  const before = await hs.searchContacts(
    config.hubspotToken,
    [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    ['email', config.blvdClientIdProperty, 'lifecyclestage'],
    5
  );
  console.log('HS contacts before C2', before.results?.length || 0);

  const result = await processAppointmentWebhook(config, {
    eventType: 'APPOINTMENT_CREATED',
    payload: { resourceId: appointmentId },
    dryRun: false,
  });

  const c2 = result.blvdFirstConsult || {};
  const contactId = c2.contactId;
  if (!contactId) {
    console.error('FAIL: no contactId from C2', JSON.stringify(c2, null, 2));
    process.exit(1);
  }
  if (c2.contact?.action !== 'create' && (before.results?.length || 0) === 0) {
    // Accept update if email somehow matched; prefer create for true first
    console.warn('expected create for new email; got', c2.contact?.action);
  }

  const contact = await hs.getContact(config.hubspotToken, contactId, [
    'email',
    'firstname',
    'lastname',
    'lifecyclestage',
    config.blvdClientIdProperty,
  ]);
  const lifecycle = contact.properties?.lifecyclestage;
  const dealOk =
    c2.deal?.action === 'created' ||
    c2.deal?.action === 'existing' ||
    c2.deal?.stageUpdate?.to === STAGE.consultationBooked;

  const summary = {
    ok:
      Boolean(contactId) &&
      Boolean(c2.meetingTypeSignal?.meetingType) &&
      lifecycle === LIFECYCLE.consultationBooked &&
      dealOk,
    appointmentId,
    contactId,
    email: contact.properties?.email,
    blvdClientId: contact.properties?.[config.blvdClientIdProperty],
    lifecycle,
    contactAction: c2.contact?.action,
    deal: {
      action: c2.deal?.action,
      dealId: c2.deal?.dealId,
      stageUpdate: c2.deal?.stageUpdate || null,
    },
    meetingTypeSignal: c2.meetingTypeSignal,
    hsAppointmentId: result.hubspot?.appointment?.hsId || null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
  console.log('\nC2 smoke PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
