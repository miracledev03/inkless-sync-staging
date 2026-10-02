/** Acquisition pipeline + stage + lifecycle IDs for the configured HubSpot portal. */
const { getConfig, loadHubSpotIds } = require('./config');

const config = getConfig();
const ids = loadHubSpotIds(config);

const ACQUISITION_PIPELINE_ID = String(ids.acquisition.pipelineId);

const STAGE = {
  newOpportunity: ids.acquisition.stages.newOpportunity,
  consultationBooked: ids.acquisition.stages.consultationBooked,
  consultationAttended: ids.acquisition.stages.consultationAttended,
  consultationNoShowCancelled: ids.acquisition.stages.consultationNoShowCancelled,
  firstSessionBooked: ids.acquisition.stages.firstSessionBooked,
  firstSessionNoShowCancelled: ids.acquisition.stages.firstSessionNoShowCancelled,
  closedWon: ids.acquisition.stages.closedWon,
  closedLost: ids.acquisition.stages.closedLost,
};

const LIFECYCLE = {
  lead: ids.lifecycle.lead,
  consultationBooked: ids.lifecycle.consultationBooked,
  consultationAttended: ids.lifecycle.consultationAttended,
  qualifiedEngaged: config.qualifiedLifecycleValue || ids.lifecycle.qualifiedEngaged,
  /** Skipped-consult First Session cancel/no-show. */
  consultationNoShowCancel:
    config.consultationNoShowCancelLifecycle ||
    ids.lifecycle.consultationNoShowCancel,
  activeCustomer: ids.lifecycle.activeCustomer,
  completedCustomer: ids.lifecycle.completedCustomer,
  churned: ids.lifecycle.churned,
};

const CLOSED_STAGES = new Set([STAGE.closedWon, STAGE.closedLost]);

module.exports = { ACQUISITION_PIPELINE_ID, STAGE, LIFECYCLE, CLOSED_STAGES };
