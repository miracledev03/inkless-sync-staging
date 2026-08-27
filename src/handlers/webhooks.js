const fs = require('fs');
const path = require('path');
const { verifyWebhookSignature } = require('../blvd/auth');
const idempotency = require('../idempotency');
const log = require('../logger');

const eventsDir = path.join(__dirname, '..', '..', 'data', 'webhook-events');

function ensureDir() {
  if (!fs.existsSync(eventsDir)) fs.mkdirSync(eventsDir, { recursive: true });
}

function saveEvent(eventType, payload, headers, signatureValid) {
  ensureDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeType = (eventType || 'unknown').replace(/[^\w.-]+/g, '_');
  const filePath = path.join(eventsDir, `${timestamp}_${safeType}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        signatureValid,
        headers: {
          'x-blvd-event': headers['x-blvd-event'],
          'x-blvd-event-type': headers['x-blvd-event-type'],
          'x-blvd-hmac-salt': headers['x-blvd-hmac-salt'],
          'x-blvd-hmac-sha256': headers['x-blvd-hmac-sha256'],
          'x-blvd-idempotency-key': headers['x-blvd-idempotency-key'],
        },
        body: payload,
      },
      null,
      2
    )
  );
  return filePath;
}

function createWebhookHandler(config) {
  return async function handleWebhook(req, res, rawBody) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v[0] : v,
      ])
    );

    let payload;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      payload = { rawBody };
    }

    const salt = headers['x-blvd-hmac-salt'];
    const signature = headers['x-blvd-hmac-sha256'];
    let signatureValid = null;
    if (salt && signature && config.blvdSecretKey) {
      try {
        signatureValid = verifyWebhookSignature(
          rawBody,
          config.blvdSecretKey,
          salt,
          signature
        );
      } catch (err) {
        signatureValid = false;
        log.warn('webhook signature verify error', { error: err.message });
      }
    }

    if (signatureValid === false) {
      log.warn('webhook rejected: invalid signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_signature' }));
      return;
    }

    const eventType =
      payload.eventType ||
      headers['x-blvd-event-type'] ||
      payload.event ||
      'UNKNOWN';
    const idemKey =
      headers['x-blvd-idempotency-key'] ||
      `${eventType}:${payload.id || payload.appointmentId || rawBody.slice(0, 64)}`;

    if (idempotency.seen(idemKey)) {
      log.info('webhook duplicate ignored', { eventType, idemKey });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, duplicate: true }));
      return;
    }

    const savedTo = saveEvent(eventType, payload, headers, signatureValid);
    idempotency.mark(idemKey, { eventType, savedTo });
    log.info('webhook received', { eventType, signatureValid, savedTo });

    if (String(eventType).startsWith('LOCATION_')) {
      log.info('location webhook queued for sync', { eventType });
    }

    let appointment = null;
    const { isAppointmentEvent, processAppointmentWebhook } = require('./appointments');
    if (isAppointmentEvent(eventType)) {
      try {
        appointment = await processAppointmentWebhook(config, {
          eventType,
          payload,
          headers,
        });
      } catch (err) {
        log.error('appointment webhook classify failed', {
          eventType,
          error: err.message,
        });
        appointment = { action: 'error', write: false, error: err.message };
      }
    }

    let order = null;
    const { isOrderEvent, processOrderWebhook } = require('./orders');
    if (isOrderEvent(eventType)) {
      try {
        order = await processOrderWebhook(config, {
          eventType,
          payload,
          headers,
        });
      } catch (err) {
        log.error('order webhook failed', {
          eventType,
          error: err.message,
        });
        order = { action: 'error', write: false, error: err.message };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, appointment, order }));
  };
}

module.exports = { createWebhookHandler, eventsDir };
