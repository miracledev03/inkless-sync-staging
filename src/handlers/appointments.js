const blvd = require('../blvd/api');
const hs = require('../hubspot/client');
const log = require('../logger');
const {
  originFromWebhook,
  resolveOrigin,
  mayCreateBlvdAppointment,
} = require('../origin');
const { classifyAppointmentServices } = require('../classify-service');

const APPOINTMENT_EVENTS = new Set([
  'APPOINTMENT_CREATED',
  'APPOINTMENT_COMPLETED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
]);

const STATE_TO_STATUS = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  ACTIVE: 'Active',
  ARRIVED: 'Arrived',
  FINAL: 'Final',
  COMPLETED: 'Final',
  CANCELLED: 'Cancelled',
  CANCELED: 'Cancelled',
};

function isAppointmentEvent(eventType) {
  const t = String(eventType || '')
    .replace(/[.\s]/g, '_')
    .toUpperCase();
  return APPOINTMENT_EVENTS.has(t) || t.startsWith('APPOINTMENT_');
}

function normalizeEventType(eventType) {
  return String(eventType || 'UNKNOWN')
    .replace(/[.\s]/g, '_')
    .toUpperCase();
}

function parseAppointmentId(payload, headers = {}) {
  const candidates = [
    payload?.resourceId,
    payload?.resource_id,
    payload?.appointmentId,
    payload?.appointment_id,
    payload?.data?.id,
    payload?.data?.appointmentId,
    payload?.data?.appointment?.id,
    payload?.appointment?.id,
    headers['x-blvd-resource-id'],
  ];
  for (const c of candidates) {
    if (c && String(c).includes('Appointment')) return String(c);
  }
  if (payload?.id && String(payload.id).includes('Appointment')) {
    return String(payload.id);
  }
  return null;
}

function mapStatus(state) {
  const key = String(state || '').toUpperCase();
  return STATE_TO_STATUS[key] || null;
}

function mapOutcome(appointment) {
  const state = String(appointment.state || '').toUpperCase();
  const reason = String(appointment.cancellation?.reason || '').toUpperCase();
  if (state === 'CANCELLED' || state === 'CANCELED' || appointment.cancelled) {
    if (
      reason.includes('NO_SHOW') ||
      reason.includes('NOSHOW') ||
      reason.includes('NO-SHOW')
    ) {
      return 'No-Show';
    }
    return 'Cancelled';
  }
  if (state === 'FINAL' || state === 'COMPLETED') return 'Completed';
  return 'Scheduled';
}

function toEpochMs(iso) {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(ms) : undefined;
}

