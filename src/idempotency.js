/**
 * Duplicate-delivery guard. Prefer in-memory (Render-safe); optionally
 * mirror to disk when the filesystem is writable.
 */
const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '..', 'data', 'idempotency.json');
const memory = new Map();
const DEFAULT_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_KEYS = Number(process.env.IDEMPOTENCY_MAX_KEYS || 5000);

let diskEnabled = null;

function ensureStore() {
  if (diskEnabled === false) return false;
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, JSON.stringify({ keys: {} }, null, 2));
    }
    diskEnabled = true;
    return true;
  } catch {
    diskEnabled = false;
    return false;
  }
}

function pruneMemory(now = Date.now()) {
  for (const [k, v] of memory.entries()) {
    if (!v || (v.expiresAt && v.expiresAt <= now)) memory.delete(k);
  }
  if (memory.size <= MAX_KEYS) return;
  const overflow = memory.size - MAX_KEYS;
  const keys = memory.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = keys.next();
    if (next.done) break;
    memory.delete(next.value);
  }
}

function readStore() {
  if (!ensureStore()) return { keys: {} };
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return { keys: {} };
  }
}

function writeStore(store) {
  if (!ensureStore()) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  } catch {
    diskEnabled = false;
  }
}

function seen(key) {
  if (!key) return false;
  const now = Date.now();
  pruneMemory(now);
  const mem = memory.get(key);
  if (mem && (!mem.expiresAt || mem.expiresAt > now)) return true;

  if (!ensureStore()) return false;
  const store = readStore();
  const row = store.keys[key];
  if (!row) return false;
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    delete store.keys[key];
    writeStore(store);
    return false;
  }
  memory.set(key, {
    at: row.at,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + DEFAULT_TTL_MS,
    ...row,
  });
  return true;
}

function mark(key, meta = {}) {
  if (!key) return;
  const now = Date.now();
  const expiresAt = now + DEFAULT_TTL_MS;
  const row = {
    at: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    ...meta,
  };
  pruneMemory(now);
  memory.set(key, { ...row, expiresAt });

  if (!ensureStore()) return;
  const store = readStore();
  store.keys[key] = row;
  const entries = Object.entries(store.keys);
  if (entries.length > MAX_KEYS) {
    entries
      .sort((a, b) => String(a[1].at || '').localeCompare(String(b[1].at || '')))
      .slice(0, entries.length - MAX_KEYS)
      .forEach(([k]) => {
        delete store.keys[k];
      });
  }
  writeStore(store);
}

function stats() {
  pruneMemory();
  return {
    memoryKeys: memory.size,
    diskEnabled: Boolean(diskEnabled),
    ttlMs: DEFAULT_TTL_MS,
  };
}

module.exports = { seen, mark, storePath, stats };
