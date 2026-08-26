const blvd = require('../blvd/api');
const hs = require('../hubspot/client');
const log = require('../logger');

const CONTACT_PROPS = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'mobilephone',
  'date_of_birth',
  'lifecyclestage',
];

/** Lifecycle stages that should not be overwritten by A6 backfill. */
const PROTECTED_LIFECYCLES = new Set([
  '1409285288', // Qualified & Engaged
  '1409274217', // Consultation Booked
  '1409285289', // Consultation Attended
  'customer', // Active Customer
  '1409162300', // Completed Customer
  '1409276676', // Churned
]);

function mapBlvdClientToContactProps(client, blvdClientIdProperty) {
  const props = {
    [blvdClientIdProperty]: client.id,
  };
  if (client.firstName) props.firstname = client.firstName;
  if (client.lastName) props.lastname = client.lastName;
  if (client.email) props.email = client.email;
  if (client.mobilePhone) {
    props.mobilephone = client.mobilePhone;
    props.phone = client.mobilePhone;
  }
  // HubSpot date_of_birth expects YYYY-MM-DD
  if (client.dob) {
    const raw = String(client.dob).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) props.date_of_birth = raw;
  }
  return props;
}

async function findContactForBlvdClient(config, client) {
  const props = [...CONTACT_PROPS, config.blvdClientIdProperty];

  const byId = await hs.searchContacts(
    config.hubspotToken,
    [
      {
        filters: [
          {
            propertyName: config.blvdClientIdProperty,
            operator: 'EQ',
            value: client.id,
          },
        ],
      },
    ],
    props,
    5
  );
  if (byId.results?.length === 1) {
    return { contact: byId.results[0], match: 'blvd_client_id' };
  }
  if (byId.results?.length > 1) {
    const err = new Error(
      `Ambiguous HS contact match for BLVD Client ID ${client.id}`
    );
    err.code = 'INTEGRATION_REVIEW';
    throw err;
  }

  if (client.email) {
    const byEmail = await hs.searchContacts(
      config.hubspotToken,
      [
        {
          filters: [
            {
              propertyName: 'email',
              operator: 'EQ',
              value: client.email,
            },
          ],
        },
      ],
      props,
      5
    );
    if (byEmail.results?.length === 1) {
      return { contact: byEmail.results[0], match: 'email' };
    }
    if (byEmail.results?.length > 1) {
      const err = new Error(
        `Ambiguous HS contact match for email ${client.email}`
      );
      err.code = 'INTEGRATION_REVIEW';
      throw err;
    }
  }

  if (client.externalId && /^\d+$/.test(String(client.externalId))) {
    try {
      const contact = await hs.getContact(
        config.hubspotToken,
        String(client.externalId),
        props
      );
      return { contact, match: 'externalId' };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  return { contact: null, match: null };
}

async function withRetry(fn, { tries = 3, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient =
        err.message === 'fetch failed' ||
        err.status === 429 ||
        err.status >= 500;
      if (!transient || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * A5 — BLVD client → HubSpot Contact upsert (ID, name, email, phone, DOB).
 * Does not set Imported - BLVD (that is A6 backfill only).
 */
async function upsertContactFromBlvdClient(config, client, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const props = mapBlvdClientToContactProps(client, config.blvdClientIdProperty);
  const { contact, match } = await withRetry(() =>
    findContactForBlvdClient(config, client)
  );
  const currentLifecycle = contact?.properties?.lifecyclestage || null;

  if (contact) {
    if (dryRun) {
      return {
        action: 'would_update',
        match,
        contactId: contact.id,
        blvdClientId: client.id,
        email: client.email || null,
        currentLifecycle,
        properties: props,
      };
    }
    const updated = await withRetry(() =>
      hs.updateContact(config.hubspotToken, contact.id, props)
    );
    log.info('contact upserted from BLVD', {
      action: 'update',
      match,
      contactId: updated.id,
      blvdClientId: client.id,
    });
    return {
      action: 'update',
      match,
      contactId: updated.id,
      blvdClientId: client.id,
      email: client.email || null,
      currentLifecycle,
    };
  }

  if (dryRun) {
    return {
      action: 'would_create',
      match: null,
      contactId: null,
      blvdClientId: client.id,
      email: client.email || null,
      currentLifecycle: null,
      properties: props,
    };
  }

  const created = await withRetry(() =>
    hs.createContact(config.hubspotToken, props)
  );
  log.info('contact upserted from BLVD', {
    action: 'create',
    contactId: created.id,
    blvdClientId: client.id,
  });
  return {
    action: 'create',
    match: null,
    contactId: created.id,
    blvdClientId: client.id,
    email: client.email || null,
    currentLifecycle: null,
  };
}

async function resolveImportedLifecycleValue(config) {
  if (config.importedBlvdLifecycleValue) {
    return config.importedBlvdLifecycleValue;
  }
  return hs.ensureImportedBlvdLifecycleStage(
    config.hubspotToken,
    config.importedBlvdLifecycleLabel
  );
}

function shouldSetImportedLifecycle(existingLifecycle, importedValue) {
  if (!existingLifecycle) return true;
  if (existingLifecycle === importedValue) return false;
  if (PROTECTED_LIFECYCLES.has(existingLifecycle)) return false;
  // lead / unknown early stages OK to set
  return true;
}

/**
 * A6 — Client-only historical backfill.
 * Default dryRun=true. Sets Lifecycle to Imported - BLVD on create / eligible updates.
 */
async function backfillBlvdClients(config, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const limit =
    opts.limit != null && Number(opts.limit) > 0 ? Number(opts.limit) : null;

  const importedValue = await resolveImportedLifecycleValue(config);
  let clients = await blvd.listClients(config);
  if (limit) clients = clients.slice(0, limit);

  const summary = {
    dryRun,
    importedLifecycleLabel: config.importedBlvdLifecycleLabel,
    importedLifecycleValue: importedValue,
    totalClients: clients.length,
    would_create: 0,
    would_update: 0,
    create: 0,
    update: 0,
    skipped_lifecycle: 0,
    integration_review: 0,
    errors: 0,
    results: [],
  };

  for (const client of clients) {
    try {
      const base = await upsertContactFromBlvdClient(config, client, {
        dryRun,
      });

      let lifecycleAction = 'none';
      let contactId = base.contactId;

      if (dryRun && base.action === 'would_create') {
        lifecycleAction = 'would_set_imported_blvd';
        summary.would_create += 1;
      } else if (dryRun && base.action === 'would_update') {
        summary.would_update += 1;
        if (
          shouldSetImportedLifecycle(base.currentLifecycle, importedValue)
        ) {
          lifecycleAction = 'would_set_imported_blvd';
        } else {
          lifecycleAction = 'skip_protected_lifecycle';
          summary.skipped_lifecycle += 1;
        }
      } else if (!dryRun && base.action === 'create') {
        summary.create += 1;
        await withRetry(() =>
          hs.updateContact(config.hubspotToken, contactId, {
            lifecyclestage: importedValue,
          })
        );
        lifecycleAction = 'set_imported_blvd';
      } else if (!dryRun && base.action === 'update') {
        summary.update += 1;
        if (
          shouldSetImportedLifecycle(base.currentLifecycle, importedValue)
        ) {
          await withRetry(() =>
            hs.updateContact(config.hubspotToken, contactId, {
              lifecyclestage: importedValue,
            })
          );
          lifecycleAction = 'set_imported_blvd';
        } else {
          lifecycleAction = 'skip_protected_lifecycle';
          summary.skipped_lifecycle += 1;
        }
      }

      summary.results.push({
        ...base,
        lifecycleAction,
      });
      // Soft throttle HubSpot search/update bursts in sandbox.
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      if (err.code === 'INTEGRATION_REVIEW') {
        summary.integration_review += 1;
      } else {
        summary.errors += 1;
      }
      log.error('backfill client failed', {
        blvdClientId: client.id,
        email: client.email,
        error: err.message,
        code: err.code,
      });
      summary.results.push({
        action: 'error',
        blvdClientId: client.id,
        email: client.email || null,
        error: err.message,
        code: err.code || null,
      });
    }
  }

  log.info('backfillBlvdClients complete', {
    dryRun,
    totalClients: summary.totalClients,
    would_create: summary.would_create,
    would_update: summary.would_update,
    create: summary.create,
    update: summary.update,
    skipped_lifecycle: summary.skipped_lifecycle,
    errors: summary.errors,
  });

  return summary;
}

/**
 * Lookup-before-create:
 * 1) If HS already has BLVD Client ID, reuse it.
 * 2) Else search BLVD by email.
 * 3) Else createClient and write ID back to HS.
 */
async function ensureBlvdClientForContact(config, contactId) {
  const propsNeeded = [
    'firstname',
    'lastname',
    'email',
    'phone',
    'mobilephone',
    config.blvdClientIdProperty,
  ];
  const contact = await hs.getContact(
    config.hubspotToken,
    contactId,
    propsNeeded
  );
  const p = contact.properties || {};
  const existingId = p[config.blvdClientIdProperty];
  if (existingId) {
    log.info('createClient skipped: already linked', {
      contactId,
      blvdClientId: existingId,
    });
    return { action: 'existing', contactId, blvdClientId: existingId };
  }

  const email = p.email;
  if (email) {
    const matches = await blvd.findClientsByEmails(config, [email]);
    if (matches.length === 1) {
      const client = matches[0];
      await hs.updateContact(config.hubspotToken, contactId, {
        [config.blvdClientIdProperty]: client.id,
      });
      log.info('createClient linked existing BLVD client by email', {
        contactId,
        blvdClientId: client.id,
      });
      return {
        action: 'linked',
        contactId,
        blvdClientId: client.id,
      };
    }
    if (matches.length > 1) {
      const err = new Error(
        `Ambiguous BLVD client match for email ${email} (${matches.length} hits)`
      );
      err.code = 'INTEGRATION_REVIEW';
      throw err;
    }
  }

  const input = {
    firstName: p.firstname || undefined,
    lastName: p.lastname || undefined,
    email: email || undefined,
    mobilePhone: p.mobilephone || p.phone || undefined,
    externalId: String(contactId),
  };

  const created = await blvd.createClient(config, input);
  // Write BLVD Client ID before any lifecycle automation re-fires create.
  await hs.updateContact(config.hubspotToken, contactId, {
    [config.blvdClientIdProperty]: created.id,
  });
  log.info('createClient created', {
    contactId,
    blvdClientId: created.id,
  });
  return { action: 'created', contactId, blvdClientId: created.id };
}

module.exports = {
  ensureBlvdClientForContact,
  upsertContactFromBlvdClient,
  backfillBlvdClients,
  mapBlvdClientToContactProps,
};
