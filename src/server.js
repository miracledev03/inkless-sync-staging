const http = require('http');
const { getConfig, loadServiceMap } = require('./config');
const log = require('./logger');
const blvd = require('./blvd/api');
const { createWebhookHandler } = require('./handlers/webhooks');

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

      if (req.method === 'POST' && url.pathname === '/create-client') {
        const rawBody = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        const contactId = body.contactId || body.objectId || body.hs_object_id;
        if (!contactId) {
          return sendJson(res, 400, {
            ok: false,
            error: 'contactId required',
          });
        }
        const { ensureBlvdClientForContact } = require('./handlers/clients');
        const result = await ensureBlvdClientForContact(config, String(contactId));
        return sendJson(res, 200, { ok: true, ...result });
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
      portalId: config.hubspotPortalId,
      blvdEnv: config.blvdEnv,
    });
  });
}

main().catch((err) => {
  log.error('server failed to start', { error: err.message });
  process.exit(1);
});
