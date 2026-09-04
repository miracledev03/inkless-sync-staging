/** HubSpot sandbox Treatment Journey pipeline + stage ids (portal 51888138). */
const TREATMENT_JOURNEY_PIPELINE_ID = '922783339';

const JOURNEY_STAGE = {
  inTreatment: '1409163315',
  atRisk: '1409163316',
  treatmentCompleted: '1409163318',
  discontinued: '1409163319',
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
