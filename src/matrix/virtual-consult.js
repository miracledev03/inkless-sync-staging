const { STAGE, LIFECYCLE } = require('../acquisition-stages');
const {
  normalizeEventType,
  appointmentState,
  isCancelled,
  isNoShowReason,
} = require('./shared');

/**
 * Boulevard-driven virtual consult matrix (Feature 4.2.1).
 * After Meeting Outcomes are written to BLVD as Final / Cancelled,
 * deal + lifecycle follow the same Acquisition stages as in-person.
 */
function resolveVirtualConsultMatrix(appointment, eventType, classification) {
  const type = normalizeEventType(eventType);
  const role = classification?.primary?.role;
  const driver = classification?.primary?.outcomeDriver;

  if (
    (role !== 'virtual_consult_en' && role !== 'virtual_consult_es') ||
    driver !== 'boulevard'
  ) {
    return { apply: false, reason: 'not_virtual_boulevard_driven' };
  }

  if (type === 'APPOINTMENT_RESCHEDULED') {
    return {
      apply: false,
      reason: 'reschedule_sync_only',
      note: 'Times updated only; stage stays Consultation Booked until Final/Cancel',
    };
  }

  const state = appointmentState(appointment);

  if (isCancelled(appointment)) {
    const noShow = isNoShowReason(appointment);
    return {
      apply: true,
      matrix: 'virtual_consult',
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
      matrix: 'virtual_consult',
      blvdState: state,
      outcome: 'Completed',
      dealStage: STAGE.consultationAttended,
      lifecycle: LIFECYCLE.consultationAttended,
      incrementNoShow: false,
    };
  }

  if (
    state === 'BOOKED' ||
    state === 'CONFIRMED' ||
    state === 'ACTIVE' ||
    state === 'ARRIVED' ||
    type === 'APPOINTMENT_CREATED' ||
    type === 'APPOINTMENT_CONFIRMED' ||
    type === 'APPOINTMENT_ACTIVE' ||
    type === 'APPOINTMENT_ARRIVED' ||
    type === 'APPOINTMENT_UPDATED'
  ) {
    return {
      apply: true,
      matrix: 'virtual_consult',
      blvdState: state || 'BOOKED',
      outcome: 'Scheduled',
      dealStage: STAGE.consultationBooked,
      lifecycle: LIFECYCLE.consultationBooked,
      incrementNoShow: false,
    };
  }

  return { apply: false, reason: 'no_matrix_transition', blvdState: state };
}

module.exports = {
  resolveVirtualConsultMatrix,
};
