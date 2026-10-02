/** Treatment Journey pipeline + stage IDs for the configured HubSpot portal. */
const { loadHubSpotIds } = require('./config');

const ids = loadHubSpotIds();

const TREATMENT_JOURNEY_PIPELINE_ID = String(ids.treatmentJourney.pipelineId);

const JOURNEY_STAGE = {
  inTreatment: ids.treatmentJourney.stages.inTreatment,
  atRisk: ids.treatmentJourney.stages.atRisk,
  treatmentCompleted: ids.treatmentJourney.stages.treatmentCompleted,
  discontinued: ids.treatmentJourney.stages.discontinued,
};

const JOURNEY_CLOSED_STAGES = new Set([
  JOURNEY_STAGE.treatmentCompleted,
  JOURNEY_STAGE.discontinued,
]);

module.exports = {
  TREATMENT_JOURNEY_PIPELINE_ID,
  JOURNEY_STAGE,
  JOURNEY_CLOSED_STAGES,
};
