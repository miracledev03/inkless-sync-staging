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

async function gql(config, query, variables) {
  const response = await adminExecute(config, query, variables);
  if (response.errors?.length) {
    throw new Error(formatErrors(response.errors));
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
  listRecentAppointments,
  getOrder,
  findAppointmentByOrderId,
  listServices,
};
