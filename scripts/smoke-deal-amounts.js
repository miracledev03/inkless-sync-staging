/**
 * Smoke deal amount rollups for a HubSpot contact.
 * Usage: node scripts/smoke-deal-amounts.js [contactId]
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');
const { refreshDealAmounts, ACQUISITION_AMOUNT_CAP } = require('../src/deal-amounts');

async function main() {
  const c = getConfig();
  const contactId = process.argv[2] || '242617729455';
  const result = await refreshDealAmounts(c, { contactId });
  console.log(JSON.stringify(result, null, 2));

  const langProp = c.languageProperty || 'language';
  const { listContactDeals } = require('../src/acquisition-deals');
  const deals = await listContactDeals(c.hubspotToken, contactId, langProp);
  const summary = deals.map((d) => ({
    id: d.id,
    name: d.properties?.dealname,
    pipeline: d.properties?.pipeline,
    stage: d.properties?.dealstage,
    amount: d.properties?.amount,
  }));
  console.log('deals', JSON.stringify(summary, null, 2));

  const acq = result.acquisition;
  if (acq?.dealId && acq.amount > ACQUISITION_AMOUNT_CAP) {
    console.error('FAIL: acquisition over cap');
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      PASS: true,
      acquisitionAmount: acq?.amount,
      journeyAmount: result.journey?.amount,
      cap: ACQUISITION_AMOUNT_CAP,
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
