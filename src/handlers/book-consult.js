const blvd = require('../blvd/api');
const clientApi = require('../blvd/client-api');
const hs = require('../hubspot/client');
const log = require('../logger');
const { loadServiceMap } = require('../config');
const { ORIGIN } = require('../origin');
const { processQualifyPath } = require('./clients');
const { processAppointmentWebhook } = require('./appointments');
const { resolveClinicLocationId } = require('./clinic-location');
const {
  matchBookableTime,
  toLocationLocalNaive,
  localDateFromStart,
  parseAbsoluteDate,
} = require('../time');
const { resolveStaffVariant, resolveStaffId } = require('../staff-map');

const SERVICE_KEYS = [
  'virtual_consult_en',
  'virtual_consult_es',
  'in_office_consult',
  'first_session_100',
];

function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysYmd(ymdStr, days) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  if (String(phone).startsWith('+')) return String(phone);
  return `+${digits}`;
}

function resolveServiceId(map, body) {
  if (body.serviceId) return String(body.serviceId);
  const key = body.serviceKey || body.service;
  if (key && map[key]) return map[key];
  if (key && SERVICE_KEYS.includes(key)) {
    const err = new Error(`service map missing key: ${key}`);
    err.code = 'SERVICE_MAP_MISSING';
    throw err;
  }
  const err = new Error(
    `serviceKey required (one of: ${SERVICE_KEYS.join(', ')}) or serviceId`
  );
  err.code = 'MISSING_SERVICE';
  throw err;
}

async function ensureBlvdClient(config, contactId) {
  const contact = await hs.getContact(config.hubspotToken, contactId, [
    'firstname',
    'lastname',
    'email',
    'phone',
    'mobilephone',
    config.blvdClientIdProperty,
  ]);
  let blvdClientId = contact?.properties?.[config.blvdClientIdProperty];
  if (!blvdClientId) {
    const qualify = await processQualifyPath(config, String(contactId));
    blvdClientId = qualify.blvdClientId || qualify.client?.id;
    if (!blvdClientId) {
      const err = new Error('Could not link/create Boulevard client for contact');
      err.code = 'NO_BLVD_CLIENT';
      err.qualify = qualify;
      throw err;
    }
  }
  return { contact, blvdClientId };
}

function bookingBlockedError(diagnostic) {
  const staffCount = diagnostic.availableItem?.staffVariants?.length || 0;
  const msg =
    staffCount === 0
      ? 'Consult service is visible to Client API but has no staffVariants (no staff assigned for online booking at this location). In Boulevard sandbox: assign Virtual EN/ES, In Office consult, and 100 First Session to at least one externally bookable staff member and enable Online Booking / Booking Widget for those services.'
      : 'Consult service is not selectable on the Boulevard Client API cart for this location. Enable Online Booking / Booking Widget and ensure staff can perform the service, then retry.';
  const err = new Error(msg);
  err.code = 'SERVICE_NOT_EXTERNALLY_BOOKABLE';
  err.diagnostic = diagnostic;
  return err;
}

/**
 * B10 — HubSpot → Boulevard consult book via Client API cart.
 *
 * @param {object} body
 * @param {string} body.contactId HubSpot contact id
 * @param {string} [body.serviceKey] virtual_consult_en | virtual_consult_es | in_office_consult | first_session_100
 * @param {string} [body.serviceId] Boulevard service URN
 * @param {string} [body.locationId]
 * @param {string} [body.startTime] NaiveDateTime or ISO local start
 * @param {string} [body.bookableTimeId]
 * @param {string} [body.itemStaffVariantId]
 * @param {boolean} [body.dryRun] stop after availability probe (no reserve/checkout)
 * @param {boolean} [body.availabilityOnly] same as dryRun but always returns dates/times
 */
