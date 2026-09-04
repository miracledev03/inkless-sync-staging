const hs = require('../hubspot/client');
const log = require('../logger');
const { resolveInPersonConsultMatrix } = require('../matrix/in-person-consult');
const { resolveFirstSession100Matrix } = require('../matrix/first-session-100');
const { ensureAcquisitionDeal } = require('../acquisition-deals');
const { ensureTreatmentJourneyDeal } = require('../journey-deals');
const { plannedDealPropertyUpdates } = require('../deal-properties');
const { voidOrderForAppointment } = require('./orders');
const { JOURNEY_STAGE } = require('../journey-stages');

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

async function fetchContactLifecycle(config, contactId) {
  if (!contactId) return null;
  const contact = await hs.getContact(config.hubspotToken, contactId, [
    'lifecyclestage',
  ]);
  return contact.properties?.lifecyclestage || null;
}

function resolveMatrixForRole(
  appointment,
  eventType,
  classification,
  contactLifecycle,
  config
) {
  const role = classification?.primary?.role;
  if (role === 'first_session_100') {
    return resolveFirstSession100Matrix(
      appointment,
      eventType,
      classification,
      contactLifecycle,
      config
    );
  }
  if (role === 'in_office_consult') {
    return resolveInPersonConsultMatrix(appointment, eventType, classification);
  }
  return { apply: false, reason: 'no_boulevard_matrix_for_role', role };
}

async function applyMatrixResult(
  config,
  {
    matrix,
    appointment,
    classification,
    contactId,
    appointmentHsId,
    appointmentObjectTypeId,
    dryRun,
  }
) {
  const result = {
    matrix,
    contactId: contactId || null,
    deal: null,
    lifecycle: null,
    noShowCount: null,
    orderVoid: null,
    treatmentJourney: null,
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
      voidOrder: matrix.voidOrder,
      createTreatmentJourney: matrix.createTreatmentJourney,
    };
    if (matrix.createTreatmentJourney) {
      result.planned.treatmentJourney = {
        pipeline: 'Treatment Journey',
        dealStage: 'In Treatment',
      };
    }
    if (matrix.lifecycle === null && matrix.path === 'skipped_consult') {
      result.planned.lifecycleNote =
        'skipped_consult cancel needs Consultation No-Show/Cancel lifecycle in HubSpot';
    }
    return result;
  }

  const role = classification?.primary?.role;
  const consultType = classification?.primary?.consultationType || null;
  const firstName =
    appointment.client?.firstName || appointment.client?.first_name || 'Contact';
  const dealName =
    role === 'first_session_100'
      ? `First Session — ${firstName}`.trim()
      : `In-Person Consult — ${firstName}`.trim();

  const dealEnsure = await ensureAcquisitionDeal(config, contactId, {
    dealStage: matrix.dealStage,
    consultationType: consultType || undefined,
    dealName,
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
  } else if (
    matrix.path === 'skipped_consult' &&
    matrix.outcome &&
    matrix.outcome !== 'Scheduled'
  ) {
    log.warn('first session skipped-consult cancel: lifecycle stage missing', {
      contactId,
      appointmentId: appointment.id,
      hint: 'Add Consultation No-Show/Cancel in HubSpot or set HUBSPOT_CONSULTATION_NOSHOW_LIFECYCLE_VALUE',
    });
    result.lifecycle = {
      skipped: true,
      reason: 'consultation_noshow_cancel_lifecycle_not_configured',
    };
  }

  if (matrix.incrementNoShow) {
    result.noShowCount = await incrementNoShowCount(
      config.hubspotToken,
      contactId
    );
  }

  if (matrix.voidOrder && appointment.orderId) {
    result.orderVoid = await voidOrderForAppointment(config, {
      orderId: appointment.orderId,
      appointmentId: appointment.id,
    });
  }

  if (matrix.createTreatmentJourney) {
    const journeyEnsure = await ensureTreatmentJourneyDeal(config, contactId, {
      firstName,
      dealName: `Treatment Journey — ${firstName}`.trim(),
    });
    result.treatmentJourney = {
      action: journeyEnsure.action,
      dealId: journeyEnsure.dealId,
      dealStage: JOURNEY_STAGE.inTreatment,
    };

    if (appointmentHsId && appointmentObjectTypeId && journeyEnsure.dealId) {
      const journeyToAppt = await associateQuiet(
        config.hubspotToken,
        'deals',
        journeyEnsure.dealId,
        appointmentObjectTypeId,
        appointmentHsId
      );
      result.associations = {
        ...(result.associations || {}),
        journeyToAppointment: journeyToAppt,
      };
    }
  }

  if (appointmentHsId && appointmentObjectTypeId) {
    const dealToAppt = await associateQuiet(
      config.hubspotToken,
      'deals',
      dealEnsure.dealId,
      appointmentObjectTypeId,
      appointmentHsId
    );
    result.associations = {
      ...(result.associations || {}),
      dealToAppointment: dealToAppt,
    };
  }

  log.info('acquisition matrix applied', {
    matrix: matrix.matrix,
    appointmentId: appointment.id,
    contactId,
    dealId: dealEnsure.dealId,
    dealStage: matrix.dealStage,
    lifecycle: matrix.lifecycle,
    path: matrix.path,
    incrementNoShow: matrix.incrementNoShow,
    voidOrder: matrix.voidOrder,
  });

  return result;
}

/**
 * Apply Boulevard-driven Acquisition matrix (in-person consult or First Session).
 */
async function applyAcquisitionMatrix(
  config,
  {
    appointment,
    eventType,
    classification,
    contactId,
    contactLifecycle,
    appointmentHsId,
    appointmentObjectTypeId,
    dryRun,
  }
) {
  let lifecycle = contactLifecycle;
  const role = classification?.primary?.role;
  if (role === 'first_session_100' && lifecycle === undefined && contactId) {
    lifecycle = await fetchContactLifecycle(config, contactId);
  }

  const matrix = resolveMatrixForRole(
    appointment,
    eventType,
    classification,
    lifecycle,
    config
  );

  return applyMatrixResult(config, {
    matrix,
    appointment,
    classification,
    contactId,
    appointmentHsId,
    appointmentObjectTypeId,
    dryRun,
  });
}

/** @deprecated use applyAcquisitionMatrix */
async function applyInPersonConsultMatrix(config, opts) {
  return applyAcquisitionMatrix(config, opts);
}

module.exports = {
  applyAcquisitionMatrix,
  applyInPersonConsultMatrix,
  resolveInPersonConsultMatrix,
  resolveFirstSession100Matrix,
  resolveMatrixForRole,
  fetchContactLifecycle,
};
