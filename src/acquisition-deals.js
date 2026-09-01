const hs = require('./hubspot/client');
const log = require('./logger');
const {
  ACQUISITION_PIPELINE_ID,
  STAGE,
  CLOSED_STAGES,
} = require('./acquisition-stages');

async function contactLanguage(token, contactId, langProp) {
  const contact = await hs.getContact(token, contactId, [langProp]);
  return contact.properties?.[langProp] || null;
}

async function buildDealCreateProperties(config, contactId, baseProps = {}) {
  const langProp = config.languageProperty || 'language';
  const props = { ...baseProps };
  if (contactId) {
    try {
      const lang = await contactLanguage(
        config.hubspotToken,
        contactId,
        langProp
      );
      if (lang) props[langProp] = lang;
    } catch (err) {
      log.warn('deal language copy failed', {
        contactId,
        error: err.message,
      });
    }
  }
  return props;
}

async function listContactDeals(token, contactId, langProp = 'language') {
  const props = [
    'dealname',
    'dealstage',
    'pipeline',
    'consultation_type',
    langProp,
  ];
  const assoc = await hs.hsRequest(
    token,
    'GET',
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );
  const ids = (assoc.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return [];

  const deals = [];
  for (const id of ids) {
    try {
      const deal = await hs.hsRequest(
        token,
        'GET',
        `/crm/v3/objects/deals/${id}?properties=${encodeURIComponent(props.join(','))}`
      );
      deals.push(deal);
    } catch (err) {
      log.warn('deal fetch failed', { dealId: id, error: err.message });
    }
  }
  return deals;
}

function pickOpenAcquisitionDeal(deals) {
  const acquisition = (deals || []).filter(
    (d) => d.properties?.pipeline === ACQUISITION_PIPELINE_ID
  );
  const open = acquisition.filter(
    (d) => !CLOSED_STAGES.has(d.properties?.dealstage)
  );
  open.sort(
    (a, b) =>
      Date.parse(b.properties?.hs_lastmodifieddate || b.updatedAt || 0) -
      Date.parse(a.properties?.hs_lastmodifieddate || a.updatedAt || 0)
  );
  return open[0] || acquisition[0] || null;
}

async function ensureAcquisitionDeal(config, contactId, opts = {}) {
  const langProp = config.languageProperty || 'language';
  const deals = await listContactDeals(
    config.hubspotToken,
    contactId,
    langProp
  );
  const existing = pickOpenAcquisitionDeal(deals);
  if (existing) {
    return { action: 'existing', dealId: existing.id, deal: existing };
  }

  const dealstage = opts.dealStage || STAGE.consultationBooked;
  const baseProps = {
    dealname: opts.dealName || 'Acquisition — Consult',
    pipeline: ACQUISITION_PIPELINE_ID,
    dealstage,
  };
  if (opts.consultationType) {
    baseProps.consultation_type = opts.consultationType;
  }

  const props = await buildDealCreateProperties(config, contactId, baseProps);
  const created = await hs.createObject(config.hubspotToken, 'deals', props);
  await hs.associateDefault(
    config.hubspotToken,
    'deals',
    created.id,
    'contacts',
    contactId
  );
  return { action: 'created', dealId: created.id, deal: created };
}

module.exports = {
  contactLanguage,
  buildDealCreateProperties,
  listContactDeals,
  pickOpenAcquisitionDeal,
  ensureAcquisitionDeal,
};
