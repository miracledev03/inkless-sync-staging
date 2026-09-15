/**
 * Smoke Test B automation: simulate CLIENT_UPDATED → HubSpot Contact upsert.
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');
const {
  processClientWebhook,
  upsertContactFromBlvdClient,
} = require('../src/handlers/clients');
const blvd = require('../src/blvd/api');

async function main() {
  const c = getConfig();
  const clientId =
    process.argv[2] || 'urn:blvd:Client:6c5449f6-94e9-42d5-9502-c0674f4bfebb';

  const client = await blvd.getClient(c, clientId);
  if (!client) {
    console.error('client not found', clientId);
    process.exit(1);
  }

  const marker = `auto${Date.now().toString().slice(-6)}`;
  // Do not mutate BLVD permanently — webhook path uses getClient hydrate.
  // Prove processClientWebhook with current client, then prove phone round-trip
  // would require a BLVD write; instead verify webhook handler upserts HS.

  const webhookResult = await processClientWebhook(c, {
    eventType: 'CLIENT_UPDATED',
    payload: { resourceId: clientId },
  });
  console.log('webhookPath', webhookResult);

  const contact = await hs.getContact(c.hubspotToken, webhookResult.contactId, [
    'firstname',
    'lastname',
    'email',
    'phone',
    'mobilephone',
    c.blvdClientIdProperty,
  ]);

  const ok =
    webhookResult.action === 'update' || webhookResult.action === 'create';
  console.log(
    JSON.stringify(
      {
        PASS: ok,
        marker,
        contactId: webhookResult.contactId,
        blvdClientId: contact.properties?.[c.blvdClientIdProperty],
        email: contact.properties?.email,
        phone: contact.properties?.phone || contact.properties?.mobilephone,
      },
      null,
      2
    )
  );
  if (!ok) process.exit(1);

  // Second call should still upsert (idempotent update)
  const again = await upsertContactFromBlvdClient(c, client, { dryRun: false });
  console.log('secondUpsert', again.action, again.contactId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
