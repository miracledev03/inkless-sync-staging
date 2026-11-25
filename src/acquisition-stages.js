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

/**
 * Acquisition deal stages that should not be overwritten by an earlier
 * "booked/scheduled" matrix result (e.g. BLVD still CONFIRMED after Meeting
 * Outcome Completed already moved the deal to Attended).
 */
const DEAL_STAGE_RANK = {
  [STAGE.newOpportunity]: 10,
  [STAGE.consultationBooked]: 20,
  [STAGE.consultationAttended]: 30,
  [STAGE.consultationNoShowCancelled]: 30,
  [STAGE.firstSessionBooked]: 40,
  [STAGE.firstSessionNoShowCancelled]: 40,
  [STAGE.closedWon]: 50,
  [STAGE.closedLost]: 50,
};

function dealStageRank(stageId) {
  if (!stageId) return 0;
  const n = DEAL_STAGE_RANK[String(stageId)];
  return Number.isFinite(n) ? n : 0;
}

/** True when applying `next` would move the deal backward on the Acquisition path. */
function isDealStageRegression(currentStageId, nextStageId) {
  if (!currentStageId || !nextStageId) return false;
  if (String(currentStageId) === String(nextStageId)) return false;
  const cur = dealStageRank(currentStageId);
  const next = dealStageRank(nextStageId);
  if (!cur || !next) return false;
  return next < cur;
}

const LIFECYCLE_RANK = {
  [LIFECYCLE.lead]: 10,
  [LIFECYCLE.qualifiedEngaged]: 15,
  [LIFECYCLE.consultationBooked]: 20,
  [LIFECYCLE.consultationAttended]: 30,
  [LIFECYCLE.consultationNoShowCancel]: 30,
  [LIFECYCLE.activeCustomer]: 40,
  [LIFECYCLE.completedCustomer]: 50,
  [LIFECYCLE.churned]: 50,
};

function isLifecycleRegression(currentLifecycle, nextLifecycle) {
  if (!currentLifecycle || !nextLifecycle) return false;
  if (String(currentLifecycle) === String(nextLifecycle)) return false;
  const cur = LIFECYCLE_RANK[String(currentLifecycle)] || 0;
  const next = LIFECYCLE_RANK[String(nextLifecycle)] || 0;
  if (!cur || !next) return false;
  return next < cur;
}

module.exports = {
  ACQUISITION_PIPELINE_ID,
  STAGE,
  LIFECYCLE,
  CLOSED_STAGES,
  dealStageRank,
  isDealStageRegression,
  isLifecycleRegression,
};
