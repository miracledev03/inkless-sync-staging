const blvd = require('../blvd/api');
const hs = require('../hubspot/client');
const log = require('../logger');

const ORDER_EVENTS = new Set([
  'ORDER_COMPLETED',
  'ORDER_REFUND_CLOSED',
]);

function isOrderEvent(eventType) {
  const t = String(eventType || '')
    .replace(/[.\s]/g, '_')
    .toUpperCase();
  return ORDER_EVENTS.has(t) || t.startsWith('ORDER_');
}

function normalizeEventType(eventType) {
  return String(eventType || 'UNKNOWN')
    .replace(/[.\s]/g, '_')
    .toUpperCase();
}

function parseOrderId(payload, headers = {}) {
  const candidates = [
    payload?.resourceId,
    payload?.resource_id,
    payload?.orderId,
    payload?.order_id,
    payload?.data?.id,
    payload?.data?.orderId,
    payload?.data?.order?.id,
    payload?.order?.id,
    headers['x-blvd-resource-id'],
  ];
  for (const c of candidates) {
    if (c && String(c).includes('Order')) return String(c);
  }
  if (payload?.id && String(payload.id).includes('Order')) {
    return String(payload.id);
  }
  return null;
}

function moneyToDollars(money) {
  if (money == null || money === '') return undefined;
  const cents = Number(money);
  if (!Number.isFinite(cents)) return undefined;
  return cents / 100;
}

function toEpochMs(iso) {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(ms) : undefined;
}

function sumPayments(order) {
  let total = 0;
  let found = false;
  for (const group of order.paymentGroups || []) {
    for (const payment of group.payments || []) {
      const value = Number(payment.paidAmount);
      if (Number.isFinite(value)) {
        total += value;
        found = true;
      }
    }
  }
  return found ? total : null;
}

function primaryLineLabel(order) {
  for (const group of order.lineGroups || []) {
    for (const line of group.lines || []) {
      if (line?.name) return line.name;
    }
  }
  if (order.number) return `Order ${order.number}`;
  return 'Boulevard Order';
}

function mapOrderStatus(order, eventType) {
  const type = normalizeEventType(eventType);
  if (type === 'ORDER_REFUND_CLOSED') return 'Refunded';
  const refundCents = Number(order.summary?.refundAmount || 0);
  if (Number.isFinite(refundCents) && refundCents > 0) return 'Refunded';
  if (order.closedAt) return 'Closed';
  return 'Open';
}

