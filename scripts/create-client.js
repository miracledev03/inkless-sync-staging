const { getConfig } = require('../src/config');
const { processQualifyPath } = require('../src/handlers/clients');

async function main() {
  const contactId = process.argv[2];
  if (!contactId) {
    console.error('Usage: npm run create:client -- <hubspotContactId>');
    process.exit(1);
  }
  const config = getConfig();
  const result = await processQualifyPath(config, contactId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
