const { generateAdminToken } = require('./auth');
const { executeGraphQL, formatErrors } = require('./client');
const oauth = require('./oauth');

async function adminAuthorization(config) {
  if (config.blvdAuthMode === 'oauth') {
    return `Bearer ${await oauth.getAdminToken(config)}`;
  }
  return generateAdminToken(
    config.blvdBusinessId,
    config.blvdApiKey,
    config.blvdSecretKey
  );
}

/** Raw Admin API call (returns `{ data, errors }`); renews the OAuth token once on 401. */
async function adminExecute(config, query, variables) {
  try {
    return await executeGraphQL(
      config.blvdAdminUrl,
      await adminAuthorization(config),
      query,
      variables
    );
  } catch (err) {
    if (err.status !== 401 || config.blvdAuthMode !== 'oauth') throw err;
    oauth.invalidate(config.blvdAdminUrl);
    return executeGraphQL(
      config.blvdAdminUrl,
      await adminAuthorization(config),
      query,
      variables
    );
  }
}

function throwBlvdGraphqlError(errors) {
  const msg = formatErrors(errors);
  const err = new Error(msg);
  err.blvdErrors = errors;
  if (/missing required scope/i.test(msg)) {
    err.code = 'BLVD_SCOPE_MISSING';
  }
  throw err;
}

async function gql(config, query, variables) {
  const response = await adminExecute(config, query, variables);
  if (response.errors?.length) {
    throwBlvdGraphqlError(response.errors);
  }
  return response.data;
}

async function getBusiness(config) {
  const data = await gql(
    config,
    `query { business { id name } }`
  );
  return data.business;
}

async function listLocations(config, first = 50) {
  const data = await gql(
    config,
    `query($first: Int!) {
      locations(first: $first) {
        edges {
          node {
            id
            name
            businessName
            contactEmail
            phone
            tz
            externalId
            address {
              line1
              line2
              city
              state
              zip
              country
            }
          }
        }
      }
    }`,
    { first }
  );
  return (data.locations?.edges || []).map((e) => e.node);
}

const CLIENT_NODE = `
  id
  email
  firstName
  lastName
  mobilePhone
  externalId
  dob
  active
  primaryLocation { id name }
`;

async function findClientsByEmails(config, emails) {
  const cleaned = (emails || []).filter(Boolean);
  if (!cleaned.length) return [];
  const data = await gql(
    config,
    `query($emails: [String!]!) {
      clients(first: 10, emails: $emails) {
        edges {
          node { ${CLIENT_NODE} }
        }
      }
    }`,
    { emails: cleaned }
  );
  return (data.clients?.edges || []).map((e) => e.node);
}

/**
 * Paginate all BLVD clients (A5/A6).
 * @param {{ first?: number, maxPages?: number }} [opts]
 */
async function listClients(config, opts = {}) {
  const first = opts.first || 50;
  const maxPages = opts.maxPages || config.blvdListClientsMaxPages || 2000;
  const max =
    opts.max != null && Number(opts.max) > 0 ? Number(opts.max) : null;
  const all = [];
  let after = null;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await gql(
      config,
      `query($first: Int!, $after: String) {
        clients(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { ${CLIENT_NODE} } }
        }
      }`,
      { first, after }
    );
    const conn = data.clients;
    for (const edge of conn?.edges || []) {
      if (edge?.node) all.push(edge.node);
      if (max && all.length >= max) return all.slice(0, max);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (page === maxPages - 1) truncated = true;
  }
  if (truncated && !opts.maxPages) {
    require('../logger').warn('BLVD listClients hit page cap; results truncated', {
      maxPages,
      pageSize: first,
      returned: all.length,
      hint: 'Raise BLVD_LIST_CLIENTS_MAX_PAGES',
    });
  }
  return all;
}

async function getClient(config, id) {
  if (!id) return null;
  const data = await gql(
    config,
    `query($id: ID!) {
      client(id: $id) { ${CLIENT_NODE} }
    }`,
    { id }
  );
  return data.client || null;
}

async function createClient(config, input) {
  const data = await gql(
    config,
    `mutation($input: CreateClientInput!) {
      createClient(input: $input) {
        client {
          id
          email
          firstName
          lastName
          mobilePhone
        }
      }
    }`,
    { input }
  );
  return data.createClient.client;
}

const APPOINTMENT_NODE = `
  id
  startAt
  endAt
  state
  cancelled
  duration
  orderId
  clientId
  locationId
  notes
  cancellation { reason notes }
  client { id email firstName lastName }
  location { id name }
  appointmentServices {
    id
    duration
    price
    serviceId
    service { id name }
    staff { id firstName lastName }
  }
`;

