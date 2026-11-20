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
  const notes = String(
    appointment?.cancellation?.notes || appointment?.notes || ''
  ).toUpperCase();
  const hay = `${reason} ${notes}`;
  return (
    hay.includes('NO_SHOW') ||
    hay.includes('NOSHOW') ||
    hay.includes('NO-SHOW') ||
    hay.includes('DID_NOT_SHOW') ||
    hay.includes('DID NOT SHOW') ||
    hay.includes('CLIENT DID NOT SHOW UP')
  );
}

module.exports = {
  normalizeEventType,
  appointmentState,
  isCancelled,
  isNoShowReason,
};
