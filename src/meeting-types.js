/**
 * Feature 4.2.1 — HubSpot Meeting Type / Outcome maps (per environment).
 */
const { getConfig, resolveFromRoot, readJsonIfExists } = require('./config');

function loadMeetingTypes(config = getConfig()) {
  const full = resolveFromRoot(config.meetingTypesPath);
  const map = readJsonIfExists(full);
  return { path: full, map };
}

function resolveServiceKeyFromMeeting(map, body = {}) {
  if (!map?.types) return null;
  const typeId = String(
    body.meetingTypeId || body.hs_meeting_type_id || body.typeId || ''
  ).trim();
  const typeName = String(
    body.meetingTypeName ||
      body.hs_meeting_title ||
      body.meetingName ||
      body.label ||
      ''
  )
    .trim()
    .toLowerCase();

  for (const [key, row] of Object.entries(map.types)) {
    if (typeId && row.meetingTypeId && String(row.meetingTypeId) === typeId) {
      return row.serviceKey || key;
    }
  }
  for (const [key, row] of Object.entries(map.types)) {
    const names = [row.meetingTypeName, row.label, key]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    if (typeName && names.some((n) => n === typeName || typeName.includes(n))) {
      return row.serviceKey || key;
    }
  }
  // Explicit serviceKey from workflow wins last.
  if (body.serviceKey) return String(body.serviceKey);
  return null;
}

function resolveOutcomeMapping(map, rawOutcome) {
  const raw = String(rawOutcome || '').trim();
  if (!raw || !map?.outcomes) return null;
  for (const [key, row] of Object.entries(map.outcomes)) {
    const values = (row.hsValues || []).map((v) => String(v).toLowerCase());
    if (values.includes(raw.toLowerCase())) {
      return {
        key,
        blvdState: row.blvdState,
        cancelReason: row.cancelReason || null,
      };
    }
  }
  return null;
}

module.exports = {
  loadMeetingTypes,
  resolveServiceKeyFromMeeting,
  resolveOutcomeMapping,
};
