/** HubSpot sandbox Acquisition pipeline + stage ids (portal 51888138). */
const ACQUISITION_PIPELINE_ID = '922793905';

const STAGE = {
  newOpportunity: '1409277698',
  consultationBooked: '1409277699',
  consultationAttended: '1409277700',
  consultationNoShowCancelled: '1409277701',
  firstSessionBooked: '1409277702',
  firstSessionNoShowCancelled: '1409277703',
  closedWon: '1409285445',
  closedLost: '1409277704',
};

const LIFECYCLE = {
  consultationBooked: '1409274217',
  consultationAttended: '1409285289',
  qualifiedEngaged: '1409285288',
  activeCustomer: 'customer',
  /** Set via HUBSPOT_CONSULTATION_NOSHOW_LIFECYCLE_VALUE when stage exists in portal */
  consultationNoShowCancel: '',
};

const CLOSED_STAGES = new Set([STAGE.closedWon, STAGE.closedLost]);

module.exports = {
  ACQUISITION_PIPELINE_ID,
  STAGE,
  LIFECYCLE,
  CLOSED_STAGES,
};
