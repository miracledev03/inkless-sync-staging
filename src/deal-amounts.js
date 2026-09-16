/**
 * Deal amount rollups (Joey Sep 11):
 * - Acquisition: consult + First Session order totals, capped at $100
 * - Treatment Journey: sum of associated order amounts
 */
const hs = require('./hubspot/client');
const blvd = require('./blvd/api');
const log = require('./logger');
const { classifyAppointmentServices } = require('./classify-service');
const {
  listContactDeals,
  pickOpenAcquisitionDeal,
} = require('./acquisition-deals');
const {
  pickOpenTreatmentJourneyDeal,
} = require('./journey-deals');

const ACQUISITION_ROLES = new Set([
  'in_office_consult',
  'virtual_consult_en',
  'virtual_consult_es',
  'first_session_100',
]);

const ACQUISITION_AMOUNT_CAP = 100;

function orderAmountDollars(props = {}) {
  const status = String(props.blvd_order_status || '');
  if (/refund/i.test(status)) return 0;
  const paid = Number(props.blvd_amount_paid);
  if (Number.isFinite(paid)) return paid;
  const total = Number(props.blvd_order_total);
  if (Number.isFinite(total)) return total;
  return 0;
}

async function listOrdersForContact(config, contactId, blvdClientId) {
  const orderMeta = await hs.resolveObjectTypeId(
    config.hubspotToken,
    config.orderObject
  );
  const props = [
    'blvd_order_id',
    'blvd_order_total',
    'blvd_amount_paid',
    'blvd_order_status',
    'blvd_appointment_id',
    'blvd_client_id',
  ];

  const orders = [];
  const seen = new Set();

  try {
    const assoc = await hs.hsRequest(
      config.hubspotToken,
      'GET',
      `/crm/v4/objects/contacts/${contactId}/associations/${orderMeta.objectTypeId}`
    );
    for (const row of assoc.results || []) {
      const id = String(row.toObjectId || row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        const obj = await hs.hsRequest(
          config.hubspotToken,
          'GET',
          `/crm/v3/objects/${orderMeta.objectTypeId}/${id}?properties=${encodeURIComponent(props.join(','))}`
        );
        orders.push(obj);
      } catch (err) {
        log.warn('order fetch failed', { orderHsId: id, error: err.message });
      }
    }
  } catch (err) {
    log.warn('contact-order associations failed', {
      contactId,
      error: err.message,
    });
  }

  if (blvdClientId) {
    try {
      const found = await hs.hsRequest(
        config.hubspotToken,
        'POST',
        `/crm/v3/objects/${orderMeta.objectTypeId}/search`,
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'blvd_client_id',
                  operator: 'EQ',
                  value: blvdClientId,
                },
              ],
            },
          ],
          properties: props,
          limit: 50,
        }
      );
      for (const obj of found.results || []) {
        if (seen.has(obj.id)) continue;
        seen.add(obj.id);
        orders.push(obj);
      }
    } catch (err) {
      log.warn('order search by client failed', {
        blvdClientId,
        error: err.message,
      });
    }
  }

  return { orders, orderObjectTypeId: orderMeta.objectTypeId };
}

async function listOrdersForDeal(config, dealId, orderObjectTypeId) {
  const props = [
    'blvd_order_id',
    'blvd_order_total',
    'blvd_amount_paid',
    'blvd_order_status',
    'blvd_appointment_id',
  ];
  const orders = [];
  try {
    const assoc = await hs.hsRequest(
      config.hubspotToken,
      'GET',
      `/crm/v4/objects/deals/${dealId}/associations/${orderObjectTypeId}`
    );
    for (const row of assoc.results || []) {
      const id = String(row.toObjectId || row.id);
      try {
        const obj = await hs.hsRequest(
          config.hubspotToken,
          'GET',
          `/crm/v3/objects/${orderObjectTypeId}/${id}?properties=${encodeURIComponent(props.join(','))}`
        );
        orders.push(obj);
      } catch (err) {
        log.warn('deal-order fetch failed', { orderHsId: id, error: err.message });
      }
    }
  } catch (err) {
    log.warn('deal-order associations failed', {
      dealId,
      error: err.message,
    });
  }
  return orders;
}

