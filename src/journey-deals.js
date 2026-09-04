const hs = require('./hubspot/client');
const log = require('./logger');
const {
  TREATMENT_JOURNEY_PIPELINE_ID,
  JOURNEY_STAGE,
  JOURNEY_CLOSED_STAGES,
} = require('./journey-stages');
const { buildDealCreateProperties, listContactDeals } = require('./acquisition-deals');

function pickOpenTreatmentJourneyDeal(deals) {
  const journey = (deals || []).filter(
    (d) => d.properties?.pipeline === TREATMENT_JOURNEY_PIPELINE_ID
  );
  const open = journey.filter(
    (d) => !JOURNEY_CLOSED_STAGES.has(d.properties?.dealstage)
  );
  open.sort(
    (a, b) =>
      Date.parse(b.properties?.hs_lastmodifieddate || b.updatedAt || 0) -
      Date.parse(a.properties?.hs_lastmodifieddate || a.updatedAt || 0)
  );
  return open[0] || null;
}

/**
 * C3 — ensure open Treatment Journey deal at In Treatment (most recent open wins).
 */
async function ensureTreatmentJourneyDeal(config, contactId, opts = {}) {
  const langProp = config.languageProperty || 'language';
  const deals = await listContactDeals(
    config.hubspotToken,
    contactId,
    langProp
  );
  const existing = pickOpenTreatmentJourneyDeal(deals);
  if (existing) {
    return { action: 'existing', dealId: existing.id, deal: existing };
  }

  const firstName = opts.firstName || 'Contact';
  const baseProps = {
    dealname: opts.dealName || `Treatment Journey — ${firstName}`.trim(),
    pipeline: TREATMENT_JOURNEY_PIPELINE_ID,
    dealstage: opts.dealStage || JOURNEY_STAGE.inTreatment,
  };

  const props = await buildDealCreateProperties(config, contactId, baseProps);
  const created = await hs.createObject(config.hubspotToken, 'deals', props);
  await hs.associateDefault(
    config.hubspotToken,
    'deals',
    created.id,
    'contacts',
    contactId
  );

  log.info('treatment journey deal created', {
    contactId,
    dealId: created.id,
    dealStage: baseProps.dealstage,
  });

  return { action: 'created', dealId: created.id, deal: created };
}

module.exports = {
  pickOpenTreatmentJourneyDeal,
  ensureTreatmentJourneyDeal,
};
