const { getConfig } = require('../src/config');
const { generateAdminToken } = require('../src/blvd/auth');
const { executeGraphQL, formatErrors } = require('../src/blvd/client');

const TARGET =
  'https://inkless-sync-staging-rubetech.onrender.com/webhooks/boulevard';

const EVENTS = [
  'APPOINTMENT_CREATED',
  'APPOINTMENT_COMPLETED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
  'APPOINTMENT_UPDATED',
  'ORDER_COMPLETED',
  'ORDER_REFUND_CLOSED',
];

async function main() {
  const c = getConfig();
  const token = generateAdminToken(
    c.blvdBusinessId,
    c.blvdApiKey,
    c.blvdSecretKey
  );

  const list = await executeGraphQL(
    c.blvdAdminUrl,
    token,
    `query {
      webhooks(first: 20) {
        edges {
          node {
            id url
            subscriptions { id eventType enabled }
          }
        }
      }
    }`
  );
  if (list.errors?.length) throw new Error(formatErrors(list.errors));
  const webhooks = (list.data.webhooks.edges || []).map((e) => e.node);
  const active = webhooks.find((w) => w.url === TARGET);
  if (!active) throw new Error('active webhook not found');

  // Add APPOINTMENT_UPDATED if missing (status changes)
  const existing = new Set(active.subscriptions.map((s) => s.eventType));
  const missing = EVENTS.filter((e) => !existing.has(e));
  console.log('missing', missing);

  if (missing.length) {
    const subscriptions = [
      ...active.subscriptions.map((s) => ({
        id: s.id,
        eventType: s.eventType,
      })),
      ...missing.map((eventType) => ({ eventType })),
    ];
    const upd = await executeGraphQL(
      c.blvdAdminUrl,
      token,
      `mutation($input: UpdateWebhookInput!) {
        updateWebhook(input: $input) {
          webhook {
            id url
            subscriptions { id enabled eventType }
          }
        }
      }`,
      { input: { id: active.id, subscriptions } }
    );
    if (upd.errors?.length) throw new Error(formatErrors(upd.errors));
    console.log(
      'updated',
      upd.data.updateWebhook.webhook.subscriptions.map(
        (s) => `${s.eventType}:${s.enabled}`
      )
    );
  }

  // Recreate webhook (delete + create) to force Boulevard to refresh delivery
  const locId = 'urn:blvd:Location:2e08439f-34dd-49ed-9c51-a957e9c59c09';
  const del = await executeGraphQL(
    c.blvdAdminUrl,
    token,
    `mutation($input: DeleteWebhookInput!) {
      deleteWebhook(input: $input) { webhookId }
    }`,
    { input: { id: active.id } }
  );
  console.log('deleted', JSON.stringify(del));

  const create = await executeGraphQL(
    c.blvdAdminUrl,
    token,
    `mutation($input: CreateWebhookInput!) {
      createWebhook(input: $input) {
        webhook {
          id url
          subscriptions { id enabled eventType }
        }
      }
    }`,
    {
      input: {
        locationId: locId,
        url: TARGET,
        name: 'Inkless RubeTech staging (Sep9 recreate)',
        subscriptions: EVENTS.map((eventType) => ({ eventType })),
      },
    }
  );
  if (create.errors?.length) throw new Error(formatErrors(create.errors));
  console.log(
    'created',
    JSON.stringify(create.data.createWebhook.webhook, null, 2)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
