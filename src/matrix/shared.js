function normalizeEventType(eventType) {
  return String(eventType || 'UNKNOWN')
    .replace(/[.\s]/g, '_')
    .toUpperCase();
}

function appointmentState(appointment) {
  return String(appointment?.state || '').toUpperCase();
}

function isCancelled(appointment) {
  const state = appointmentState(appointment);
  return (
    state === 'CANCELLED' ||
    state === 'CANCELED' ||
    Boolean(appointment?.cancelled)
  );
}

function isNoShowReason(appointment) {
  const reason = String(appointment?.cancellation?.reason || '').toUpperCase();
  return (
    reason.includes('NO_SHOW') ||
    reason.includes('NOSHOW') ||
    reason.includes('NO-SHOW') ||
    reason.includes('DID_NOT_SHOW') ||
    reason.includes('DID NOT SHOW')
  );
}

module.exports = {
  normalizeEventType,
  appointmentState,
  isCancelled,
  isNoShowReason,
};
