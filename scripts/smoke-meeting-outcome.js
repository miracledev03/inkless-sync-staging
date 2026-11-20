#!/usr/bin/env node
/**
 * Feature 4.2.1 Phase D smoke — Meeting Outcome → BLVD → 4.1 deal move.
 *
 * Usage:
 *   node scripts/smoke-meeting-outcome.js
 *   node scripts/smoke-meeting-outcome.js --appointment=urn:blvd:Appointment:... --outcome=Completed
 *   node scripts/smoke-meeting-outcome.js --appointment=... --outcome=Completed --apply
 *   node scripts/smoke-meeting-outcome.js --appointment=... --contact=... --outcome=Completed --apply --simulate-deal
 */
const { getConfig, loadServiceMap } = require('../src/config');
const { processMeetingOutcome } = require('../src/handlers/meeting-sync');
const { resolveVirtualConsultMatrix } = require('../src/matrix/virtual-consult');
const { classifyAppointmentServices } = require('../src/classify-service');
const { isNoShowReason } = require('../src/matrix/shared');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

function assertMatrixLocal() {
  const classification = {
    primary: {
      role: 'virtual_consult_en',
      outcomeDriver: 'boulevard',
      consultationType: 'Virtual - English',
    },
  };
  const finalM = resolveVirtualConsultMatrix(
    { state: 'FINAL', cancelled: false },
    'APPOINTMENT_COMPLETED',
    classification
  );
  const noShowM = resolveVirtualConsultMatrix(
    {
      state: 'CANCELLED',
      cancelled: true,
      cancellation: {
        reason: 'NO_SHOW',
        notes: 'Client did not show up',
      },
    },
    'APPOINTMENT_CANCELLED',
    classification
  );
  if (!finalM.apply || finalM.outcome !== 'Completed') {
    throw new Error('virtual matrix Final → Completed failed');
  }
  if (!noShowM.apply || noShowM.outcome !== 'No-Show' || !noShowM.incrementNoShow) {
    throw new Error('virtual matrix No-Show failed');
  }
  if (
    !isNoShowReason({
      cancellation: { reason: 'CLIENT_CANCEL', notes: 'Client did not show up' },
    })
  ) {
    throw new Error('isNoShowReason notes check failed');
  }
  console.log('virtual matrix OK', {
    finalDealStage: finalM.dealStage,
    noShowDealStage: noShowM.dealStage,
  });
}

async function main() {
  assertMatrixLocal();
  const config = getConfig();
  const { map } = loadServiceMap(config);
  const classified = classifyAppointmentServices(config, [
    {
      id: 'svc1',
      serviceId: map?.virtual_consult_en,
      service: { name: 'Virtual EN' },
    },
  ]);
  console.log('classify virtual driver:', classified.primary?.outcomeDriver);

  const appointmentId = arg('appointment') || arg('appointmentId');
  const contactId = arg('contact') || arg('contactId');
  const outcome = arg('outcome') || 'Completed';
  if (!appointmentId && !contactId) {
    console.log(
      '\nMatrix OK. Pass --appointment=… [--contact=…] --outcome=Completed|No show|Canceled [--apply] [--simulate-deal]'
    );
    return;
  }

  const result = await processMeetingOutcome(config, {
    appointmentId: appointmentId || undefined,
    contactId: contactId || undefined,
    outcome,
    dryRun: !arg('apply'),
    simulateDeal: Boolean(arg('simulate-deal')),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.code || 'ERROR', err.message || err);
  process.exit(1);
});
