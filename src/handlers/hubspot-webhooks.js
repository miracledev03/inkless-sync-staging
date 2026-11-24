const fs = require('fs');
const path = require('path');
const log = require('../logger');
const idempotency = require('../idempotency');
const { verifyHubSpotWebhook } = require('../hubspot/webhook-auth');
const { processQualifyPath } = require('./clients');
const {
  processMeetingBooked,
  processMeetingRescheduled,
  processMeetingCanceled,
  processMeetingOutcome,
} = require('./meeting-sync');

const eventsDir = path.join(__dirname, '..', '..', 'data', 'hubspot-webhook-events');

/** HubSpot Meetings object type id (CRM). */
const MEETING_OBJECT_TYPE_IDS = new Set(['0-47', '47']);
/** HubSpot Contacts object type id (CRM). */
const CONTACT_OBJECT_TYPE_IDS = new Set(['0-1', '1']);

const SKIPPABLE_MEETING_CODES = new Set([
  'MEETING_TYPE_UNMAPPED',
  'MEETING_TYPES_MISSING',
  'MISSING_CONTACT',
  'MISSING_APPOINTMENT',
  'MISSING_START',
  'OUTCOME_UNMAPPED',
]);

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

function subscriptionKind(event) {
  const st = String(event.subscriptionType || '').toLowerCase();
  if (st.endsWith('.creation') || st === 'creation') return 'creation';
  if (st.endsWith('.deletion') || st === 'deletion') return 'deletion';
  if (st.endsWith('.propertychange') || st === 'propertychange') {
    return 'propertyChange';
  }
  if (st.endsWith('.associationchange') || st === 'associationchange') {
    return 'associationChange';
  }
  return st || 'unknown';
}

function isMeetingObject(event) {
  const ot = String(event.objectTypeId || '').trim();
  if (MEETING_OBJECT_TYPE_IDS.has(ot)) return true;
  const st = String(event.subscriptionType || '').toLowerCase();
  if (st.startsWith('meeting.') || st.startsWith('meeting_event.')) return true;
  const name = String(
    event.objectName || event.objectType || event.objectTypeName || ''
  )
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  return (
    name === 'MEETING' ||
    name === 'MEETINGS' ||
    name === 'MEETING_EVENT' ||
    name === 'MEETINGEVENT'
  );
}

function isContactObject(event) {
  const ot = String(event.objectTypeId || '').trim();
  if (CONTACT_OBJECT_TYPE_IDS.has(ot)) return true;
  const st = String(event.subscriptionType || '').toLowerCase();
  return st.startsWith('contact.');
}

function isQualifiedLifecycleChange(event, config) {
  if (!isContactObject(event)) return false;
  if (subscriptionKind(event) !== 'propertyChange') return false;
  if (String(event.propertyName || '').toLowerCase() !== 'lifecyclestage') {
    return false;
  }
  const want = String(config.qualifiedLifecycleValue || '');
  const value = String(event.propertyValue ?? '');
  return Boolean(want) && value === want;
}

/**
 * Classify a HubSpot webhook event into a 4.2.1 meeting action (or null).
 * Pure helper for routing + local simulates.
 */
function classifyMeetingWebhookEvent(event) {
  if (!isMeetingObject(event)) return null;

  const kind = subscriptionKind(event);
  const meetingId = event.objectId != null ? String(event.objectId) : null;
  if (!meetingId) return { action: 'ignored', reason: 'missing_object_id' };

  if (kind === 'creation') {
    return { action: 'booked', meetingId, reason: 'meeting_created' };
  }

  if (kind === 'deletion') {
    return { action: 'canceled', meetingId, reason: 'meeting_deleted' };
  }

  if (kind === 'associationChange') {
    const toType = String(event.toObjectTypeId || '').trim();
    const fromType = String(event.fromObjectTypeId || '').trim();
    const contactSide =
      CONTACT_OBJECT_TYPE_IDS.has(toType) ||
      CONTACT_OBJECT_TYPE_IDS.has(fromType);
    if (!contactSide) {
      return { action: 'ignored', meetingId, reason: 'assoc_not_contact' };
    }
    // Meeting↔Contact link often lands after creation — book once associated.
    return { action: 'booked', meetingId, reason: 'meeting_contact_associated' };
  }

  if (kind === 'propertyChange') {
    const prop = String(event.propertyName || '').toLowerCase();
    if (prop === 'hs_meeting_start_time' || prop === 'hs_timestamp') {
      return {
        action: 'reschedule_or_book',
        meetingId,
        startTime: event.propertyValue,
        reason: `property:${prop}`,
      };
    }
    if (prop === 'hs_meeting_outcome') {
      return {
        action: 'outcome',
        meetingId,
        outcome: event.propertyValue,
        reason: 'property:hs_meeting_outcome',
      };
    }
    return { action: 'ignored', meetingId, reason: `property:${prop || 'unknown'}` };
  }

  return { action: 'ignored', meetingId, reason: `kind:${kind}` };
}

