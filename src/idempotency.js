const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '..', 'data', 'idempotency.json');

function ensureStore() {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify({ keys: {} }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(storePath, 'utf8'));
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function seen(key) {
  if (!key) return false;
  const store = readStore();
  return Boolean(store.keys[key]);
}

function mark(key, meta = {}) {
  if (!key) return;
  const store = readStore();
  store.keys[key] = {
    at: new Date().toISOString(),
    ...meta,
  };
  writeStore(store);
}

module.exports = { seen, mark, storePath };