async function bookConsult(config, body = {}) {
  const contactId = body.contactId || body.objectId || body.hs_object_id;
  if (!contactId) {
    const err = new Error('contactId required');
    err.code = 'MISSING_CONTACT';
    throw err;
  }

  const { path: mapPath, map } = loadServiceMap(config);
  if (!map) {
    const err = new Error(`service map not found at ${mapPath}`);
    err.code = 'SERVICE_MAP_MISSING';
    throw err;
  }

  const serviceId = resolveServiceId(map, body);
  const serviceKey =
    body.serviceKey ||
    SERVICE_KEYS.find((k) => map[k] === serviceId) ||
    null;

  const locations = await blvd.listLocations(config);
  const clinic = await resolveClinicLocationId(config, {
    contactId: String(contactId),
    locationId: body.locationId,
    locations,
  });
  const locationId = clinic.locationId || null;
  if (!locationId) {
    const err = new Error('No Boulevard location available');
    err.code = 'NO_LOCATION';
    throw err;
  }
  const location = locations.find((l) => l.id === locationId) || locations[0];
  const tz = location?.tz || 'America/Los_Angeles';
  const locationSource = clinic.source;

  const { contact, blvdClientId } = await ensureBlvdClient(
    config,
    String(contactId)
  );
  const clientOpts = { clientId: blvdClientId };

  const requestedStart =
    body.startTime || body.startAt || body.hs_meeting_start_time || null;
  const forceClientCart =
    body.forceClientCart === true ||
    body.bookingMode === 'client_cart' ||
    Boolean(body.bookableTimeId && !requestedStart);
  const useAdminExactTime =
    Boolean(requestedStart) &&
    !forceClientCart &&
    body.bookingMode !== 'client_cart';

  // Feature 4.2.1 / Joey UAT: HubSpot Meeting times must land on Boulevard even
  // when Precision Scheduling hides that slot from the Client API cart.
  if (useAdminExactTime) {
    return bookConsultAdminExactTime(config, {
      body,
      contactId: String(contactId),
      contact,
      blvdClientId,
      serviceId,
      serviceKey,
      locationId,
      locationSource,
      clinic,
      tz,
      location,
    });
  }

  const cart = await clientApi.createCart(config, {
    locationId,
    ...clientOpts,
  });

  const [available, details, availableItem] = await Promise.all([
    clientApi.listAvailableBookableServices(config, cart.id, {
      includeNonExternallyBookable: true,
      first: 50,
      ...clientOpts,
    }),
    clientApi.getServiceDetails(config, cart.id, [serviceId], {
      includeNonExternallyBookable: true,
      ...clientOpts,
    }),
    clientApi.getAvailableItem(config, cart.id, serviceId, clientOpts),
  ]);

  const diagnostic = {
    cartId: cart.id,
    locationId,
    serviceId,
    serviceKey,
    paymentInfoRequired: cart.features?.paymentInfoRequired ?? null,
    availableBookableCount: available.length,
    availableSample: available.slice(0, 8).map((s) => ({
      id: s.id,
      name: s.name,
      bookable: s.bookable,
      catalogItemId: s.catalogItemId,
    })),
    serviceDetails: details,
    availableItem: availableItem
      ? {
          id: availableItem.id,
          name: availableItem.name,
          disabled: availableItem.disabled,
          disabledDescription: availableItem.disabledDescription,
          staffVariants: (availableItem.staffVariants || []).map((v) => ({
            id: v.id,
            staff: v.staff?.displayName,
            staffId: v.staff?.id,
          })),
        }
      : null,
    menuCategories: (cart.availableCategories || []).map((c) => ({
      name: c.name,
      categoryType: c.categoryType,
      itemCount: (c.availableItems || []).length,
    })),
  };

  const detailsOk =
    details?.details?.length &&
    !details?.notFoundIds?.includes(serviceId) &&
    !details?.omittedIds?.includes(serviceId);

  if (!availableItem && !detailsOk) {
    throw bookingBlockedError(diagnostic);
  }

  if (
    availableItem &&
    (!availableItem.staffVariants || availableItem.staffVariants.length === 0)
  ) {
    throw bookingBlockedError(diagnostic);
  }

  // Prefer full Service URN — catalogItemId is often a bare UUID and can 404 add.
  const itemId =
    availableItem?.id ||
    details?.details?.[0]?.id ||
    serviceId;

  const variants = availableItem?.staffVariants || [];
  const staffPick = resolveStaffVariant(variants, {
    itemStaffVariantId: body.itemStaffVariantId,
    staffId: body.staffId || body.blvdStaffId,
    ownerEmail: body.ownerEmail || body.hsOwnerEmail,
    ownerId: body.ownerId || body.hsOwnerId,
    ownerName: body.ownerName || body.hsOwnerName || body.staffName,
    staffMap: body.staffMap || [],
  });
  const itemStaffVariantId = staffPick.variant?.id || undefined;
  const staffSource = staffPick.source;

  let cartAfterAdd;
  try {
    cartAfterAdd = await clientApi.addBookableItem(config, {
      cartId: cart.id,
      itemId,
      itemStaffVariantId,
      ...clientOpts,
    });
  } catch (e) {
    if (
      e.code === 'CART_SERVICE_UNAVAILABLE' ||
      /not available|CART_SERVICE/i.test(e.message || '')
    ) {
      throw bookingBlockedError({ ...diagnostic, addError: e.message });
    }
    e.diagnostic = diagnostic;
    throw e;
  }

  const today = ymd(new Date());
  const dates = await clientApi.cartBookableDates(config, {
    cartId: cart.id,
    searchRangeLower: today,
    searchRangeUpper: addDaysYmd(today, 21),
    tz,
    limit: 21,
    ...clientOpts,
  });

  const availabilityOnly = body.availabilityOnly === true;
  const dryRun = body.dryRun === true;
  const requestedTime = body.bookableTimeId || body.startTime || body.startAt;

  // Availability catalogue probe (no specific start requested).
  if ((availabilityOnly || dryRun) && !requestedTime) {
    const firstDate = dates[0]?.date;
    const times = firstDate
      ? await clientApi.cartBookableTimes(config, {
          cartId: cart.id,
          searchDate: firstDate,
          tz,
          ...clientOpts,
        })
      : [];
    return {
      action: 'availability',
      origin: ORIGIN.HUBSPOT,
      contactId: String(contactId),
      blvdClientId,
      cartId: cart.id,
      serviceId,
      serviceKey,
      itemId,
      itemStaffVariantId: itemStaffVariantId || null,
      staffSource,
      locationId,
      locationSource,
      clinicLocationRaw: clinic.raw,
      tz,
      dates: dates.map((d) => d.date),
      sampleTimes: times,
      selectedItems: cartAfterAdd?.selectedItems || [],
      diagnostic,
      hint: 'POST again with startTime (location local NaiveDateTime or UTC ISO) or bookableTimeId',
    };
  }

  if (!requestedTime) {
    return {
      action: 'needs_start_time',
      origin: ORIGIN.HUBSPOT,
      contactId: String(contactId),
      blvdClientId,
      cartId: cart.id,
      serviceId,
      serviceKey,
      itemId,
      itemStaffVariantId: itemStaffVariantId || null,
      staffSource,
      locationId,
      locationSource,
      clinicLocationRaw: clinic.raw,
      tz,
      dates: dates.map((d) => d.date),
      selectedItems: cartAfterAdd?.selectedItems || [],
      diagnostic,
      hint: 'POST again with startTime (location local NaiveDateTime or UTC ISO) or bookableTimeId',
    };
  }

  const startRaw = String(body.startTime || body.startAt || '');
  const localStart = toLocationLocalNaive(startRaw || requestedTime, tz);
  let searchDate =
    localDateFromStart(startRaw || requestedTime, tz) ||
    localStart.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(searchDate)) {
    searchDate = dates[0]?.date;
  }
  if (!searchDate) {
    const err = new Error('No bookable dates returned for this service/location');
    err.code = 'NO_BOOKABLE_DATES';
    err.diagnostic = diagnostic;
    throw err;
  }

  const times = await clientApi.cartBookableTimes(config, {
    cartId: cart.id,
    searchDate,
    tz,
    ...clientOpts,
  });
  const matched = matchBookableTime(times, requestedTime, tz);
  if (!matched?.id) {
    const err = new Error(
      `No matching bookable time for ${requestedTime} (local ${localStart || 'n/a'}) on ${searchDate}`
    );
    err.code = 'NO_MATCHING_TIME';
    err.times = times;
    err.dates = dates.map((d) => d.date);
    err.localStart = localStart || null;
    err.diagnostic = diagnostic;
    throw err;
  }

  // Dry-run with a start: prove same-slot match + staff/location without checkout.
  if (dryRun || availabilityOnly) {
    return {
      action: 'would_book',
      origin: ORIGIN.HUBSPOT,
      contactId: String(contactId),
      blvdClientId,
      cartId: cart.id,
      serviceId,
      serviceKey,
      itemId,
      itemStaffVariantId: itemStaffVariantId || null,
      staffSource,
      locationId,
      locationSource,
      clinicLocationRaw: clinic.raw,
      tz,
      bookableTimeId: matched.id,
      startTime: matched.startTime,
      localStart: localStart || null,
      dates: dates.map((d) => d.date),
      diagnostic,
      hint: 'Pass dryRun=false to reserve + checkout this slot',
    };
  }

  await clientApi.reserveBookableTime(config, {
    cartId: cart.id,
    bookableTimeId: matched.id,
    ...clientOpts,
  });

  const phone =
    normalizePhone(contact.properties?.mobilephone) ||
    normalizePhone(contact.properties?.phone);

  await clientApi.updateCart(config, {
    cartId: cart.id,
    clientInformation: {
      clientId: blvdClientId,
      email: contact.properties?.email || undefined,
      firstName: contact.properties?.firstname || undefined,
      lastName: contact.properties?.lastname || undefined,
      phoneNumber: phone,
    },
    clientMessage:
      body.clientMessage || 'Booked via HubSpot Meeting (Inkless 4.2.1)',
    ...clientOpts,
  });

  const checkoutResult = await clientApi.checkoutCart(config, {
    cartId: cart.id,
    ...clientOpts,
  });
  const checkedOut = checkoutResult.cart || checkoutResult;
  if (checkedOut.errors?.length) {
    const err = new Error(
      checkedOut.errors.map((e) => e.message || e.code).join('; ')
    );
    err.code = 'CHECKOUT_ERRORS';
    err.cart = checkedOut;
    throw err;
  }

  let appointmentId =
    checkoutResult.appointments?.[0]?.appointmentId || null;
  let hsUpsert = null;
  try {
    if (!appointmentId) {
      appointmentId = await findRecentAppointment(config, {
        clientId: blvdClientId,
        locationId,
        startHint: checkedOut.startTime || matched.startTime,
      });
    }
    if (appointmentId) {
      hsUpsert = await processAppointmentWebhook(config, {
        eventType: 'APPOINTMENT_CREATED',
        payload: { resourceId: appointmentId },
        forceOrigin: ORIGIN.HUBSPOT,
      });
    }
  } catch (err) {
    log.warn('B10 post-checkout HS upsert deferred to webhook', {
      error: err.message,
      cartId: cart.id,
    });
  }

  log.info('B10 book-consult checkout complete', {
    contactId: String(contactId),
    blvdClientId,
    cartId: cart.id,
    serviceId,
    appointmentId,
    completedAt: checkedOut.completedAt,
  });

  return {
    action: 'booked',
    origin: ORIGIN.HUBSPOT,
    contactId: String(contactId),
    blvdClientId,
    cartId: cart.id,
    serviceId,
    serviceKey,
    itemId,
    itemStaffVariantId: itemStaffVariantId || null,
    staffSource,
    locationId,
    locationSource,
    clinicLocationRaw: clinic.raw,
    tz,
    bookableTimeId: matched.id,
    startTime: checkedOut.startTime || matched.startTime,
    localStart: localStart || null,
    completedAt: checkedOut.completedAt,
    appointmentId,
    hubspot: hsUpsert,
    cart: {
      id: checkedOut.id,
      selectedItems: checkedOut.selectedItems,
    },
  };
}

