#!/usr/bin/env node
/**
 * Simulate HubSpot Meeting app subscriptions → POST /webhooks/hubspot (local).
 * Set HUBSPOT_WEBHOOK_SKIP_VERIFY=true for unsigned local tests.
 *
 * Usage:
 *   npm run simulate:hs-meeting -- booked --meeting=<meetingId>
 *   npm run simulate:hs-meeting -- reschedule --meeting=<id> --start=2026-11-24T17:00:00.000Z
 *   npm run simulate:hs-meeting -- outcome --meeting=<id> --outcome=Completed
 *   npm run simulate:hs-meeting -- cancel --meeting=<id>
 *   npm run simulate:hs-meeting -- classify   (no HTTP — print classifier samples)
 */
const http = require('http');
const { getConfig } = require('../src/config');
const {
  classifyMeetingWebhookEvent,
} = require('../src/handlers/hubspot-webhooks');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function buildEvent(kind, meetingId, opts = {}) {
  const portalId = Number(getConfig().hubspotPortalId) || 51888138;
  const base = {
    objectId: Number(meetingId) || meetingId,
    objectTypeId: '0-47',
    eventId: Date.now(),
    subscriptionId: 0,
    portalId,
    occurredAt: Date.now(),
    attemptNumber: 0,
    changeSource: 'CRM',
  };

  switch (kind) {
    case 'booked':
    case 'creation':
    case 'create':
      return {
        ...base,
        subscriptionType: 'object.creation',
      };
    case 'assoc':
    case 'association':
      return {
        ...base,
        subscriptionType: 'object.associationChange',
        fromObjectTypeId: '0-47',
        toObjectTypeId: '0-1',
        associationTypeId: 0,
        associationCategory: 'HUBSPOT_DEFINED',
      };
    case 'reschedule':
    case 'start':
      return {
        ...base,
        subscriptionType: 'object.propertyChange',
        propertyName: 'hs_meeting_start_time',
        propertyValue: opts.start || new Date().toISOString(),
      };
    case 'outcome':
      return {
        ...base,
        subscriptionType: 'object.propertyChange',
        propertyName: 'hs_meeting_outcome',
        propertyValue: opts.outcome || 'Completed',
      };
    case 'cancel':
    case 'canceled':
    case 'deletion':
    case 'delete':
      return {
        ...base,
        subscriptionType: 'object.deletion',
      };
    default:
      throw new Error(
        `Unknown kind "${kind}". Use booked|reschedule|outcome|cancel|assoc|classify`
      );
  }
}

async function postEvents(events) {
  const config = getConfig();
  const body = JSON.stringify(events);
  const path = config.hubspotWebhookPath || '/webhooks/hubspot';

  return new Promise((resolve, reject) => {
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

async function main() {
  const kind = (process.argv[2] || '').toLowerCase();
  if (!kind) {
    console.error(
      'Usage: npm run simulate:hs-meeting -- <booked|reschedule|outcome|cancel|assoc|classify> [--meeting=id] ...'
    );
    process.exit(1);
  }

  if (kind === 'classify') {
    const samples = [
      buildEvent('booked', '111'),
      buildEvent('reschedule', '111', { start: '2026-11-24T17:00:00.000Z' }),
      buildEvent('outcome', '111', { outcome: 'Completed' }),
      buildEvent('cancel', '111'),
      buildEvent('assoc', '111'),
      {
        objectId: 222,
        objectTypeId: '0-1',
        subscriptionType: 'object.propertyChange',
        propertyName: 'lifecyclestage',
        propertyValue: '1409285288',
      },
    ];
    for (const ev of samples) {
      console.log(
        JSON.stringify(
          {
            in: {
              subscriptionType: ev.subscriptionType,
              objectTypeId: ev.objectTypeId,
              propertyName: ev.propertyName || null,
            },
            out: classifyMeetingWebhookEvent(ev),
          },
          null,
          2
        )
      );
    }
    return;
  }

  const meetingId = arg('meeting') || process.argv[3];
  if (!meetingId || String(meetingId).startsWith('--')) {
    console.error('Pass --meeting=<hubspotMeetingId>');
    process.exit(1);
  }

  const event = buildEvent(kind, meetingId, {
    start: arg('start'),
    outcome: arg('outcome'),
  });
  console.log('posting', JSON.stringify(event, null, 2));
  await postEvents([event]);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
