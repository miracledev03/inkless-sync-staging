const hs = require('../hubspot/client');
const log = require('../logger');
const {
  ACQUISITION_PIPELINE_ID,
  STAGE,
  CLOSED_STAGES,
} = require('../acquisition-stages');
const { resolveInPersonConsultMatrix } = require('../matrix/in-person-consult');

async function listContactDeals(token, contactId) {
  const assoc = await hs.hsRequest(
    token,
    'GET',
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );
  const ids = (assoc.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return [];

  const deals = [];
  for (const id of ids) {
    try {
      const deal = await hs.hsRequest(
        token,
        'GET',
        `/crm/v3/objects/deals/${id}?properties=dealname,dealstage,pipeline,consultation_type`
      );
      deals.push(deal);
    } catch (err) {
      log.warn('deal fetch failed', { dealId: id, error: err.message });
    }
  }
  return deals;
}

function pickOpenAcquisitionDeal(deals) {
  const acquisition = (deals || []).filter(
    (d) => d.properties?.pipeline === ACQUISITION_PIPELINE_ID
  );
  const open = acquisition.filter(
    (d) => !CLOSED_STAGES.has(d.properties?.dealstage)
  );
  open.sort(
    (a, b) =>
      Date.parse(b.properties?.hs_lastmodifieddate || b.updatedAt || 0) -
      Date.parse(a.properties?.hs_lastmodifieddate || a.updatedAt || 0)
  );
  return open[0] || acquisition[0] || null;
}

async function ensureAcquisitionDeal(config, contactId, opts = {}) {
  const deals = await listContactDeals(config.hubspotToken, contactId);
  const existing = pickOpenAcquisitionDeal(deals);
  if (existing) {
    return { action: 'existing', dealId: existing.id, deal: existing };
  }

  const dealstage = opts.dealStage || STAGE.consultationBooked;
  const props = {
    dealname: opts.dealName || 'Acquisition — In-Person Consult',
    pipeline: ACQUISITION_PIPELINE_ID,
    dealstage,
  };
  if (opts.consultationType) {
    props.consultation_type = opts.consultationType;
  }

  const created = await hs.createObject(config.hubspotToken, 'deals', props);
  await hs.associateDefault(
    config.hubspotToken,
    'deals',
    created.id,
    'contacts',
    contactId
  );
  return { action: 'created', dealId: created.id, deal: created };
}

async function associateQuiet(token, fromType, fromId, toType, toId) {
  if (!fromId || !toId) return { ok: false, skipped: true };
  try {
    await hs.associateDefault(token, fromType, fromId, toType, toId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function incrementNoShowCount(token, contactId) {
  const contact = await hs.getContact(token, contactId, ['noshow_count']);
  const current = Number(contact.properties?.noshow_count || 0);
  const next = Number.isFinite(current) ? current + 1 : 1;
  await hs.updateContact(token, contactId, { noshow_count: String(next) });
  return { from: current, to: next };
}

/**
 * Apply in-person consult matrix to Contact + Acquisition Deal (spec §7.1).
 */
async function applyInPersonConsultMatrix(
  config,
  {
    appointment,
    eventType,
    classification,
    contactId,
    appointmentHsId,
    appointmentObjectTypeId,
    dryRun,
  }
) {
  const matrix = resolveInPersonConsultMatrix(
    appointment,
    eventType,
    classification
  );

  const result = {
    matrix,
    contactId: contactId || null,
    deal: null,
    lifecycle: null,
    noShowCount: null,
    associations: null,
    write: dryRun !== true,
  };

  if (!matrix.apply) return result;
  if (!contactId) {
    result.skipped = true;
    result.reason = 'missing_contact';
    return result;
  }

  if (dryRun === true) {
    result.planned = {
      dealStage: matrix.dealStage,
      lifecycle: matrix.lifecycle,
      incrementNoShow: matrix.incrementNoShow,
    };
    return result;
  }

  const dealEnsure = await ensureAcquisitionDeal(config, contactId, {
    dealStage: matrix.dealStage,
    consultationType: classification?.primary?.consultationType || 'In-Person',
    dealName: `In-Person Consult — ${appointment.client?.firstName || 'Contact'}`.trim(),
  });

  const dealUpdates = {};
  if (dealEnsure.deal?.properties?.dealstage !== matrix.dealStage) {
    dealUpdates.dealstage = matrix.dealStage;
  }
  const consultType = classification?.primary?.consultationType;
  if (
    consultType &&
    dealEnsure.deal?.properties?.consultation_type !== consultType
  ) {
    dealUpdates.consultation_type = consultType;
  }

  if (Object.keys(dealUpdates).length) {
    await hs.updateObject(
      config.hubspotToken,
      'deals',
      dealEnsure.dealId,
      dealUpdates
    );
  }

  result.deal = {
    action: dealEnsure.action,
    dealId: dealEnsure.dealId,
    dealStage: matrix.dealStage,
    updated: Object.keys(dealUpdates),
  };

  if (matrix.lifecycle) {
    await hs.updateContact(config.hubspotToken, contactId, {
      lifecyclestage: matrix.lifecycle,
    });
    result.lifecycle = { set: matrix.lifecycle };
  }

  if (matrix.incrementNoShow) {
    result.noShowCount = await incrementNoShowCount(
      config.hubspotToken,
      contactId
    );
  }

  if (appointmentHsId && appointmentObjectTypeId) {
    const dealToAppt = await associateQuiet(
      config.hubspotToken,
      'deals',
      dealEnsure.dealId,
      appointmentObjectTypeId,
      appointmentHsId
    );
    result.associations = { dealToAppointment: dealToAppt };
  }

  log.info('in-person consult matrix applied', {
    appointmentId: appointment.id,
    contactId,
    dealId: dealEnsure.dealId,
    dealStage: matrix.dealStage,
    lifecycle: matrix.lifecycle,
    incrementNoShow: matrix.incrementNoShow,
  });

  return result;
}

module.exports = {
  applyInPersonConsultMatrix,
  resolveInPersonConsultMatrix,
  listContactDeals,
  pickOpenAcquisitionDeal,
};
