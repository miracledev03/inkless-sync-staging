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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          portalId: config.hubspotPortalId,
          blvdEnv: config.blvdEnv,
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
  });
}

main().catch((err) => {
  log.error('server failed to start', { error: err.message });
  process.exit(1);
});
