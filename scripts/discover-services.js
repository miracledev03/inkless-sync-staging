const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');

async function main() {
  const config = getConfig();
  const services = await blvd.listServices(config);
  console.log(`Found ${services.length} BLVD service(s)`);
  for (const s of services) {
    console.log(`${s.active ? 'Y' : 'N'}\t${s.name}\t${s.id}`);
  }

  const mapPath = path.join(
    __dirname,
    '..',
    'config',
    'service-map.staging.json'
  );
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const rules = [
    {
      key: 'virtual_consult_en',
      match: /virtual.*(en|english)|english.*virtual|assessment.*en/i,
    },
    {
      key: 'virtual_consult_es',
      match: /virtual.*(es|spanish)|spanish.*virtual|assessment.*es/i,
    },
    {
      key: 'in_office_consult',
      match: /in[- ]?office|in person|tattoo assessment/i,
    },
    {
      key: 'first_session_100',
      match: /100|first session|first treatment/i,
    },
  ];

  for (const rule of rules) {
    const hit = services.find((s) => rule.match.test(s.name));
    if (hit) {
      map[rule.key] = hit.id;
      console.log(`Mapped ${rule.key} -> ${hit.name}`);
    }
  }

  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
  console.log(`Wrote ${mapPath}`);
  if (!services.length) {
    console.log(
      'NOTE: Sandbox service catalog is empty. Create the four services in BLVD Admin, then re-run.'
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
