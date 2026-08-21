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

async function findClientsByEmails(config, emails) {
  const cleaned = (emails || []).filter(Boolean);
  if (!cleaned.length) return [];
  const data = await gql(
    config,
    `query($emails: [String!]!) {
      clients(first: 10, emails: $emails) {
        edges {
          node {
            id
            email
            firstName
            lastName
            mobilePhone
          }
        }
      }
    }`,
    { emails: cleaned }
  );
  return (data.clients?.edges || []).map((e) => e.node);
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

module.exports = {
  getBusiness,
  listLocations,
  findClientsByEmails,
  createClient,
  listServices,
};
