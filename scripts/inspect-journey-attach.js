#!/usr/bin/env node
/**
 * Dry-run / apply C4–C5 Treatment Journey attach for a BLVD appointment.
 *
 * Usage:
 *   node scripts/inspect-journey-attach.js --id=<blvdAppointmentId>
 *   node scripts/inspect-journey-attach.js --id=<id> --apply
 */
const { getConfig } = require('../src/config');
const blvd = require('../src/blvd/api');
const hs = require('../src/hubspot/client');
const { classifyAppointmentServices } = require('../src/classify-service');
const {
  shouldAttachToTreatmentJourney,
  applyTreatmentJourneyAttach,
} = require('../src/handlers/journey-attach');

async function main() {
  const config = getConfig();
  const idArg = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  const apply = process.argv.includes('--apply');
  if (!idArg) {
    console.error('Usage: node scripts/inspect-journey-attach.js --id=<AppointmentURN> [--apply]');
    process.exit(1);
  }

  const appointment = await blvd.getAppointment(config, idArg);
  if (!appointment) {
    console.error('appointment not found');
    process.exit(1);
  }

  const classification = classifyAppointmentServices(
    config,
    appointment.appointmentServices || []
  );
  console.log('appointment', appointment.id);
  console.log('primary', classification.primary);
  console.log(
    'shouldAttach',
    shouldAttachToTreatmentJourney(classification)
  );

  let contactId = null;
  const blvdClientId = appointment.clientId || appointment.client?.id;
  if (blvdClientId) {
    const contacts = await hs.searchContacts(
      config.hubspotToken,
      [
        {
          filters: [
            {
              propertyName: config.blvdClientIdProperty,
              operator: 'EQ',
              value: blvdClientId,
            },
          ],
        },
      ],
      [config.blvdClientIdProperty],
      1
    );
    contactId = contacts.results?.[0]?.id || null;
  }

  let appointmentHsId = null;
  let appointmentObjectTypeId = null;
  if (apply) {
    const apptMeta = await hs.resolveObjectTypeId(
      config.hubspotToken,
      config.appointmentObject
    );
    appointmentObjectTypeId = apptMeta.objectTypeId;
    const existing = await hs.searchByProperty(
      config.hubspotToken,
      apptMeta.objectTypeId,
      config.appointmentIdProperty || 'blvd_appointment_id',
      appointment.id,
      [config.appointmentIdProperty || 'blvd_appointment_id']
    );
    appointmentHsId = existing.results?.[0]?.id || null;
  }

  const result = await applyTreatmentJourneyAttach(config, {
    classification,
    contactId,
    firstName: appointment.client?.firstName || 'Contact',
    appointmentHsId,
    appointmentObjectTypeId,
    dryRun: !apply,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
