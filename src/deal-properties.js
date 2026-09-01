const hs = require('./hubspot/client');
const log = require('./logger');
const {
  listContactDeals,
  pickOpenAcquisitionDeal,
} = require('./acquisition-deals');

/**
 * B9: Consultation Type Appointment → Deal; Language Contact → Deal on create.
 */

function plannedDealPropertyUpdates(
  deal,
  { consultationType, contactLanguage, langProp, isNewDeal }
) {
  const updates = {};
  if (
    consultationType &&
    deal?.properties?.consultation_type !== consultationType
  ) {
    updates.consultation_type = consultationType;
  }
  if (isNewDeal && contactLanguage && !deal?.properties?.[langProp]) {
    updates[langProp] = contactLanguage;
  }
  return updates;
}

/**
 * Copy Consultation Type to the Contact's open Acquisition deal (if any).
 * Language is set only when the deal is first created (see ensureAcquisitionDeal).
 */
async function syncOpenAcquisitionDealProperties(
  config,
  { contactId, consultationType, dryRun }
) {
  if (!contactId || !consultationType) {
    return { skipped: true, reason: 'missing_contact_or_consultation_type' };
  }

  const langProp = config.languageProperty || 'language';
  const deals = await listContactDeals(
    config.hubspotToken,
    contactId,
    langProp
  );
  const deal = pickOpenAcquisitionDeal(deals);
  if (!deal) {
    return { skipped: true, reason: 'no_open_acquisition_deal' };
  }

  const updates = plannedDealPropertyUpdates(deal, {
    consultationType,
    langProp,
    isNewDeal: false,
  });

  if (!Object.keys(updates).length) {
    return { skipped: true, reason: 'already_current', dealId: deal.id };
  }

  if (dryRun === true) {
    return { dryRun: true, dealId: deal.id, planned: updates };
  }

  await hs.updateObject(config.hubspotToken, 'deals', deal.id, updates);
  log.info('B9 deal properties synced', { dealId: deal.id, updates });
  return { dealId: deal.id, updated: updates };
}

module.exports = {
  syncOpenAcquisitionDealProperties,
  plannedDealPropertyUpdates,
};
