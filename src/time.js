/**
 * Location-local datetime helpers for same-slot HubSpot → Boulevard matching.
 * HubSpot Meetings usually send UTC ISO; Boulevard cart times are location-local
 * (often with an offset like 2026-11-17T09:00:00-08:00).
 */

function hasExplicitOffset(value) {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(String(value || '').trim());
}

/**
 * Format an absolute Date into YYYY-MM-DDTHH:mm:ss in `timeZone`.
 */
function formatInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}

/**
 * Normalize a start string to location-local NaiveDateTime (YYYY-MM-DDTHH:mm:ss).
 * - Naive input (no Z/offset) is treated as already local.
 * - ISO with Z/offset is converted into `timeZone`.
 */
/**
 * HubSpot Meeting webhooks often send datetime propertyValue as epoch ms
 * (e.g. "1795554900000"). `new Date("179555…")` is Invalid Date in Node — must
 * coerce numeric strings explicitly.
 */
function parseAbsoluteDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    // 10-digit ≈ seconds; 13-digit ≈ milliseconds.
    const ms = raw.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toLocationLocalNaive(value, timeZone = 'America/Los_Angeles') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('BookableTime') || raw.startsWith('urn:blvd:')) return raw;

  if (!hasExplicitOffset(raw) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    const bare = raw.replace(/\.\d+$/, '');
    return bare.length >= 19 ? bare.slice(0, 19) : `${bare.slice(0, 16)}:00`;
  }

  const d = parseAbsoluteDate(raw);
  if (!d) {
    return raw.replace(/\.\d+Z?$/, '').replace(/Z$/, '').slice(0, 19);
  }
  return formatInTimeZone(d, timeZone);
}

function localDateFromStart(value, timeZone) {
  const local = toLocationLocalNaive(value, timeZone);
  return /^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : null;
}

/**
 * Match a requested start to a cart bookable time for the given location tz.
 */
function matchBookableTime(times, requested, timeZone = 'America/Los_Angeles') {
  if (!requested) return null;
  const raw = String(requested).trim();
  if (raw.includes('BookableTime') || raw.startsWith('urn:blvd:')) {
    return times.find((t) => t.id === raw) || { id: raw, startTime: null };
  }

  const wantLocal = toLocationLocalNaive(raw, timeZone);
  const wantMin = wantLocal.slice(0, 16); // YYYY-MM-DDTHH:mm

  for (const t of times) {
    const stLocal = toLocationLocalNaive(t.startTime || '', timeZone);
    if (!stLocal) continue;
    if (stLocal === wantLocal) return t;
    if (stLocal.slice(0, 16) === wantMin) return t;
  }

  // Absolute ms fallback when both parse as Date
  const wantDate = parseAbsoluteDate(raw);
  if (wantDate) {
    const wantMs = wantDate.getTime();
    for (const t of times) {
      const stDate = parseAbsoluteDate(t.startTime || '');
      if (stDate && Math.abs(stDate.getTime() - wantMs) < 60 * 1000) return t;
    }
  }
  return null;
}

module.exports = {
  hasExplicitOffset,
  formatInTimeZone,
  parseAbsoluteDate,
  toLocationLocalNaive,
  localDateFromStart,
  matchBookableTime,
};
