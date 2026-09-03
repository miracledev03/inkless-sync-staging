const { STAGE, LIFECYCLE } = require('../acquisition-stages');
const {
  normalizeEventType,
  appointmentState,
  isCancelled,
  isNoShowReason,
} = require('./shared');

/**
 * Boulevard-driven in-person consult matrix (spec §7.1).
 * Virtual consults use hubspot_meeting_outcome — not this module.
 */
function resolveInPersonConsultMatrix(appointment, eventType, classification) {
  const type = normalizeEventType(eventType);
  const role = classification?.primary?.role;
  const driver = classification?.primary?.outcomeDriver;

  if (role !== 'in_office_consult' || driver !== 'boulevard') {
    return { apply: false, reason: 'not_in_person_boulevard_driven' };
  }

  if (type === 'APPOINTMENT_RESCHEDULED') {
    return {
      apply: false,
      reason: 'reschedule_sync_only',
      note: 'BLVD Confirmed unchanged; appointment times updated only',
    };
  }

  const state = appointmentState(appointment);

  if (isCancelled(appointment)) {
    const noShow = isNoShowReason(appointment);
    return {
      apply: true,
      matrix: 'in_person_consult',
      blvdState: state,
      outcome: noShow ? 'No-Show' : 'Cancelled',
      dealStage: STAGE.consultationNoShowCancelled,
      lifecycle: null,
      incrementNoShow: noShow,
    };
  }

  if (state === 'FINAL' || state === 'COMPLETED') {
    return {
      apply: true,
      matrix: 'in_person_consult',
      blvdState: state,
      outcome: 'Completed',
      dealStage: STAGE.consultationAttended,
      lifecycle: LIFECYCLE.consultationAttended,
      incrementNoShow: false,
    };
  }

  if (state === 'BOOKED' || type === 'APPOINTMENT_CREATED') {
    return {
      apply: true,
      matrix: 'in_person_consult',
      blvdState: state || 'BOOKED',
      outcome: 'Scheduled',
      dealStage: STAGE.consultationBooked,
      lifecycle: LIFECYCLE.consultationBooked,
      incrementNoShow: false,
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
      reason: 'stay_consultation_booked',
      matrix: 'in_person_consult',
      blvdState: state,
    };
  }

  return { apply: false, reason: 'no_matrix_transition', blvdState: state };
}

module.exports = {
  resolveInPersonConsultMatrix,
  isNoShowReason,
  isCancelled,
  normalizeEventType,
};