function deliveryMethodForService(serviceKey) {
  if (serviceKey === 'in_office_consult') return 'IN_PERSON';
  if (serviceKey === 'first_session_100') return 'IN_PERSON';
  return 'VIDEO';
}

async function bookConsultAdminExactTime(
  config,
  {
    body,
    contactId,
    contact,
    blvdClientId,
    serviceId,
    serviceKey,
    locationId,
    locationSource,
    clinic,
    tz,
    location,
  }
) {
  const staffPick = resolveStaffId({
    staffId: body.staffId || body.blvdStaffId,
    ownerEmail: body.ownerEmail || body.hsOwnerEmail,
    ownerId: body.ownerId || body.hsOwnerId,
    ownerName: body.ownerName || body.hsOwnerName || body.staffName,
    staffMap: body.staffMap || [],
  });
  if (!staffPick.staffId) {
    const err = new Error(
      'No Boulevard staffId for Admin exact-time book (set staffMap / staffId)'
    );
    err.code = 'MISSING_STAFF';
    throw err;
  }

  const startRaw =
    body.startTime || body.startAt || body.hs_meeting_start_time || '';
  const localStart = toLocationLocalNaive(startRaw, tz);
  if (!localStart || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(localStart)) {
    const err = new Error(
      `Could not parse startTime for Admin book: ${startRaw}`
    );
    err.code = 'MISSING_START';
    throw err;
  }

  const dryRun = body.dryRun === true || body.availabilityOnly === true;
  const deliveryMethod =
    body.deliveryMethod || deliveryMethodForService(serviceKey);

  if (dryRun) {
    return {
      action: 'would_book',
      bookingMode: 'admin_exact_time',
      origin: ORIGIN.HUBSPOT,
      contactId,
      blvdClientId,
      serviceId,
      serviceKey,
      staffId: staffPick.staffId,
      staffSource: staffPick.source,
      locationId,
      locationSource,
      clinicLocationRaw: clinic.raw,
      tz,
      startTime: localStart,
      localStart,
      deliveryMethod,
      hint: 'Pass dryRun=false to Admin-book this exact HubSpot time',
    };
  }

  let adminBook;
  try {
    adminBook = await blvd.createAdminBooking(config, {
      locationId,
      clientId: blvdClientId,
      serviceId,
      staffId: staffPick.staffId,
      startTime: localStart,
      deliveryMethod,
      bookWithStaffId: staffPick.staffId,
      notes:
        body.clientMessage ||
        'Booked via HubSpot Meeting — Admin exact time (Inkless 4.2.1)',
      notifyClient: body.notifyClient === true,
      virtualMeetingUrlOverride: body.virtualMeetingUrlOverride,
      virtualJoiningInstructionsOverride:
        body.virtualJoiningInstructionsOverride,
    });
  } catch (err) {
    err.bookingMode = 'admin_exact_time';
    err.staffId = staffPick.staffId;
    err.localStart = localStart;
    err.locationId = locationId;
    throw err;
  }

  let hsUpsert = null;
  const appointmentId = adminBook.appointmentId || null;
  try {
    if (appointmentId) {
      hsUpsert = await processAppointmentWebhook(config, {
        eventType: 'APPOINTMENT_CREATED',
        payload: { resourceId: appointmentId },
        forceOrigin: ORIGIN.HUBSPOT,
      });
    }
  } catch (err) {
    log.warn('Admin exact-time HS upsert deferred to webhook', {
      error: err.message,
      appointmentId,
    });
  }

  log.info('B10 admin exact-time book complete', {
    contactId,
    blvdClientId,
    serviceId,
    appointmentId,
    startTime: localStart,
    staffId: staffPick.staffId,
    warnings: adminBook.warnings || [],
  });

  return {
    action: 'booked',
    bookingMode: 'admin_exact_time',
    origin: ORIGIN.HUBSPOT,
    contactId,
    blvdClientId,
    serviceId,
    serviceKey,
    staffId: staffPick.staffId,
    staffSource: staffPick.source,
    locationId,
    locationSource,
    clinicLocationRaw: clinic.raw,
    tz,
    startTime: adminBook.appointment?.startAt || localStart,
    localStart,
    deliveryMethod,
    appointmentId,
    bookingId: adminBook.bookingId,
    warnings: adminBook.warnings || [],
    hubspot: hsUpsert,
    locationName: location?.name || null,
    absoluteStart: parseAbsoluteDate(startRaw)?.toISOString?.() || null,
  };
}

async function findRecentAppointment(config, { clientId, locationId, startHint }) {
  if (!clientId || !locationId) return null;
  const { formatErrors } = require('../blvd/client');
  const response = await blvd.adminExecute(
    config,
    `query($locationId: ID!, $clientId: ID!, $first: Int!) {
      appointments(locationId: $locationId, clientId: $clientId, first: $first) {
        edges {
          node { id startAt state cancelled }
        }
      }
    }`,
    { locationId, clientId, first: 20 }
  );
  if (response.errors?.length) {
    throw new Error(formatErrors(response.errors));
  }
  const nodes = (response.data?.appointments?.edges || [])
    .map((e) => e.node)
    .filter((n) => n && !n.cancelled);
  if (!nodes.length) return null;
  if (!startHint) return nodes[0].id;
  const hint = String(startHint).slice(0, 16);
  const hit = nodes.find((n) =>
    String(n.startAt || '').includes(hint.slice(0, 13))
  );
  return (hit || nodes[0]).id;
}

module.exports = {
  SERVICE_KEYS,
  bookConsult,
  matchBookableTime,
};