function staffName(staff) {
  if (!staff) return undefined;
  return (
    [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim() ||
    undefined
  );
}

function plannedAppointmentProperties(appointment, classification, origin) {
  const primary = classification.primary;
  const props = {
    blvd_appointment_id: appointment.id,
    blvd_appointment_source: origin,
    last_synced_at: String(Date.now()),
  };
  const status = mapStatus(appointment.state);
  if (status) props.blvd_appointment_status = status;
  const outcome = mapOutcome(appointment);
  if (outcome) props.blvd_appointment_outcome = outcome;
  const start = toEpochMs(appointment.startAt);
  const end = toEpochMs(appointment.endAt);
  if (start) props.blvd_appointment_start_time = start;
  if (end) props.blvd_appointment_end_time = end;
  if (appointment.duration != null) {
    props.blvd_appointment_duration = String(appointment.duration);
  }
  if (primary?.serviceName) {
    props.blvd_appointment_service_name = primary.serviceName;
  }
  props.blvd_appointment_order_id = appointment.orderId || 'none';
  if (appointment.clientId || appointment.client?.id) {
    props.blvd_client_id = appointment.clientId || appointment.client.id;
  }
  if (appointment.locationId || appointment.location?.id) {
    props.blvd_location_id = appointment.locationId || appointment.location.id;
  }
  if (primary?.consultationType) {
    props.consultation_type = primary.consultationType;
  }
  return props;
}

function plannedServiceProperties(svc, extra) {
  const props = {
    blvd_appointment_service_id: svc.appointmentServiceId,
  };
  if (svc.serviceId) props.blvd_service_id = svc.serviceId;
  if (svc.serviceName) props.blvd_service_name = svc.serviceName;
  if (extra?.duration != null) props.blvd_duration = String(extra.duration);
  if (extra?.price != null) props.blvd_price = String(extra.price);
  const name = staffName(extra?.staff);
  if (name) props.blvd_staff_name = name;
  return props;
}

function pickKnownProperties(props, schemaNames) {
  const allowed = new Set((schemaNames || []).map((n) => String(n)));
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

async function upsertByExternalId(
  token,
  objectTypeId,
  idProperty,
  externalId,
  properties,
  extraSearchProperties = []
) {
  const existing = await hs.searchByProperty(
    token,
    objectTypeId,
    idProperty,
    externalId,
    [idProperty, ...extraSearchProperties]
  );
  const hit = existing.results?.[0];
  if (hit) {
    const updated = await hs.updateObject(
      token,
      objectTypeId,
      hit.id,
      properties
    );
    return { action: 'update', hsId: updated.id, existing: hit };
  }
  const created = await hs.createObject(token, objectTypeId, properties);
  return { action: 'create', hsId: created.id, existing: null };
}

async function associateQuiet(token, fromType, fromId, toType, toId) {
  if (!fromId || !toId) return { ok: false, skipped: true };
  try {
    await hs.associateDefault(token, fromType, fromId, toType, toId);
    return { ok: true, fromId, toType, toId };
  } catch (err) {
    log.warn('association failed', {
      fromType,
      fromId,
      toType,
      toId,
      error: err.message,
      body: err.body,
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Parse + hydrate + classify, then upsert HubSpot Appointment + Appointment Service.
 * Pass dryRun: true to skip HubSpot writes (inspect script).
 */
async function processAppointmentWebhook(config, { eventType, payload, headers, dryRun }) {
  const type = normalizeEventType(eventType);
  const appointmentId = parseAppointmentId(payload, headers);
  if (!appointmentId) {
    log.warn('appointment webhook missing id', { eventType: type });
    return {
      action: 'skipped',
      reason: 'missing_appointment_id',
      eventType: type,
      write: false,
    };
  }

  const appointment = await blvd.getAppointment(config, appointmentId);
  if (!appointment) {
    log.warn('appointment not found in BLVD', { appointmentId, eventType: type });
    return {
      action: 'skipped',
      reason: 'appointment_not_found',
      appointmentId,
      eventType: type,
      write: false,
    };
  }

  const classification = classifyAppointmentServices(
    config,
    appointment.appointmentServices || []
  );

  const apptMeta = await hs.resolveObjectTypeId(
    config.hubspotToken,
    config.appointmentObject
  );
  const svcMeta = await hs.resolveObjectTypeId(
    config.hubspotToken,
    config.appointmentServiceObject
  );
  const originProperty =
    config.appointmentOriginProperty || 'blvd_appointment_source';
  const apptIdProperty =
    config.appointmentIdProperty || 'blvd_appointment_id';
  const svcIdProperty =
    config.appointmentServiceIdProperty || 'blvd_appointment_service_id';

  const existingSearch = await hs.searchByProperty(
    config.hubspotToken,
    apptMeta.objectTypeId,
    apptIdProperty,
    appointment.id,
    [apptIdProperty, originProperty]
  );
  const existingAppt = existingSearch.results?.[0] || null;
  const origin = resolveOrigin(
    existingAppt?.properties?.[originProperty],
    originFromWebhook()
  );

  const appointmentProperties = pickKnownProperties(
    plannedAppointmentProperties(appointment, classification, origin),
    apptMeta.properties
  );
  const extraById = Object.fromEntries(
    (appointment.appointmentServices || []).map((s) => [s.id, s])
  );
  const serviceProperties = (classification.services || []).map((svc) =>
    pickKnownProperties(
      plannedServiceProperties(svc, extraById[svc.appointmentServiceId]),
      svcMeta.properties
    )
  );

  const write = dryRun !== true;
  const result = {
    action: write ? 'upserted' : 'classified',
    write,
    eventType: type,
    origin,
    appointmentId: appointment.id,
    pipeline: classification.primary?.pipeline || null,
    consultationType: classification.primary?.consultationType || null,
    outcomeDriver: classification.primary?.outcomeDriver || null,
    acquisitionOnly: Boolean(classification.primary?.acquisitionOnly),
    mayCreateBlvdAppointment: mayCreateBlvdAppointment(origin),
    appointmentProperties,
    serviceProperties,
    hubspot: null,
  };

  if (!write) {
    log.info('appointment webhook classified (dry-run)', {
      eventType: type,
      appointmentId: appointment.id,
      origin,
      pipeline: result.pipeline,
    });
    return result;
  }

  const apptUpsert = existingAppt
    ? {
        action: 'update',
        hsId: (
          await hs.updateObject(
            config.hubspotToken,
            apptMeta.objectTypeId,
            existingAppt.id,
            appointmentProperties
          )
        ).id,
      }
    : {
        action: 'create',
        hsId: (
          await hs.createObject(
            config.hubspotToken,
            apptMeta.objectTypeId,
            appointmentProperties
          )
        ).id,
      };

  const serviceUpserts = [];
  for (const svcProps of serviceProperties) {
    const extId = svcProps[svcIdProperty];
    if (!extId) continue;
    const svcUpsert = await upsertByExternalId(
      config.hubspotToken,
      svcMeta.objectTypeId,
      svcIdProperty,
      extId,
      svcProps
    );
    const assoc = await associateQuiet(
      config.hubspotToken,
      svcMeta.objectTypeId,
      svcUpsert.hsId,
      apptMeta.objectTypeId,
      apptUpsert.hsId
    );
    serviceUpserts.push({ ...svcUpsert, associated: assoc.ok });
  }

  const associations = { contact: null, location: null };
  const blvdClientId = appointment.clientId || appointment.client?.id;
  if (blvdClientId) {
    try {
      const contacts = await hs.searchContacts(
        config.hubspotToken,
        [
          {
            filters: [
              {
                propertyName: config.blvdClientIdProperty,
                operator: 'EQ',
                value: blvdClientId,
              },
            ],
          },
        ],
        ['email', config.blvdClientIdProperty],
        2
      );
      const contact = contacts.results?.[0];
      if (contact) {
        associations.contact = await associateQuiet(
          config.hubspotToken,
          apptMeta.objectTypeId,
          apptUpsert.hsId,
          'contacts',
          contact.id
        );
        if (associations.contact.ok) {
          associations.contact.contactId = contact.id;
        }
      }
    } catch (err) {
      log.warn('appointment contact lookup failed', { error: err.message });
    }
  }

  const blvdLocationId = appointment.locationId || appointment.location?.id;
  if (blvdLocationId) {
    try {
      const locMeta = await hs.resolveObjectTypeId(
        config.hubspotToken,
        config.locationObject
      );
      const locs = await hs.searchByProperty(
        config.hubspotToken,
        locMeta.objectTypeId,
        config.locationBlvdIdProperty,
        blvdLocationId,
        [config.locationBlvdIdProperty]
      );
      const loc = locs.results?.[0];
      if (loc) {
        associations.location = await associateQuiet(
          config.hubspotToken,
          apptMeta.objectTypeId,
          apptUpsert.hsId,
          locMeta.objectTypeId,
          loc.id
        );
        if (associations.location.ok) associations.location.locationId = loc.id;
      }
    } catch (err) {
      log.warn('appointment location lookup failed', { error: err.message });
    }
  }

  result.hubspot = {
    appointment: {
      action: apptUpsert.action,
      hsId: apptUpsert.hsId,
      objectTypeId: apptMeta.objectTypeId,
    },
    services: serviceUpserts,
    associations,
  };

  log.info('appointment upserted to HubSpot', {
    eventType: type,
    appointmentId: appointment.id,
    hsId: apptUpsert.hsId,
    action: apptUpsert.action,
    origin,
    services: serviceUpserts.length,
  });

  if (appointment.orderId) {
    try {
      const { processOrderUpsert } = require('./orders');
      result.order = await processOrderUpsert(config, {
        orderId: appointment.orderId,
        appointmentId: appointment.id,
        eventType: 'ORDER_COMPLETED',
      });
    } catch (err) {
      log.warn('order upsert after appointment failed', {
        appointmentId: appointment.id,
        orderId: appointment.orderId,
        error: err.message,
      });
      result.order = { action: 'error', error: err.message };
    }
  }

  return result;
}

module.exports = {
  APPOINTMENT_EVENTS,
  isAppointmentEvent,
  parseAppointmentId,
  processAppointmentWebhook,
  mapStatus,
  mapOutcome,
};
