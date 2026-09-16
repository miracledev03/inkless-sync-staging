const http = require('http');
const { getConfig, loadServiceMap } = require('./config');
const log = require('./logger');
const blvd = require('./blvd/api');
const { createWebhookHandler } = require('./handlers/webhooks');
const { createHubSpotWebhookHandler } = require('./handlers/hubspot-webhooks');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function main() {
  const config = getConfig();
  const handleWebhook = createWebhookHandler(config);
  const handleHubSpotWebhook = createHubSpotWebhookHandler(config);
  let appointmentPoller = null;
  let clientPoller = null;
  const idempotency = require('./idempotency');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          portalId: config.hubspotPortalId,
          blvdEnv: config.blvdEnv,
          poller: appointmentPoller?.getStatus
            ? appointmentPoller.getStatus()
            : { enabled: false },
          clientPoller: clientPoller?.getStatus
            ? clientPoller.getStatus()
            : { enabled: false },
          idempotency: idempotency.stats(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/health/blvd') {
        const business = await blvd.getBusiness(config);
        return sendJson(res, 200, { ok: true, business });
      }

      if (req.method === 'GET' && url.pathname === '/health/hubspot') {
        const { hsRequest } = require('./hubspot/client');
        const contacts = await hsRequest(
          config.hubspotToken,
          'GET',
          '/crm/v3/objects/contacts?limit=1'
        );
        return sendJson(res, 200, {
          ok: true,
          portalId: config.hubspotPortalId,
          sampleCount: contacts.results?.length || 0,
        });
      }

      if (req.method === 'GET' && url.pathname === '/health/services') {
        const { path, map } = loadServiceMap(config);
        const required = [
          'virtual_consult_en',
          'virtual_consult_es',
          'in_office_consult',
          'first_session_100',
        ];
        const filled = required.filter((k) => map && map[k]);
        return sendJson(res, 200, {
          ok: filled.length === required.length,
          path,
          filled: filled.length,
          required: required.length,
          map,
        });
      }

      if (
        req.method === 'POST' &&
        (url.pathname === config.webhookPath || url.pathname === '/')
      ) {
        const rawBody = await readBody(req);
        return handleWebhook(req, res, rawBody);
      }

      if (
        req.method === 'POST' &&
        url.pathname === config.hubspotWebhookPath
      ) {
        const rawBody = await readBody(req);
        return handleHubSpotWebhook(req, res, rawBody);
      }

      if (req.method === 'POST' && url.pathname === '/create-client') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        // HubSpot workflow webhook payloads vary by template.
        const contactId =
          body.contactId ||
          body.objectId ||
          body.hs_object_id ||
          body.vid ||
          body?.properties?.hs_object_id ||
          body?.object?.objectId;
        if (!contactId) {
          return sendJson(res, 400, {
            ok: false,
            error: 'contactId required',
            hint: 'Send { "contactId": "<hubspot contact id>" }',
          });
        }
        const { processQualifyPath } = require('./handlers/clients');
        const result = await processQualifyPath(config, String(contactId));
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && url.pathname === '/refresh-deal-amounts') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        const contactId = body.contactId || body.id;
        if (!contactId) {
          return sendJson(res, 400, {
            ok: false,
            error: 'contactId required',
          });
        }
        const { refreshDealAmounts } = require('./deal-amounts');
        const result = await refreshDealAmounts(config, {
          contactId: String(contactId),
          dryRun: Boolean(body.dryRun),
        });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && url.pathname === '/sync-contact') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        const dryRun = Boolean(body.dryRun);
        const blvdClientId = body.blvdClientId || body.clientId;
        if (!blvdClientId) {
          return sendJson(res, 400, {
            ok: false,
            error: 'blvdClientId required',
          });
        }
        const clients = await blvd.listClients(config);
        const client = clients.find((c) => c.id === blvdClientId);
        if (!client) {
          return sendJson(res, 404, { ok: false, error: 'blvd_client_not_found' });
        }
        const { upsertContactFromBlvdClient } = require('./handlers/clients');
        const result = await upsertContactFromBlvdClient(config, client, {
          dryRun,
        });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && url.pathname === '/sync-appointment') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        const appointmentId =
          body.appointmentId ||
          body.blvdAppointmentId ||
          body.resourceId ||
          body.id;
        if (!appointmentId) {
          return sendJson(res, 400, {
            ok: false,
            error: 'appointmentId required',
            hint: 'Send { "appointmentId": "urn:blvd:Appointment:..." }',
          });
        }
        const eventType = body.eventType || 'APPOINTMENT_CREATED';
        const dryRun = Boolean(body.dryRun);
        const { processAppointmentWebhook } = require('./handlers/appointments');
        const result = await processAppointmentWebhook(config, {
          eventType,
          payload: { resourceId: String(appointmentId) },
          dryRun,
          forceOrigin: body.forceOrigin || undefined,
        });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && url.pathname === '/backfill-clients') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        // Default dry-run for safety; set { "apply": true } to write.
        const dryRun = body.apply === true ? false : true;
        const { backfillBlvdClients } = require('./handlers/clients');
        const result = await backfillBlvdClients(config, {
          dryRun,
          limit: body.limit,
        });
        return sendJson(res, 200, { ok: result.errors === 0, ...result });
      }

      if (req.method === 'POST' && url.pathname === '/book-consult') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        const { bookConsult } = require('./handlers/book-consult');
        try {
          const result = await bookConsult(config, body);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const status =
            err.code === 'MISSING_CONTACT' ||
            err.code === 'MISSING_SERVICE' ||
            err.code === 'SERVICE_MAP_MISSING'
              ? 400
              : err.code === 'SERVICE_NOT_EXTERNALLY_BOOKABLE' ||
                  err.code === 'NO_MATCHING_TIME' ||
                  err.code === 'NO_BOOKABLE_DATES'
                ? 409
                : 500;
          return sendJson(res, status, {
            ok: false,
            error: err.message,
            code: err.code || null,
            diagnostic: err.diagnostic || null,
            times: err.times || null,
            dates: err.dates || null,
          });
        }
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      log.error('request failed', {
        path: url.pathname,
        error: err.message,
        code: err.code,
        body: err.body,
      });
      sendJson(res, 500, {
        ok: false,
        error: err.message,
        code: err.code || null,
      });
    }
  });

  server.listen(config.port, () => {
    log.info('middleware listening', {
      port: config.port,
      webhookPath: config.webhookPath,
      hubspotWebhookPath: config.hubspotWebhookPath,
      portalId: config.hubspotPortalId,
      blvdEnv: config.blvdEnv,
    });
    try {
      const { createAppointmentPoller } = require('./pollers/appointments');
      const poller = createAppointmentPoller(config);
      appointmentPoller = poller.start();
    } catch (err) {
      log.warn('appointment poller failed to start', { error: err.message });
    }
    try {
      const { createClientPoller } = require('./pollers/clients');
      const poller = createClientPoller(config);
      clientPoller = poller.start();
    } catch (err) {
      log.warn('client poller failed to start', { error: err.message });
    }
  });
}

main().catch((err) => {
  log.error('server failed to start', { error: err.message });
  process.exit(1);
});