function plannedOrderProperties(order, { appointmentId, eventType }) {
  const paidCents = sumPayments(order);
  const props = {
    blvd_order_id: order.id,
    blvd_order_number: order.number || undefined,
    blvd_order_label: primaryLineLabel(order),
    blvd_order_status: mapOrderStatus(order, eventType),
    blvd_client_id: order.clientId || undefined,
    blvd_appointment_id: appointmentId || 'none',
    last_synced_at: String(Date.now()),
  };

  const subtotal = moneyToDollars(order.summary?.currentSubtotal);
  const total = moneyToDollars(order.summary?.currentTotal);
  const refunded = moneyToDollars(order.summary?.refundAmount);
  const paid =
    paidCents != null ? moneyToDollars(paidCents) : total;

  if (subtotal != null) props.blvd_order_subtotal = String(subtotal);
  if (total != null) props.blvd_order_total = String(total);
  if (paid != null) props.blvd_amount_paid = String(paid);
  if (refunded != null) props.blvd_amount_refunded = String(refunded);

  const createdAt = toEpochMs(order.createdAt);
  const closedAt = toEpochMs(order.closedAt);
  if (createdAt) props.blvd_order_created_at = createdAt;
  if (closedAt) props.blvd_order_date = closedAt;
  else if (createdAt) props.blvd_order_date = createdAt;

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

async function associateQuiet(token, fromType, fromId, toType, toId) {
  if (!fromId || !toId) return { ok: false, skipped: true };
  try {
    await hs.associateDefault(token, fromType, fromId, toType, toId);
    return { ok: true, fromId, toType, toId };
  } catch (err) {
    log.warn('order association failed', {
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

async function resolveAppointmentId(config, { order, appointmentIdHint }) {
  if (appointmentIdHint) return appointmentIdHint;
  const appt = await blvd.findAppointmentByOrderId(config, {
    orderId: order.id,
    clientId: order.clientId,
    locationId: order.locationId,
  });
  return appt?.id || null;
}

async function patchAppointmentOrderId(config, appointmentId, orderId) {
  if (!appointmentId || !orderId) return null;
  const apptMeta = await hs.resolveObjectTypeId(
    config.hubspotToken,
    config.appointmentObject
  );
  const apptIdProperty =
    config.appointmentIdProperty || 'blvd_appointment_id';
  const existing = await hs.searchByProperty(
    config.hubspotToken,
    apptMeta.objectTypeId,
    apptIdProperty,
    appointmentId,
    [apptIdProperty, 'blvd_appointment_order_id']
  );
  const hit = existing.results?.[0];
  if (!hit) return { action: 'skipped', reason: 'appointment_not_found' };
  if (hit.properties?.blvd_appointment_order_id === orderId) {
    return { action: 'unchanged', hsId: hit.id };
  }
  await hs.updateObject(config.hubspotToken, apptMeta.objectTypeId, hit.id, {
    blvd_appointment_order_id: orderId,
  });
  return { action: 'updated', hsId: hit.id };
}

/**
 * Upsert HubSpot blvd_orders and relate to Appointment + Contact when known.
 * Triggered by ORDER_COMPLETED / ORDER_REFUND_CLOSED or from appointment.orderId.
 */
async function processOrderUpsert(
  config,
  { orderId, appointmentId: appointmentIdHint, eventType, dryRun }
) {
  if (!orderId) {
    return {
      action: 'skipped',
      reason: 'missing_order_id',
      write: false,
    };
  }

  const order = await blvd.getOrder(config, orderId);
  if (!order) {
    log.warn('order not found in BLVD', { orderId, eventType });
    return {
      action: 'skipped',
      reason: 'order_not_found',
      orderId,
      write: false,
    };
  }

  const appointmentId = await resolveAppointmentId(config, {
    order,
    appointmentIdHint,
  });

  const orderMeta = await hs.resolveObjectTypeId(
    config.hubspotToken,
    config.orderObject
  );
  const orderIdProperty = config.orderIdProperty || 'blvd_order_id';

  const existingSearch = await hs.searchByProperty(
    config.hubspotToken,
    orderMeta.objectTypeId,
    orderIdProperty,
    order.id,
    [orderIdProperty, 'blvd_appointment_id']
  );
  const existingOrder = existingSearch.results?.[0] || null;

  const orderProperties = pickKnownProperties(
    plannedOrderProperties(order, {
      appointmentId,
      eventType: eventType || 'ORDER_COMPLETED',
    }),
    orderMeta.properties
  );

  const write = dryRun !== true;
  const result = {
    action: write ? 'upserted' : 'planned',
    write,
    eventType: normalizeEventType(eventType),
    orderId: order.id,
    appointmentId: appointmentId || null,
    orderProperties,
    hubspot: null,
  };

  if (!write) {
    log.info('order upsert planned (dry-run)', {
      orderId: order.id,
      appointmentId,
    });
    return result;
  }

  let hsOrderId;
  let orderAction;
  if (existingOrder) {
    const updated = await hs.updateObject(
      config.hubspotToken,
      orderMeta.objectTypeId,
      existingOrder.id,
      orderProperties
    );
    hsOrderId = updated.id;
    orderAction = 'update';
  } else {
    const created = await hs.createObject(
      config.hubspotToken,
      orderMeta.objectTypeId,
      orderProperties
    );
    hsOrderId = created.id;
    orderAction = 'create';
  }

  const associations = { appointment: null, contact: null };
  if (appointmentId) {
    const apptMeta = await hs.resolveObjectTypeId(
      config.hubspotToken,
      config.appointmentObject
    );
    const apptIdProperty =
      config.appointmentIdProperty || 'blvd_appointment_id';
    const appts = await hs.searchByProperty(
      config.hubspotToken,
      apptMeta.objectTypeId,
      apptIdProperty,
      appointmentId,
      [apptIdProperty]
    );
    const appt = appts.results?.[0];
    if (appt) {
      associations.appointment = await associateQuiet(
        config.hubspotToken,
        orderMeta.objectTypeId,
        hsOrderId,
        apptMeta.objectTypeId,
        appt.id
      );
      if (associations.appointment.ok) {
        associations.appointment.appointmentHsId = appt.id;
      }
    }

    const apptPatch = await patchAppointmentOrderId(
      config,
      appointmentId,
      order.id
    );
    associations.appointmentPatch = apptPatch;
  }

  if (order.clientId) {
    try {
      const contacts = await hs.searchContacts(
        config.hubspotToken,
        [
          {
            filters: [
              {
                propertyName: config.blvdClientIdProperty,
                operator: 'EQ',
                value: order.clientId,
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
          orderMeta.objectTypeId,
          hsOrderId,
          'contacts',
          contact.id
        );
        if (associations.contact.ok) {
          associations.contact.contactId = contact.id;
        }
      }
    } catch (err) {
      log.warn('order contact lookup failed', { error: err.message });
    }
  }

  result.hubspot = {
    order: {
      action: orderAction,
      hsId: hsOrderId,
      objectTypeId: orderMeta.objectTypeId,
    },
    associations,
  };

  log.info('order upserted to HubSpot', {
    orderId: order.id,
    hsId: hsOrderId,
    action: orderAction,
    appointmentId,
  });

  return result;
}

async function processOrderWebhook(config, { eventType, payload, headers, dryRun }) {
  const type = normalizeEventType(eventType);
  const orderId = parseOrderId(payload, headers);
  if (!orderId) {
    log.warn('order webhook missing id', { eventType: type });
    return {
      action: 'skipped',
      reason: 'missing_order_id',
      eventType: type,
      write: false,
    };
  }
  return processOrderUpsert(config, {
    orderId,
    eventType: type,
    dryRun,
  });
}

module.exports = {
  ORDER_EVENTS,
  isOrderEvent,
  parseOrderId,
  processOrderUpsert,
  processOrderWebhook,
  mapOrderStatus,
};
