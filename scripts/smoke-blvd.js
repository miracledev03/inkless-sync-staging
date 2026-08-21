const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');

async function main() {
  const config = getConfig();
  if (!config.blvdApiKey || !config.blvdSecretKey || !config.blvdBusinessId) {
    console.error('Missing BLVD credentials in .env.staging. Run: npm run merge:blvd-env');
    process.exit(1);
  }
  const business = await blvd.getBusiness(config);
  const locations = await blvd.listLocations(config);
  console.log('BLVD auth OK');
  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Locations: ${locations.length}`);
  for (const loc of locations) {
    console.log(`  - ${loc.name} (${loc.id})`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
