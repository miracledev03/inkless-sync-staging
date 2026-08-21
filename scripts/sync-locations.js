const { getConfig } = require('../src/config');
const { syncLocations } = require('../src/handlers/locations');

async function main() {
  const config = getConfig();
  const result = await syncLocations(config);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