async function isAcquisitionOrder(config, orderProps) {
  const appointmentId = orderProps?.blvd_appointment_id;
  if (!appointmentId || appointmentId === 'none') {
    // No appointment link — do not put on Acquisition rollup.
    return false;
  }
  try {
    const appointment = await blvd.getAppointment(config, appointmentId);
    if (!appointment) return false;
    const classification = classifyAppointmentServices(
      config,
      appointment.appointmentServices || []
    );
    const role = classification?.primary?.role;
    if (classification?.primary?.acquisitionOnly === true) return true;
    return ACQUISITION_ROLES.has(role);
  } catch (err) {
    log.warn('acquisition order classify failed', {
      appointmentId,
      error: err.message,
    });
    return false;
  }
}

/**
 * Refresh Acquisition + Treatment Journey deal amounts for a contact.
 */
async function refreshDealAmounts(config, { contactId, dryRun } = {}) {
  if (!contactId) {
    return { skipped: true, reason: 'missing_contact' };
  }

  const contact = await hs.getContact(config.hubspotToken, contactId, [
    config.blvdClientIdProperty,
  ]);
  const blvdClientId =
    contact.properties?.[config.blvdClientIdProperty] || null;

  const { orders, orderObjectTypeId } = await listOrdersForContact(
    config,
    contactId,
    blvdClientId
  );

  let acquisitionSum = 0;
  const acquisitionOrderIds = [];
  for (const order of orders) {
    const amt = orderAmountDollars(order.properties || {});
    if (amt <= 0) continue;
    if (await isAcquisitionOrder(config, order.properties || {})) {
      acquisitionSum += amt;
      acquisitionOrderIds.push(order.id);
    }
  }
  const acquisitionAmount = Math.min(ACQUISITION_AMOUNT_CAP, acquisitionSum);

  const langProp = config.languageProperty || 'language';
  const deals = await listContactDeals(config.hubspotToken, contactId, langProp);
  // Ensure amount is available on deal objects
  const acq = pickOpenAcquisitionDeal(deals);
  const journey = pickOpenTreatmentJourneyDeal(deals);

  let journeySum = 0;
  const journeyOrderIds = [];
  if (journey) {
    const journeyOrders = await listOrdersForDeal(
      config,
      journey.id,
      orderObjectTypeId
    );
    // Prefer deal associations; if empty, fall back to non-acquisition contact orders
    const source =
      journeyOrders.length > 0
        ? journeyOrders
        : (
            await Promise.all(
              orders.map(async (o) => ({
                order: o,
                acquisition: await isAcquisitionOrder(config, o.properties || {}),
              }))
            )
          )
            .filter((row) => !row.acquisition)
            .map((row) => row.order);

    for (const order of source) {
      const amt = orderAmountDollars(order.properties || {});
      if (amt <= 0) continue;
      journeySum += amt;
      journeyOrderIds.push(order.id);
    }
  }

  const result = {
    contactId,
    ordersConsidered: orders.length,
    acquisition: {
      dealId: acq?.id || null,
      rawSum: acquisitionSum,
      amount: acquisitionAmount,
      cap: ACQUISITION_AMOUNT_CAP,
      orderHsIds: acquisitionOrderIds,
    },
    journey: {
      dealId: journey?.id || null,
      amount: journeySum,
      orderHsIds: journeyOrderIds,
    },
    write: dryRun !== true,
  };

  if (dryRun === true) return result;

  if (acq) {
    const raw = acq.properties?.amount;
    const current =
      raw === null || raw === undefined || raw === ''
        ? null
        : Number(raw);
    if (current === null || current !== acquisitionAmount) {
      await hs.updateObject(config.hubspotToken, 'deals', acq.id, {
        amount: String(acquisitionAmount),
      });
      result.acquisition.updated = true;
    } else {
      result.acquisition.updated = false;
    }
  }

  if (journey) {
    const raw = journey.properties?.amount;
    const current =
      raw === null || raw === undefined || raw === ''
        ? null
        : Number(raw);
    if (current === null || current !== journeySum) {
      await hs.updateObject(config.hubspotToken, 'deals', journey.id, {
        amount: String(journeySum),
      });
      result.journey.updated = true;
    } else {
      result.journey.updated = false;
    }
  }

  log.info('deal amounts refreshed', {
    contactId,
    acquisitionDealId: result.acquisition.dealId,
    acquisitionAmount,
    journeyDealId: result.journey.dealId,
    journeyAmount: journeySum,
  });

  return result;
}

module.exports = {
  refreshDealAmounts,
  orderAmountDollars,
  ACQUISITION_AMOUNT_CAP,
};
