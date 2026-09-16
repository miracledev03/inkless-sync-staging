/**
 * Phase D2 — Integration Review for ambiguous BLVD↔HS matches.
 * Persists in-memory + optional disk; best-effort HubSpot note on a contact.
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const storePath = path.join(__dirname, '..', 'data', 'integration-review.json');
const memory = [];
const MAX = Number(process.env.INTEGRATION_REVIEW_MAX || 200);

let diskEnabled = null;

function ensureStore() {
  if (diskEnabled === false) return false;
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, JSON.stringify({ items: [] }, null, 2));
    }
    diskEnabled = true;
    return true;
  } catch {
    diskEnabled = false;
    return false;
  }
}

function readDisk() {
  if (!ensureStore()) return { items: [] };
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return { items: [] };
  }
}

function writeDisk(store) {
  if (!ensureStore()) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  } catch {
    diskEnabled = false;
  }
}

function list(limit = 50) {
  const fromMem = [...memory].reverse();
  if (fromMem.length) return fromMem.slice(0, limit);
  const disk = readDisk();
  return (disk.items || []).slice().reverse().slice(0, limit);
}

async function maybeNoteHubSpot(config, item) {
  const contactId = item.contactIds?.[0];
  if (!contactId || !config?.hubspotToken) return null;
  try {
    const hs = require('./hubspot/client');
    const body = [
      `Integration Review (${item.code || 'AMBIGUOUS'})`,
      `At: ${item.at}`,
      `Reason: ${item.message}`,
      item.blvdClientId ? `BLVD Client: ${item.blvdClientId}` : null,
      item.email ? `Email: ${item.email}` : null,
      item.contactIds?.length
        ? `HubSpot Contact IDs: ${item.contactIds.join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const note = await hs.hsRequest(
      config.hubspotToken,
      'POST',
      '/crm/v3/objects/notes',
      {
        properties: {
          hs_timestamp: String(Date.now()),
          hs_note_body: body,
        },
      }
    );
    await hs.associateDefault(
      config.hubspotToken,
      'notes',
      note.id,
      'contacts',
      contactId
    );
    return { noteId: note.id, contactId };
  } catch (err) {
    log.warn('integration review HubSpot note failed', { error: err.message });
    return { error: err.message };
  }
}

async function record(config, entry = {}) {
  const item = {
    id: `ir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    code: entry.code || 'INTEGRATION_REVIEW',
    message: entry.message || 'Ambiguous match',
    blvdClientId: entry.blvdClientId || null,
    email: entry.email || null,
    contactIds: entry.contactIds || [],
    context: entry.context || null,
  };

  memory.push(item);
  while (memory.length > MAX) memory.shift();

  if (ensureStore()) {
    const store = readDisk();
    store.items = store.items || [];
    store.items.push(item);
    while (store.items.length > MAX) store.items.shift();
    writeDisk(store);
  }

  item.hubspotNote = await maybeNoteHubSpot(config, item);
  log.warn('integration review recorded', {
    id: item.id,
    message: item.message,
    blvdClientId: item.blvdClientId,
    contactIds: item.contactIds,
  });
  return item;
}

function stats() {
  return {
    memoryCount: memory.length,
    diskEnabled: Boolean(diskEnabled),
    recent: list(5),
  };
}

module.exports = { record, list, stats, storePath };
