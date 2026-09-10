/**
 * Staging safety net: poll Boulevard appointments and upsert HubSpot when
 * webhooks do not deliver. Enabled by default in non-prod blvdEnv.
 */
const log = require('../logger');
const blvd = require('../blvd/api');
const hs = require('../hubspot/client');
const {
  processAppointmentWebhook,
  mapStatus,
} = require('../handlers/appointments');

function fingerprint(appt) {
  return [
    appt.id,
    appt.state || '',
    appt.cancelled ? '1' : '0',
    appt.startAt || '',
    appt.endAt || '',
  ].join('|');
}

function createAppointmentPoller(config, opts = {}) {
  const intervalMs = Number(
    opts.intervalMs ||
      config.pollAppointmentsIntervalMs ||
      process.env.POLL_APPOINTMENTS_INTERVAL_MS ||
      15000
  );
  const enabledEnv = process.env.POLL_APPOINTMENTS;
  const enabled =
    opts.enabled != null
      ? Boolean(opts.enabled)
      : enabledEnv != null
        ? String(enabledEnv).toLowerCase() === 'true' || enabledEnv === '1'
        : config.blvdEnv !== 'prod' && config.blvdEnv !== 'production';

  const seen = new Map();
  let timer = null;
  let running = false;
  let apptMeta = null;
  const status = {
    enabled,
    intervalMs,
    startedAt: null,
    lastTickAt: null,
    lastSynced: 0,
    lastError: null,
    ticks: 0,
  };

  async function alreadyCurrentInHubSpot(appt) {
    try {
      if (!apptMeta) {
        apptMeta = await hs.resolveObjectTypeId(
          config.hubspotToken,
          config.appointmentObject
        );
      }
      const found = await hs.searchByProperty(
        config.hubspotToken,
        apptMeta.objectTypeId,
        config.appointmentIdProperty || 'blvd_appointment_id',
        appt.id,
        ['blvd_appointment_status']
      );
      const row = found.results?.[0];
      if (!row) return false;
      const want = appt.cancelled ? 'Cancelled' : mapStatus(appt.state) || null;
      const have = row.properties?.blvd_appointment_status || null;
      return Boolean(want && have && want === have);
    } catch {
      return false;
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const locations = await blvd.listLocations(config);
      const locationId = locations[0]?.id;
      if (!locationId) return;

      let appointments = await blvd.listRecentAppointments(config, {
        locationId,
        first: 40,
      });
      appointments = [...appointments].sort((a, b) =>
        String(b.startAt || '').localeCompare(String(a.startAt || ''))
      );

      let synced = 0;
      const maxPerTick = Number(process.env.POLL_APPOINTMENTS_MAX_PER_TICK || 8);

      for (const appt of appointments) {
        if (!appt?.id) continue;
        const fp = fingerprint(appt);
        if (seen.get(appt.id) === fp) continue;

        if (await alreadyCurrentInHubSpot(appt)) {
          seen.set(appt.id, fp);
          continue;
        }

        const eventType = appt.cancelled
          ? 'APPOINTMENT_CANCELLED'
          : String(appt.state || '').toUpperCase() === 'FINAL' ||
              String(appt.state || '').toUpperCase() === 'COMPLETED'
            ? 'APPOINTMENT_COMPLETED'
            : 'APPOINTMENT_UPDATED';

        try {
          const result = await processAppointmentWebhook(config, {
            eventType,
            payload: { resourceId: appt.id },
          });
          seen.set(appt.id, fp);
          synced += 1;
          log.info('appointment poll synced', {
            appointmentId: appt.id,
            eventType,
            action: result.action,
            hsId: result.hubspot?.appointment?.hsId || null,
            state: appt.state,
          });
        } catch (err) {
          log.warn('appointment poll sync failed', {
            appointmentId: appt.id,
            error: err.message,
          });
        }

        if (synced >= maxPerTick) break;
      }

      if (seen.size > 500) {
        const keys = [...seen.keys()].slice(0, seen.size - 400);
        for (const k of keys) seen.delete(k);
      }
      status.lastTickAt = new Date().toISOString();
      status.lastSynced = synced;
      status.lastError = null;
      status.ticks += 1;
    } catch (err) {
      status.lastTickAt = new Date().toISOString();
      status.lastError = err.message;
      log.warn('appointment poll tick failed', { error: err.message });
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled) {
      log.info('appointment poller disabled');
      return { enabled: false, stop() {}, getStatus: () => ({ ...status }) };
    }
    log.info('appointment poller starting', { intervalMs });
    status.startedAt = new Date().toISOString();
    tick().catch(() => {});
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    if (timer.unref) timer.unref();
    return {
      enabled: true,
      intervalMs,
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
      },
      tick,
      getStatus: () => ({ ...status, running }),
    };
  }

  return { start, tick, enabled, intervalMs, getStatus: () => ({ ...status }) };
}

module.exports = { createAppointmentPoller, fingerprint };
