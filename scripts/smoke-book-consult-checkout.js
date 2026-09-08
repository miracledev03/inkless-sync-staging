/**
 * Full B10 checkout smoke (creates a real sandbox appointment).
 * Usage:
 *   node scripts/smoke-book-consult-checkout.js
 *   node scripts/smoke-book-consult-checkout.js --startTime=2026-09-10T10:30:00
 */
const { getConfig } = require('../src/config');
const { bookConsult } = require('../src/handlers/book-consult');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const config = getConfig();
  const contactId = arg('contactId') || '242617729455';
  const serviceKey = arg('serviceKey') || 'virtual_consult_en';

  // First get availability
  const avail = await bookConsult(config, {
    contactId,
    serviceKey,
    availabilityOnly: true,
  });
  const startTime =
    arg('startTime') ||
    avail.sampleTimes?.[1]?.startTime ||
    avail.sampleTimes?.[0]?.startTime;
  if (!startTime) {
    console.error('No sample times available');
    process.exit(1);
  }

  console.log('Checkout smoke with', { contactId, serviceKey, startTime });
  const result = await bookConsult(config, {
    contactId,
    serviceKey,
    startTime,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('FAILED', err.code || 'ERROR', err.message);
  if (err.diagnostic) console.error(JSON.stringify(err.diagnostic, null, 2));
  if (err.cart) console.error('cart', JSON.stringify(err.cart, null, 2));
  if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
