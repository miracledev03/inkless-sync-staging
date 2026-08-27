const { generateAdminToken } = require('./auth');
const { executeGraphQL, formatErrors } = require('./client');

function tokenFor(config) {
  return generateAdminToken(
    config.blvdBusinessId,
    config.blvdApiKey,
    config.blvdSecretKey
  );
}

async function gql(config, query, variables) {
  const response = await executeGraphQL(
    config.blvdAdminUrl,
    tokenFor(config),
    query,
    variables
  );
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
  const maxPages = opts.maxPages || 100;
  const all = [];
  let after = null;
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
  }
  return all;
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

async function listServices(config, first = 50) {
  const data = await gql(
    config,
    `query($first: Int!) {
      services(first: $first) {
        edges {
          node {
            id
            name
            active
          }
        }
      }
    }`,
    { first }
  );
  return (data.services?.edges || []).map((e) => e.node);
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
  getBusiness,
  listLocations,
  findClientsByEmails,
  listClients,
  createClient,
  getAppointment,
  getOrder,
  findAppointmentByOrderId,
  listServices,
};