function meetingIdemKey(event, classified) {
  if (event.eventId != null && event.eventId !== '') {
    return `hs:meeting:${event.eventId}`;
  }
  return `hs:meeting:${classified.action}:${classified.meetingId}:${
    event.occurredAt || ''
  }:${event.propertyName || ''}:${event.propertyValue ?? ''}`;
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
    type: event.subscriptionType || 'contact.propertyChange',
    contactId,
    propertyValue: event.propertyValue,
  });
  return { action: 'qualify_path', contactId, ...result };
}

async function handleMeetingEvent(config, event) {
  const classified = classifyMeetingWebhookEvent(event);
  if (!classified) {
    return { action: 'ignored', reason: 'not_meeting' };
  }
  if (classified.action === 'ignored') {
    return {
      action: 'ignored',
      meetingId: classified.meetingId || null,
      reason: classified.reason,
      subscriptionType: event.subscriptionType,
      propertyName: event.propertyName || null,
    };
  }

  const idemKey = meetingIdemKey(event, classified);
  if (idempotency.seen(idemKey)) {
    return {
      action: 'duplicate',
      meetingId: classified.meetingId,
      classified: classified.action,
    };
  }

  const baseBody = {
    meetingId: classified.meetingId,
    source: 'hubspot_meeting_subscription',
    subscriptionType: event.subscriptionType,
    changeSource: event.changeSource || null,
  };

  let result;
  try {
    if (classified.action === 'booked') {
      result = await processMeetingBooked(config, baseBody);
    } else if (classified.action === 'canceled') {
      result = await processMeetingCanceled(config, baseBody);
    } else if (classified.action === 'outcome') {
      result = await processMeetingOutcome(config, {
        ...baseBody,
        outcome: classified.outcome,
      });
    } else if (classified.action === 'reschedule_or_book') {
      const body = {
        ...baseBody,
        startTime: classified.startTime,
      };
      try {
        result = await processMeetingRescheduled(config, body);
      } catch (err) {
        if (err.code === 'MISSING_APPOINTMENT') {
          // First start-time write (or create raced ahead of stamp) → book.
          result = await processMeetingBooked(config, body);
          result = {
            ...result,
            routedFrom: 'reschedule_missing_appointment',
          };
        } else {
          throw err;
        }
      }
    } else {
      return {
        action: 'ignored',
        meetingId: classified.meetingId,
        reason: classified.reason,
      };
    }
  } catch (err) {
    if (SKIPPABLE_MEETING_CODES.has(err.code)) {
      log.info('hubspot meeting webhook skipped', {
        meetingId: classified.meetingId,
        code: err.code,
        reason: classified.reason,
        error: err.message,
      });
      idempotency.mark(idemKey, {
        type: event.subscriptionType,
        meetingId: classified.meetingId,
        skipped: err.code,
      });
      return {
        action: 'skipped',
        meetingId: classified.meetingId,
        classified: classified.action,
        reason: classified.reason,
        code: err.code,
        error: err.message,
      };
    }
    throw err;
  }

  idempotency.mark(idemKey, {
    type: event.subscriptionType,
    meetingId: classified.meetingId,
    classified: classified.action,
  });

  return {
    action: `meeting_${classified.action}`,
    meetingId: classified.meetingId,
    reason: classified.reason,
    result,
  };
}

async function processHubSpotWebhookEvents(config, events) {
  const outcomes = [];
  for (const event of events) {
    try {
      if (isQualifiedLifecycleChange(event, config)) {
        const outcome = await handleQualifyEvent(config, event);
        outcomes.push(outcome);
        log.info('hubspot qualify webhook processed', {
          contactId: event.objectId,
          outcome: outcome.action,
        });
        continue;
      }

      if (isMeetingObject(event)) {
        const outcome = await handleMeetingEvent(config, event);
        outcomes.push(outcome);
        log.info('hubspot meeting webhook processed', {
          meetingId: event.objectId,
          subscriptionType: event.subscriptionType,
          propertyName: event.propertyName || null,
          outcome: outcome.action,
          code: outcome.code || null,
        });
        continue;
      }

      outcomes.push({
        action: 'ignored',
        subscriptionType: event.subscriptionType,
        propertyName: event.propertyName,
        objectId: event.objectId,
        objectTypeId: event.objectTypeId || null,
      });
    } catch (err) {
      log.error('hubspot webhook event failed', {
        objectId: event.objectId,
        subscriptionType: event.subscriptionType,
        propertyName: event.propertyName,
        error: err.message,
        code: err.code,
      });
      outcomes.push({
        action: 'error',
        objectId: event.objectId,
        meetingId: isMeetingObject(event) ? String(event.objectId) : null,
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
  isMeetingObject,
  classifyMeetingWebhookEvent,
  normalizeEvents,
};
