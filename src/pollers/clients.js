/**
 * Staging safety net: poll Boulevard clients and upsert HubSpot Contacts
 * when CLIENT_* webhooks do not deliver (Test B).
 */
const log = require('../logger');
const blvd = require('../blvd/api');
const { upsertContactFromBlvdClient } = require('../handlers/clients');

function fingerprint(client) {
  return [
    client.id,
    client.email || '',
    client.firstName || '',
    client.lastName || '',
    client.mobilePhone || '',
    client.dob || '',
  ].join('|');
}

function createClientPoller(config, opts = {}) {
  const intervalMs = Number(
    opts.intervalMs ||
      config.pollClientsIntervalMs ||
      process.env.POLL_CLIENTS_INTERVAL_MS ||
      60000
  );
  const enabledEnv = process.env.POLL_CLIENTS;
  const enabled =
    opts.enabled != null
      ? Boolean(opts.enabled)
      : enabledEnv != null
        ? String(enabledEnv).toLowerCase() === 'true' || enabledEnv === '1'
        : config.blvdEnv !== 'prod' && config.blvdEnv !== 'production';

  const seen = new Map();
  let timer = null;
  let running = false;
  const status = {
    enabled,
    intervalMs,
    startedAt: null,
    lastTickAt: null,
    lastSynced: 0,
    lastError: null,
    ticks: 0,
  };

  async function tick() {
    if (running) return;
    running = true;
    try {
      const clients = await blvd.listClients(config, { first: 50, maxPages: 1 });
      let synced = 0;
      const maxPerTick = Number(process.env.POLL_CLIENTS_MAX_PER_TICK || 10);

      for (const client of clients) {
        if (!client?.id) continue;
        const fp = fingerprint(client);
        if (seen.get(client.id) === fp) continue;

        try {
          const result = await upsertContactFromBlvdClient(config, client, {
            dryRun: false,
          });
          seen.set(client.id, fp);
          if (result.action === 'create' || result.action === 'update') {
            synced += 1;
            log.info('client poll synced', {
              clientId: client.id,
              action: result.action,
              contactId: result.contactId,
            });
          } else {
            synced += 1;
          }
        } catch (err) {
          log.warn('client poll sync failed', {
            clientId: client.id,
            error: err.message,
            code: err.code,
          });
        }

        if (synced >= maxPerTick) break;
      }

      if (seen.size > 800) {
        const keys = [...seen.keys()].slice(0, seen.size - 600);
        for (const k of keys) seen.delete(k);
      }

      status.lastTickAt = new Date().toISOString();
      status.lastSynced = synced;
      status.lastError = null;
      status.ticks += 1;
    } catch (err) {
      status.lastTickAt = new Date().toISOString();
      status.lastError = err.message;
      log.warn('client poll tick failed', { error: err.message });
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled) {
      log.info('client poller disabled');
      return { enabled: false, stop() {}, getStatus: () => ({ ...status }) };
    }
    log.info('client poller starting', { intervalMs });
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

module.exports = { createClientPoller, fingerprint };
