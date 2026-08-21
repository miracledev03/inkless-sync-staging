const blvd = require('../blvd/api');
const hs = require('../hubspot/client');
const log = require('../logger');

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

module.exports = { ensureBlvdClientForContact };
