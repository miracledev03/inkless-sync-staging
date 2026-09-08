/**
 * Boulevard Client API helpers (cart booking).
 * Auth:
 * - Public: Basic API_KEY: (guest cart)
 * - Authenticated: blvd-client-v1 HMAC scoped to a client UUID (preferred for HS→BLVD)
 */
const crypto = require('crypto');
const { executeGraphQL, formatErrors } = require('./client');

function clientApiUrl(businessId, env) {
  const host =
    env === 'prod' || env === 'live' || env === 'production'
      ? 'https://dashboard.boulevard.io'
      : 'https://sandbox.joinblvd.com';
  return `${host}/api/2020-01/${businessId}/client`;
}

function clientUuidFromId(clientId) {
  if (!clientId) return null;
  const s = String(clientId);
  if (s.startsWith('urn:blvd:Client:')) {
    return s.slice('urn:blvd:Client:'.length);
  }
  return s;
}

function generateClientToken(businessId, clientUuid, apiKey, apiSecret) {
  const prefix = 'blvd-client-v1';
  const timestamp = Math.floor((Date.now() - 1000) / 1000);
  const payload = `${prefix}${businessId}${clientUuid}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, 'base64');
  const signature = crypto
    .createHmac('sha256', rawKey)
    .update(payload, 'utf8')
    .digest('base64');
  const token = `${signature}${payload}`;
  return Buffer.from(`${apiKey}:${token}`, 'utf8').toString('base64');
}

function clientBasicToken(apiKey) {
  return Buffer.from(`${String(apiKey)}:`, 'utf8').toString('base64');
}

function tokenFor(config, { clientId } = {}) {
  const uuid = clientUuidFromId(clientId);
  if (uuid && config.blvdSecretKey) {
    return generateClientToken(
      config.blvdBusinessId,
      uuid,
      config.blvdApiKey,
      config.blvdSecretKey
    );
  }
  return clientBasicToken(config.blvdApiKey);
}

async function clientGql(config, query, variables = {}, { clientId } = {}) {
  const url = clientApiUrl(config.blvdBusinessId, config.blvdEnv);
  const token = tokenFor(config, { clientId });
  const response = await executeGraphQL(url, token, query, variables);
  if (response.errors?.length) {
    const err = new Error(formatErrors(response.errors));
    err.code = response.errors[0]?.code || 'BLVD_CLIENT_API';
    err.errors = response.errors;
    throw err;
  }
  return response.data;
}

async function createCart(
  config,
  { locationId, clientInformation, clientId } = {}
) {
  const input = { locationId };
  if (clientInformation) input.clientInformation = clientInformation;
  const data = await clientGql(
    config,
    `mutation($input: CreateCartInput!) {
      createCart(input: $input) {
        cart {
          id
          location { id name tz }
          features { paymentInfoRequired }
          availableCategories {
            name
            categoryType
            availableItems { __typename id name disabled }
          }
        }
      }
    }`,
    { input },
    { clientId }
  );
  return data.createCart.cart;
}

async function getAvailableItem(config, cartId, itemId, { clientId } = {}) {
  const data = await clientGql(
    config,
    `query($id: ID!, $itemId: ID!) {
      cart(id: $id) {
        availableItem(id: $itemId) {
          __typename
          id
          name
          ... on CartAvailableBookableItem {
            disabled
            disabledDescription
            staffVariants {
              id
              duration
              price
              staff { id displayName }
            }
          }
        }
      }
    }`,
    { id: cartId, itemId },
    { clientId }
  );
  return data.cart?.availableItem || null;
}

async function listAvailableBookableServices(
  config,
  cartId,
  { includeNonExternallyBookable = true, first = 50, query, clientId } = {}
) {
  const data = await clientGql(
    config,
    `query($id: ID!, $first: Int!, $includeNon: Boolean!, $query: String) {
      cart(id: $id) {
        availableServices(
          first: $first
          includeNonExternallyBookable: $includeNon
          query: $query
        ) {
          edges {
            node {
              ... on CartAvailableServicePreview {
                id
                name
                bookable
                catalogItemId
                addon
              }
            }
          }
        }
      }
    }`,
    {
      id: cartId,
      first,
      includeNon: includeNonExternallyBookable,
      query: query || null,
    },
    { clientId }
  );
  return (data.cart?.availableServices?.edges || [])
    .map((e) => e.node)
    .filter(Boolean);
}

async function getServiceDetails(
  config,
  cartId,
  ids,
  { includeNonExternallyBookable = true, clientId } = {}
) {
  const data = await clientGql(
    config,
    `query($id: ID!, $ids: [ID!]!, $includeNon: Boolean!) {
      cart(id: $id) {
        availableServiceDetails(
          ids: $ids
          includeNonExternallyBookable: $includeNon
        ) {
          notFoundIds
          omittedIds
          details {
            ... on CartAvailableServiceDetail {
              id
              name
              bookable
              catalogItemId
            }
          }
        }
      }
    }`,
    { id: cartId, ids, includeNon: includeNonExternallyBookable },
    { clientId }
  );
  return data.cart?.availableServiceDetails;
}

async function addBookableItem(
  config,
  { cartId, itemId, itemStaffVariantId, clientId }
) {
  const input = { id: cartId, itemId };
  if (itemStaffVariantId) input.itemStaffVariantId = itemStaffVariantId;
  const data = await clientGql(
    config,
    `mutation($input: AddCartSelectedBookableItemInput!) {
      addCartSelectedBookableItem(input: $input) {
        cart {
          id
          errors { code message }
          selectedItems {
            __typename
            ... on CartBookableItem {
              id
              item { id name }
            }
          }
        }
      }
    }`,
    { input },
    { clientId }
  );
  return data.addCartSelectedBookableItem.cart;
}

async function cartBookableDates(
  config,
  { cartId, searchRangeLower, searchRangeUpper, tz, limit = 14, clientId }
) {
  const data = await clientGql(
    config,
    `query(
      $id: ID!
      $lower: Date
      $upper: Date
      $tz: Tz
      $limit: Int
    ) {
      cartBookableDates(
        id: $id
        searchRangeLower: $lower
        searchRangeUpper: $upper
        tz: $tz
        limit: $limit
      ) {
        date
      }
    }`,
    {
      id: cartId,
      lower: searchRangeLower || null,
      upper: searchRangeUpper || null,
      tz: tz || null,
      limit,
    },
    { clientId }
  );
  return data.cartBookableDates || [];
}

async function cartBookableTimes(
  config,
  { cartId, searchDate, tz, clientId }
) {
  const data = await clientGql(
    config,
    `query($id: ID!, $searchDate: Date!, $tz: Tz) {
      cartBookableTimes(id: $id, searchDate: $searchDate, tz: $tz) {
        id
        startTime
      }
    }`,
    { id: cartId, searchDate, tz: tz || null },
    { clientId }
  );
  return data.cartBookableTimes || [];
}

async function reserveBookableTime(
  config,
  { cartId, bookableTimeId, clientId }
) {
  const data = await clientGql(
    config,
    `mutation($input: ReserveCartBookableItemsInput!) {
      reserveCartBookableItems(input: $input) {
        cart {
          id
          startTime
          startTimeId
          errors { code message }
        }
      }
    }`,
    { input: { id: cartId, bookableTimeId } },
    { clientId }
  );
  return data.reserveCartBookableItems.cart;
}

async function updateCart(
  config,
  { cartId, clientInformation, clientMessage, clientId }
) {
  const input = { id: cartId };
  if (clientInformation) input.clientInformation = clientInformation;
  if (clientMessage != null) input.clientMessage = clientMessage;
  const data = await clientGql(
    config,
    `mutation($input: UpdateCartInput!) {
      updateCart(input: $input) {
        cart {
          id
          clientInformation {
            clientId
            email
            firstName
            lastName
            phoneNumber
          }
          errors { code message }
        }
      }
    }`,
    { input },
    { clientId }
  );
  return data.updateCart.cart;
}

async function checkoutCart(config, { cartId, clientId }) {
  const data = await clientGql(
    config,
    `mutation($input: CheckoutCartInput!) {
      checkoutCart(input: $input) {
        cart {
          id
          completedAt
          startTime
          endTime
          errors { code message }
          selectedItems {
            __typename
            ... on CartBookableItem {
              id
              item { id name }
              startTime
            }
          }
        }
        appointments {
          appointmentId
          clientId
          forCartOwner
        }
      }
    }`,
    { input: { id: cartId } },
    { clientId }
  );
  return data.checkoutCart;
}

module.exports = {
  clientApiUrl,
  clientBasicToken,
  generateClientToken,
  clientUuidFromId,
  clientGql,
  createCart,
  getAvailableItem,
  listAvailableBookableServices,
  getServiceDetails,
  addBookableItem,
  cartBookableDates,
  cartBookableTimes,
  reserveBookableTime,
  updateCart,
  checkoutCart,
};