async function listRecentAppointments(config, { locationId, first = 40 } = {}) {
  if (!locationId) {
    const locs = await listLocations(config, 1);
    locationId = locs[0]?.id;
  }
  if (!locationId) return [];
  const data = await gql(
    config,
    `query($locationId: ID!, $first: Int!) {
      appointments(locationId: $locationId, first: $first) {
        edges {
          node {
            id
            startAt
            endAt
            state
            cancelled
            clientId
            locationId
          }
        }
      }
    }`,
    { locationId, first }
  );
  return (data.appointments?.edges || []).map((e) => e.node).filter(Boolean);
}

async function getAppointment(config, id) {
  if (!id) return null;
  const data = await gql(
    config,
    `query($id: ID!) {
      appointment(id: $id) { ${APPOINTMENT_NODE} }
    }`,
    { id }
  );
  return data.appointment;
}

/**
 * Cancel a Boulevard appointment (Admin API).
 * @param {object} opts
 * @param {string} opts.id appointment id
 * @param {string} [opts.reason] AppointmentCancellationReason (default CLIENT_CANCEL)
 * @param {string} [opts.notes]
 * @param {boolean} [opts.notifyClient]
 */
async function cancelAppointment(config, opts = {}) {
  const id = opts.id || opts.appointmentId;
  if (!id) throw new Error('appointment id required');
  const input = {
    id,
    reason: opts.reason || 'CLIENT_CANCEL',
  };
  if (opts.notes != null) input.notes = String(opts.notes);
  if (opts.notifyClient != null) input.notifyClient = Boolean(opts.notifyClient);

  const data = await gql(
    config,
    `mutation($input: CancelAppointmentInput!) {
      cancelAppointment(input: $input) {
        appointment { ${APPOINTMENT_NODE} }
      }
    }`,
    { input }
  );
  return data.cancelAppointment.appointment;
}

async function appointmentRescheduleAvailableDates(
  config,
  { appointmentId, searchRangeLower, searchRangeUpper, tz }
) {
  const input = {
    appointmentId,
    searchRangeLower,
    searchRangeUpper,
  };
  if (tz) input.tz = tz;
  const data = await gql(
    config,
    `mutation($input: AppointmentRescheduleAvailableDatesInput!) {
      appointmentRescheduleAvailableDates(input: $input) {
        availableDates { date }
      }
    }`,
    { input }
  );
  return (
    data.appointmentRescheduleAvailableDates?.availableDates || []
  ).map((d) => d.date || d);
}

async function appointmentRescheduleAvailableTimes(
  config,
  { appointmentId, date, tz }
) {
  const input = { appointmentId, date };
  if (tz) input.tz = tz;
  const data = await gql(
    config,
    `mutation($input: AppointmentRescheduleAvailableTimesInput!) {
      appointmentRescheduleAvailableTimes(input: $input) {
        availableTimes { bookableTimeId startTime }
      }
    }`,
    { input }
  );
  return data.appointmentRescheduleAvailableTimes?.availableTimes || [];
}

/**
 * Reschedule an appointment to a new bookable slot (Admin API).
 */
async function appointmentReschedule(
  config,
  { appointmentId, bookableTimeId, sendNotification = false }
) {
  const data = await gql(
    config,
    `mutation($input: AppointmentRescheduleInput!) {
      appointmentReschedule(input: $input) {
        appointment { ${APPOINTMENT_NODE} }
      }
    }`,
    {
      input: {
        appointmentId,
        bookableTimeId,
        sendNotification: Boolean(sendNotification),
      },
    }
  );
  return data.appointmentReschedule.appointment;
}

/**
 * Update appointment notes / open states (BOOKED|CONFIRMED|ACTIVE|ARRIVED).
 * Note: FINAL is not a valid AppointmentStateInput — use finalizeAppointment.
 */
async function updateAppointment(config, { id, state, notes }) {
  const input = { id };
  if (state) input.state = state;
  if (notes != null) input.notes = String(notes);
  const data = await gql(
    config,
    `mutation($input: UpdateAppointmentInput!) {
      updateAppointment(input: $input) {
        appointment { ${APPOINTMENT_NODE} }
      }
    }`,
    { input }
  );
  return data.updateAppointment.appointment;
}

/**
 * Move an existing appointment to Final via Admin booking workflow:
 * bookingCreateFromAppointment → bookingComplete.
 * Requires appointment:write.
 */
