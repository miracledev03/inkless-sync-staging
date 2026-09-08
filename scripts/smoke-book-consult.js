/**
 * Smoke B10 Client API cart path (availability / catalog check).
 * Usage:
 *   node scripts/smoke-book-consult.js
 *   node scripts/smoke-book-consult.js --contactId=242617729455
 *   node scripts/smoke-book-consult.js --contactId=... --serviceKey=virtual_consult_en
 */
const { getConfig } = require('../src/config');
const { bookConsult } = require('../src/handlers/book-consult');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const config = getConfig();
  const contactId = arg('contactId') || '242617729455'; // STAGING InPerson fixture
  const serviceKey = arg('serviceKey') || 'virtual_consult_en';

  console.log('B10 smoke: bookConsult availabilityOnly', {
    contactId,
    serviceKey,
    portalId: config.hubspotPortalId,
    blvdEnv: config.blvdEnv,
  });

  try {
    const result = await bookConsult(config, {
      contactId,
      serviceKey,
      availabilityOnly: true,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log('\nOK — services are bookable via Client API. Ready for checkout smoke.');
  } catch (err) {
    console.error('\nFAILED', err.code || 'ERROR');
    console.error(err.message);
    if (err.diagnostic) {
      console.error('\ndiagnostic:', JSON.stringify(err.diagnostic, null, 2));
    }
    if (err.code === 'SERVICE_NOT_EXTERNALLY_BOOKABLE') {
      console.error(`
BLOCKER (sandbox config — not middleware code):
  Boulevard Client API cart only exposes Gift Cards right now.
  Enable Online Booking / Booking Widget for:
    - Virtual Free Tattoo Assessment EN
    - Virtual Free Tattoo Assessment ES
    - In Office Free Tattoo Assessment
    - 100 First Session
  Then re-run this smoke.

Note: Admin bookingCreate returns "This feature is not enabled for your application."
  Spec path is Client API cart (B10); ask Boulevard/Joey to enable online booking on services.
`);
    }
    process.exit(1);
  }
}

main();
