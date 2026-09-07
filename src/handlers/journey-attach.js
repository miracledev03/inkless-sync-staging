const hs = require('../hubspot/client');
const log = require('../logger');
const { ensureTreatmentJourneyDeal } = require('../journey-deals');
const { JOURNEY_STAGE } = require('../journey-stages');

/**
 * True when appointment/order should map to Treatment Journey (C4/C5).
 * Consults + 100 First Session stay on Acquisition (C3 creates Journey only on Final).
 */
function shouldAttachToTreatmentJourney(classification) {
  const primary = classification?.primary;
  if (!primary) return false;
  if (primary.acquisitionOnly === true) return false;
  return primary.pipeline === 'treatment_journey' || !primary.role;
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

/**
 * C4/C5 — attach Appointment (and optional Order) to most recent open
 * Treatment Journey deal; auto-create at In Treatment if none exists.
 */
async function applyTreatmentJourneyAttach(
  config,
  {
    classification,
    contactId,
    firstName,
    appointmentHsId,
    appointmentObjectTypeId,
    orderHsId,
    orderObjectTypeId,
    dryRun,
  }
) {
  const result = {
    apply: false,
    write: dryRun !== true,
    contactId: contactId || null,
    deal: null,
    associations: null,
  };

  if (!shouldAttachToTreatmentJourney(classification)) {
    result.reason = 'not_treatment_journey_service';
    return result;
  }

  result.apply = true;

  if (!contactId) {
    result.skipped = true;
    result.reason = 'missing_contact';
    return result;
  }

  if (dryRun === true) {
    result.planned = {
      dealStage: JOURNEY_STAGE.inTreatment,
      associateAppointment: Boolean(appointmentHsId),
      associateOrder: Boolean(orderHsId),
    };
    return result;
  }

  const name = firstName || 'Contact';
  const journey = await ensureTreatmentJourneyDeal(config, contactId, {
    firstName: name,
    dealName: `Treatment Journey — ${name}`.trim(),
  });

  result.deal = {
    action: journey.action,
    dealId: journey.dealId,
    dealStage: JOURNEY_STAGE.inTreatment,
  };

  const associations = {};
  if (appointmentHsId && appointmentObjectTypeId) {
    associations.journeyToAppointment = await associateQuiet(
      config.hubspotToken,
      'deals',
      journey.dealId,
      appointmentObjectTypeId,
      appointmentHsId
    );
  }
  if (orderHsId && orderObjectTypeId) {
    associations.journeyToOrder = await associateQuiet(
      config.hubspotToken,
      'deals',
      journey.dealId,
      orderObjectTypeId,
      orderHsId
    );
  }
  result.associations = associations;

  log.info('treatment journey attach applied', {
    contactId,
    dealId: journey.dealId,
    action: journey.action,
    appointmentHsId: appointmentHsId || null,
    orderHsId: orderHsId || null,
  });

  return result;
}

module.exports = {
  shouldAttachToTreatmentJourney,
  applyTreatmentJourneyAttach,
};
