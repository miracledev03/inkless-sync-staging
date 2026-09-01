const hs = require('../hubspot/client');
const log = require('../logger');
const { resolveInPersonConsultMatrix } = require('../matrix/in-person-consult');
const { ensureAcquisitionDeal } = require('../acquisition-deals');
const { plannedDealPropertyUpdates } = require('../deal-properties');

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

  const consultType = classification?.primary?.consultationType || 'In-Person';
  const dealEnsure = await ensureAcquisitionDeal(config, contactId, {
    dealStage: matrix.dealStage,
    consultationType: consultType,
    dealName: `In-Person Consult — ${appointment.client?.firstName || 'Contact'}`.trim(),
  });

  const langProp = config.languageProperty || 'language';
  const dealUpdates = plannedDealPropertyUpdates(dealEnsure.deal, {
    consultationType: consultType,
    langProp,
    isNewDeal: dealEnsure.action === 'created',
  });
  if (dealEnsure.deal?.properties?.dealstage !== matrix.dealStage) {
    dealUpdates.dealstage = matrix.dealStage;
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
    b9: {
      consultationType: consultType,
      languageOnCreate: dealEnsure.action === 'created',
    },
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
};
