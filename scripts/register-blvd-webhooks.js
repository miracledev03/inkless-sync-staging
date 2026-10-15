/**
 * Create or repair the sync's Boulevard webhook (all locations, all sync events).
 * Works in both auth modes; with BLVD_AUTH_MODE=oauth the webhook belongs to the OAuth app
 * and deliveries are signed with x-blvd-oauth-hmac-* (BLVD_CLIENT_SECRET).
 *
 * Dry run (default):  node scripts/register-blvd-webhooks.js
 * Apply:              node scripts/register-blvd-webhooks.js --apply
 * Other URL:          node scripts/register-blvd-webhooks.js --url=https://…/webhooks/boulevard --apply
 */
const { getConfig } = require('../src/config');
const { formatErrors } = require('../src/blvd/client');
const { adminExecute } = require('../src/blvd/api');

const EVENTS = [
  'APPOINTMENT_CREATED',
  'APPOINTMENT_UPDATED',
  'APPOINTMENT_RESCHEDULED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_COMPLETED',
  'ORDER_COMPLETED',
  'ORDER_REFUND_CLOSED',
  'CLIENT_CREATED',
  'CLIENT_UPDATED',
  'CLIENT_MERGED',
];
const MAX_RETRIES = 5;

const SUBSCRIPTION_FIELDS = 'subscriptions { id eventType enabled }';

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function run(c, query, variables) {
  const res = await adminExecute(c, query, variables);
  if (res.errors?.length) throw new Error(formatErrors(res.errors));
  return res.data;
}

async function main() {
  const c = getConfig();
  const apply = process.argv.includes('--apply');
  const url = arg('url') || c.webhookPublicUrl;
  if (!url) throw new Error('Set WEBHOOK_PUBLIC_URL or pass --url=');
  if (!/^https:\/\//.test(url)) throw new Error(`Webhook URL must be HTTPS: ${url}`);

  console.log(`BLVD ${c.blvdEnv} · auth ${c.blvdAuthMode} · API ${c.blvdApiVersion}`);
  console.log(`Target: ${url}`);
  console.log(apply ? 'Mode: APPLY' : 'Mode: dry run (pass --apply to write)');

  const data = await run(
    c,
    `query { webhooks(first: 50) { edges { node { id name url ${SUBSCRIPTION_FIELDS} } } } }`
  );
  const webhooks = (data.webhooks?.edges || []).map((e) => e.node);
  console.log(`\nExisting webhooks visible to this app: ${webhooks.length}`);
  for (const w of webhooks) {
    const subs = w.subscriptions.map((s) => `${s.eventType}${s.enabled ? '' : '(disabled)'}`);
    console.log(`- ${w.id} ${w.url}\n  ${subs.join(', ') || '(no subscriptions)'}`);
  }

  const existing = webhooks.filter((w) => w.url === url);
  if (existing.length > 1) {
    console.warn(`\nWARNING: ${existing.length} webhooks point at ${url}; deliveries will be duplicated. Delete extras.`);
  }
  const target = existing[0];

  if (!target) {
    console.log(`\nWill create a business-wide webhook with ${EVENTS.length} events.`);
    if (!apply) return;
    const created = await run(
      c,
      `mutation($input: CreateWebhookInput!) {
        createWebhook(input: $input) { webhook { id url ${SUBSCRIPTION_FIELDS} } }
      }`,
      {
        input: {
          url,
          name: `Inkless HubSpot Boulevard Sync (${c.blvdEnv})`,
          subscriptions: EVENTS.map((eventType) => ({ eventType, maxRetries: MAX_RETRIES })),
        },
      }
    );
    console.log('Created:', JSON.stringify(created.createWebhook.webhook, null, 2));
    return;
  }

  const enabled = new Set(
    target.subscriptions.filter((s) => s.enabled).map((s) => s.eventType)
  );
  const disabled = target.subscriptions.filter(
    (s) => !s.enabled && EVENTS.includes(s.eventType)
  );
  const missing = EVENTS.filter((e) => !enabled.has(e));
  if (!missing.length) {
    console.log('\nWebhook already has every sync event enabled. Nothing to do.');
    return;
  }
  console.log(`\nWill add: ${missing.join(', ')}`);
  if (disabled.length) {
    console.log(`Will replace disabled: ${disabled.map((s) => s.eventType).join(', ')}`);
  }
  if (!apply) return;

  const updated = await run(
    c,
    `mutation($input: UpdateWebhookInput!) {
      updateWebhook(input: $input) { webhook { id url ${SUBSCRIPTION_FIELDS} } }
    }`,
    {
      input: {
        id: target.id,
        subscriptions: [
          ...disabled.map((s) => ({ id: s.id, delete: true })),
          ...missing.map((eventType) => ({ eventType, maxRetries: MAX_RETRIES })),
        ],
      },
    }
  );
  console.log('Updated:', JSON.stringify(updated.updateWebhook.webhook, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