async function finalizeAppointment(config, appointmentId, opts = {}) {
  if (!appointmentId) throw new Error('appointmentId required');
  const existing = opts.appointment || (await getAppointment(config, appointmentId));
  if (!existing) {
    const err = new Error(`Boulevard appointment not found: ${appointmentId}`);
    err.code = 'APPOINTMENT_NOT_FOUND';
    throw err;
  }
  if (String(existing.state || '').toUpperCase() === 'FINAL') {
    return { appointment: existing, action: 'already_final', bookingId: null };
  }
  if (existing.cancelled) {
    const err = new Error('Cannot finalize a cancelled appointment');
    err.code = 'APPOINTMENT_CANCELLED';
    throw err;
  }

  const staffId =
    opts.staffId ||
    existing.appointmentServices?.find((s) => s.staff?.id)?.staff?.id ||
    null;
  if (!staffId) {
    const err = new Error(
      'Cannot finalize: appointment has no staff (bookWithStaffId required)'
    );
    err.code = 'MISSING_STAFF';
    throw err;
  }

  const created = await gql(
    config,
    `mutation($input: BookingCreateFromAppointmentInput!) {
      bookingCreateFromAppointment(input: $input) {
        booking { id }
        bookingWarnings { code message }
      }
    }`,
    { input: { appointmentId } }
  );
  const bookingId = created.bookingCreateFromAppointment?.booking?.id;
  if (!bookingId) {
    const err = new Error('bookingCreateFromAppointment returned no booking id');
    err.code = 'BOOKING_CREATE_FAILED';
    err.warnings = created.bookingCreateFromAppointment?.bookingWarnings || [];
    throw err;
  }

  await gql(
    config,
    `mutation($input: BookingCompleteInput!) {
      bookingComplete(input: $input) {
        booking { id }
        bookingWarnings { code message }
      }
    }`,
    {
      input: {
        bookingId,
        bookWithStaffId: staffId,
        notifyClient: opts.notifyClient === true,
      },
    }
  );

  const appointment = await getAppointment(config, appointmentId);
  return {
    appointment,
    action: 'finalized',
    bookingId,
    staffId,
  };
}

async function listServices(config, first = 50, maxPages = 40) {
  const all = [];
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await gql(
      config,
      `query($first: Int!, $after: String) {
        services(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              active
            }
          }
        }
      }`,
      { first, after }
    );
    const conn = data.services;
    for (const edge of conn?.edges || []) {
      if (edge?.node) all.push(edge.node);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return all;
}

const ORDER_NODE = `
  id
  number
  clientId
  locationId
  closedAt
  createdAt
  note
  summary {
    currentTotal
    currentSubtotal
    refundAmount
  }
  paymentGroups {
    payments { paidAmount }
  }
  lineGroups {
    __typename
    ... on OrderAppointmentLineGroup {
      lines {
        __typename
        ... on OrderServiceLine { name serviceId currentPrice }
      }
    }
    ... on OrderRetailLineGroup {
      lines {
        __typename
        ... on OrderProductLine { name currentPrice }
      }
    }
  }
`;

async function getOrder(config, id) {
  if (!id) return null;
  try {
    const data = await gql(
      config,
      `query($id: ID!) {
        order(id: $id) { ${ORDER_NODE} }
      }`,
      { id }
    );
    return data.order;
  } catch (err) {
    if (/not found|does not exist|need access/i.test(String(err.message))) {
      return null;
    }
    throw err;
  }
}

/**
 * Find BLVD appointment linked to an order (appointment.orderId match).
 */
async function findAppointmentByOrderId(config, { orderId, clientId, locationId }) {
  if (!orderId || !clientId || !locationId) return null;
  const data = await gql(
    config,
    `query($locationId: ID!, $clientId: ID!, $first: Int!) {
      appointments(locationId: $locationId, clientId: $clientId, first: $first) {
        edges {
          node { id orderId }
        }
      }
    }`,
    { locationId, clientId, first: 50 }
  );
  for (const edge of data.appointments?.edges || []) {
    if (edge?.node?.orderId === orderId) return edge.node;
  }
  return null;
}

module.exports = {
  adminExecute,
  adminAuthorization,
  getBusiness,
  listLocations,
  findClientsByEmails,
  listClients,
  getClient,
  createClient,
  getAppointment,
  cancelAppointment,
  appointmentRescheduleAvailableDates,
  appointmentRescheduleAvailableTimes,
  appointmentReschedule,
  updateAppointment,
  finalizeAppointment,
  listRecentAppointments,
  getOrder,
  findAppointmentByOrderId,
  listServices,
};
