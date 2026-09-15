/**
 * Add CLIENT_* subscriptions to the active RubeTech staging webhook (Test B).
 *
 * Usage: npm run webhook:register-clients
 */
const { getConfig } = require('../src/config');
const { generateAdminToken } = require('../src/blvd/auth');
const { executeGraphQL, formatErrors } = require('../src/blvd/client');

const TARGET_URL =
  process.env.WEBHOOK_PUBLIC_URL ||
  'https://inkless-sync-staging-rubetech.onrender.com/webhooks/boulevard';

const CLIENT_EVENTS = [
  'CLIENT_CREATED',
  'CLIENT_UPDATED',
  'CLIENT_MERGED',
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
            id name url locationId
            subscriptions { id enabled eventType }
          }
        }
      }
    }`
  );
  if (list.errors?.length) throw new Error(formatErrors(list.errors));

  const webhooks = (list.data.webhooks.edges || []).map((e) => e.node);
  const active = webhooks.find((w) => w.url === TARGET_URL);
  if (!active) throw new Error(`No webhook found for ${TARGET_URL}`);

  console.log('Active webhook', active.id, active.url);
  console.log(
    'Current:',
    active.subscriptions.map((s) => `${s.eventType}:${s.enabled}`).join(', ')
  );

  const existing = new Set(active.subscriptions.map((s) => s.eventType));
  const missing = CLIENT_EVENTS.filter((e) => !existing.has(e));
  if (!missing.length) {
    console.log('CLIENT events already present — nothing to do.');
    return;
  }

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

  console.log('Updated subscriptions:');
  console.log(
    upd.data.updateWebhook.webhook.subscriptions
      .map((s) => `${s.eventType}:${s.enabled}`)
      .join('\n')
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
