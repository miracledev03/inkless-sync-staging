#!/usr/bin/env node
/**
 * Simulate HubSpot contact.propertyChange → Qualified & Engaged (local dev).
 * Set HUBSPOT_WEBHOOK_SKIP_VERIFY=true in .env.staging for unsigned local tests.
 *
 * Usage:
 *   npm run simulate:hs-qualify -- <contactId>
 */
const http = require('http');
const { getConfig } = require('../src/config');

async function main() {
  const contactId = process.argv[2];
  if (!contactId) {
    console.error('Usage: npm run simulate:hs-qualify -- <contactId>');
    process.exit(1);
  }

  const config = getConfig();
  const payload = [
    {
      objectId: Number(contactId) || contactId,
      propertyName: 'lifecyclestage',
      propertyValue: config.qualifiedLifecycleValue || '1409285288',
      changeSource: 'CRM',
      eventId: Date.now(),
      subscriptionId: 0,
      portalId: Number(config.hubspotPortalId) || 51888138,
      occurredAt: Date.now(),
      subscriptionType: 'contact.propertyChange',
      attemptNumber: 0,
    },
  ];

  const body = JSON.stringify(payload);
  const path = config.hubspotWebhookPath || '/webhooks/hubspot';

  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: config.port || 3456,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          console.log(res.statusCode, data);
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
