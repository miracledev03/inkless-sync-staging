const { STAGE, LIFECYCLE } = require('../acquisition-stages');
const {
  normalizeEventType,
  appointmentState,
  isCancelled,
  isNoShowReason,
} = require('./shared');

function qualifiedLifecycleValue(config) {
  return String(config.qualifiedLifecycleValue || LIFECYCLE.qualifiedEngaged);
}

function isSkippedConsultPath(contactLifecycle, config) {
  return String(contactLifecycle || '') === qualifiedLifecycleValue(config);
}

function isPostConsultPath(contactLifecycle) {
  return String(contactLifecycle || '') === LIFECYCLE.consultationAttended;
}

/**
 * Boulevard-driven 100 First Session matrix (spec §7.3).
 * contactLifecycle required for cancel branching (skipped vs post-consult).
 */
function resolveFirstSession100Matrix(
  appointment,
  eventType,
  classification,
  contactLifecycle,
  config = {}
) {
  const type = normalizeEventType(eventType);
  const role = classification?.primary?.role;
  const driver = classification?.primary?.outcomeDriver;

  if (role !== 'first_session_100' || driver !== 'boulevard') {
    return { apply: false, reason: 'not_first_session_boulevard_driven' };
  }

  if (type === 'APPOINTMENT_RESCHEDULED') {
    return {
      apply: false,
      reason: 'reschedule_sync_only',
      note: 'Stay First Session Booked; appointment times updated only',
    };
  }

  const state = appointmentState(appointment);
  const skipped = isSkippedConsultPath(contactLifecycle, config);
  const postConsult = isPostConsultPath(contactLifecycle);

  if (isCancelled(appointment)) {
    const noShow = isNoShowReason(appointment);
    let lifecycle = null;
    if (skipped) {
      const cancelLifecycle =
        config.consultationNoShowCancelLifecycle ||
        LIFECYCLE.consultationNoShowCancel;
      lifecycle = cancelLifecycle || null;
    }
    return {
      apply: true,
      matrix: 'first_session_100',
      path: skipped ? 'skipped_consult' : postConsult ? 'post_consult' : 'unknown',
      blvdState: state,
      outcome: noShow ? 'No-Show' : 'Cancelled',
      dealStage: STAGE.firstSessionNoShowCancelled,
      lifecycle,
      incrementNoShow: noShow,
      voidOrder: true,
    };
  }

  if (state === 'FINAL' || state === 'COMPLETED') {
    return {
      apply: true,
      matrix: 'first_session_100',
      path: skipped ? 'skipped_consult' : postConsult ? 'post_consult' : 'unknown',
      blvdState: state,
      outcome: 'Completed',
      dealStage: STAGE.closedWon,
      lifecycle: LIFECYCLE.activeCustomer,
      incrementNoShow: false,
      voidOrder: false,
      createTreatmentJourney: true,
    };
  }

  if (state === 'BOOKED' || type === 'APPOINTMENT_CREATED') {
    return {
      apply: true,
      matrix: 'first_session_100',
      path: skipped ? 'skipped_consult' : postConsult ? 'post_consult' : 'unknown',
      blvdState: state || 'BOOKED',
      outcome: 'Scheduled',
      dealStage: STAGE.firstSessionBooked,
      lifecycle: null,
      incrementNoShow: false,
      voidOrder: false,
    };
  }

  if (
    state === 'CONFIRMED' ||
    state === 'ACTIVE' ||
    state === 'ARRIVED' ||
    type === 'APPOINTMENT_CONFIRMED' ||
    type === 'APPOINTMENT_ACTIVE' ||
    type === 'APPOINTMENT_ARRIVED'
  ) {
    return {
      apply: false,
      reason: 'stay_first_session_booked',
      matrix: 'first_session_100',
      blvdState: state,
    };
  }

  return { apply: false, reason: 'no_matrix_transition', blvdState: state };
}

module.exports = {
  resolveFirstSession100Matrix,
  isSkippedConsultPath,
  isPostConsultPath,
};
