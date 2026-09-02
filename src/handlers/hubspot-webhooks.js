const fs = require('fs');
const path = require('path');
const log = require('../logger');
const idempotency = require('../idempotency');
const { verifyHubSpotWebhook } = require('../hubspot/webhook-auth');
const { processQualifyPath } = require('./clients');

const eventsDir = path.join(__dirname, '..', '..', 'data', 'hubspot-webhook-events');

function ensureDir() {
  if (!fs.existsSync(eventsDir)) fs.mkdirSync(eventsDir, { recursive: true });
}

function saveEvent(events, signatureValid) {
  ensureDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(eventsDir, `${timestamp}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        signatureValid,
        events,
      },
      null,
      2
    )
  );
  return filePath;
}

function normalizeEvents(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.events)) return body.events;
  if (body && body.objectId) return [body];
  return [];
}

function isQualifiedLifecycleChange(event, config) {
  if (event.subscriptionType !== 'contact.propertyChange') return false;
  if (String(event.propertyName || '').toLowerCase() !== 'lifecyclestage') {
    return false;
  }
  const want = String(config.qualifiedLifecycleValue || '1409285288');
  const value = String(event.propertyValue ?? '');
  return value === want;
}

async function handleQualifyEvent(config, event) {
  const contactId = String(event.objectId);
  if (!contactId) {
    return { action: 'skipped', reason: 'missing_object_id' };
  }

  const idemKey = event.eventId
    ? `hs:${event.eventId}`
    : `hs:${contactId}:${event.occurredAt}:${event.propertyValue}`;
  if (idempotency.seen(idemKey)) {
    return { action: 'duplicate', contactId };
  }

  const result = await processQualifyPath(config, contactId);
  idempotency.mark(idemKey, {
    type: 'contact.propertyChange',
    contactId,
    propertyValue: event.propertyValue,
  });
  return { action: 'qualify_path', contactId, ...result };
}

async function processHubSpotWebhookEvents(config, events) {
  const outcomes = [];
  for (const event of events) {
    if (!isQualifiedLifecycleChange(event, config)) {
      outcomes.push({
        action: 'ignored',
        subscriptionType: event.subscriptionType,
        propertyName: event.propertyName,
        objectId: event.objectId,
      });
      continue;
    }
    try {
      const outcome = await handleQualifyEvent(config, event);
      outcomes.push(outcome);
      log.info('hubspot qualify webhook processed', {
        contactId: event.objectId,
        outcome: outcome.action,
      });
    } catch (err) {
      log.error('hubspot qualify webhook failed', {
        contactId: event.objectId,
        error: err.message,
        code: err.code,
      });
      outcomes.push({
        action: 'error',
        contactId: event.objectId,
        error: err.message,
        code: err.code || null,
      });
    }
  }
  return outcomes;
}

function createHubSpotWebhookHandler(config) {
  return async function handleHubSpotWebhook(req, res, rawBody) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v[0] : v,
      ])
    );

    let body;
    try {
      body = JSON.parse(rawBody || '[]');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
      return;
    }

    const events = normalizeEvents(body);
    const publicUrl = config.hubspotWebhookPublicUrl || '';
    const requestUri =
      publicUrl ||
      `https://${headers.host || 'localhost'}${req.url || config.hubspotWebhookPath}`;

    let signatureValid = null;
    const secret = config.hubspotClientSecret;
    const skipVerify =
      config.hubspotWebhookSkipVerify === true ||
      config.hubspotWebhookSkipVerify === 'true';

    if (secret && !skipVerify) {
      signatureValid = verifyHubSpotWebhook({
        method: req.method || 'POST',
        requestUri,
        rawBody: typeof rawBody === 'string' ? rawBody : String(rawBody || ''),
        headers,
        clientSecret: secret,
      });
      if (!signatureValid) {
        log.warn('hubspot webhook rejected: invalid signature', {
          requestUri,
          version: headers['x-hubspot-signature-version'],
        });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_signature' }));
        return;
      }
    } else if (!secret) {
      log.warn('hubspot webhook: no client secret — verification skipped');
    }

    const savedTo = saveEvent(events, signatureValid);
    log.info('hubspot webhook received', {
      count: events.length,
      signatureValid,
      savedTo,
    });

    const outcomes = await processHubSpotWebhookEvents(config, events);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, processed: outcomes.length, outcomes }));
  };
}

module.exports = {
  createHubSpotWebhookHandler,
  processHubSpotWebhookEvents,
  isQualifiedLifecycleChange,
  normalizeEvents,
};
