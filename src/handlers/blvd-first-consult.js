/**
 * C2 — BLVD-first consult: ensure HS Contact + Acquisition Deal + Meeting Type signal.
 * Does not create HubSpot Meetings (Feature 4.2).
 */
const hs = require('../hubspot/client');
const log = require('../logger');
const { upsertContactFromBlvdClient } = require('./clients');
const { ensureAcquisitionDeal } = require('../acquisition-deals');
const { LIFECYCLE, STAGE } = require('../acquisition-stages');

const CONSULT_ROLES = new Set([
  'virtual_consult_en',
  'virtual_consult_es',
  'in_office_consult',
]);

/** Meeting Type labels for Feature 4.2 (signal only — no Meeting create). */
const MEETING_TYPE_BY_ROLE = {
  virtual_consult_en: 'Virtual Consultation English',
  virtual_consult_es: 'Virtual Consultation Spanish',
  in_office_consult: 'In Person Consultation',
};

/** Lifecycles that must not be overwritten by C2 Consultation Booked. */
const DO_NOT_DOWNGRADE = new Set([
  LIFECYCLE.consultationAttended,
  LIFECYCLE.activeCustomer,
  '1409162300', // Completed Customer
  '1409276676', // Churned
]);

function isConsultRole(role) {
  return CONSULT_ROLES.has(role);
}

function meetingTypeSignal(role) {
  if (!MEETING_TYPE_BY_ROLE[role]) return null;
  return {
    role,
    meetingType: MEETING_TYPE_BY_ROLE[role],
    note: '4.2 creates/links HubSpot Meeting; 4.1 emits signal only',
  };
}

/**
 * Prefer fuller Admin client when appointment.client is thin.
 */
async function resolveBlvdClient(config, appointment) {
  const blvd = require('../blvd/api');
  const id = appointment.clientId || appointment.client?.id;
  if (!id) return null;
  try {
    const full = await blvd.getClient(config, id);
    if (full) return full;
  } catch (err) {
    log.warn('C2 getClient failed; using appointment.client', {
      clientId: id,
      error: err.message,
    });
  }
  return {
    id,
    email: appointment.client?.email || null,
    firstName: appointment.client?.firstName || null,
    lastName: appointment.client?.lastName || null,
    mobilePhone: appointment.client?.mobilePhone || null,
    dob: appointment.client?.dob || null,
  };
}

async function ensureConsultationBookedLifecycle(config, contactId, dryRun) {
  if (!contactId) return { action: 'skipped', reason: 'no_contact' };
  const contact = await hs.getContact(config.hubspotToken, contactId, [
    'lifecyclestage',
  ]);
  const current = contact.properties?.lifecyclestage || null;
  if (current === LIFECYCLE.consultationBooked) {
    return { action: 'already', value: current };
  }
  if (DO_NOT_DOWNGRADE.has(current)) {
    return { action: 'skipped_protected', value: current };
  }
  if (dryRun) {
    return {
      action: 'would_set',
      from: current,
      to: LIFECYCLE.consultationBooked,
    };
  }
  await hs.updateContact(config.hubspotToken, contactId, {
    lifecyclestage: LIFECYCLE.consultationBooked,
  });
  return {
    action: 'set',
    from: current,
    to: LIFECYCLE.consultationBooked,
  };
}

/**
 * Ensure Contact + Deal at Consultation Booked for BLVD-origin consult bookings.
 * In-person matrix still owns later stage moves; virtual deal create happens here
 * because Boulevard matrix does not drive virtual outcomes.
 */
async function ensureBlvdFirstConsult(config, {
  appointment,
  classification,
  dryRun = false,
} = {}) {
  const role = classification?.primary?.role;
  if (!isConsultRole(role)) {
    return { apply: false, reason: 'not_consult_role', role: role || null };
  }

  const client = await resolveBlvdClient(config, appointment);
  if (!client?.id) {
    return { apply: false, reason: 'missing_blvd_client', role };
  }

  const contactUpsert = await upsertContactFromBlvdClient(config, client, {
    dryRun,
  });
  const contactId = contactUpsert.contactId;
  const signal = meetingTypeSignal(role);

  let lifecycle = null;
  let deal = null;

  if (contactId || dryRun) {
    lifecycle = await ensureConsultationBookedLifecycle(
      config,
      contactId,
      dryRun
    );

    // Virtual: always ensure Acquisition Deal (matrix won't).
    // In-person: ensure Deal exists so BOOKED matrix has something to move;
    // matrix still applies stage updates after.
    try {
      if (dryRun && !contactId) {
        deal = {
          action: 'would_ensure',
          dealStage: STAGE.consultationBooked,
        };
      } else if (contactId) {
        deal = await ensureAcquisitionDeal(config, contactId, {
          dealStage: STAGE.consultationBooked,
          dealName: `Acquisition — ${classification.primary.consultationType || 'Consult'}`,
          consultationType: classification.primary.consultationType || undefined,
        });
        const existingStage = deal.deal?.properties?.dealstage;
        const needsBooked =
          role.startsWith('virtual_consult') &&
          existingStage === STAGE.newOpportunity;
        if (needsBooked) {
          if (dryRun) {
            deal = {
              ...deal,
              stageUpdate: {
                action: 'would_set',
                from: existingStage,
                to: STAGE.consultationBooked,
              },
            };
          } else {
            await hs.updateObject(config.hubspotToken, 'deals', deal.dealId, {
              dealstage: STAGE.consultationBooked,
            });
            deal = {
              ...deal,
              stageUpdate: {
                action: 'set',
                from: existingStage,
                to: STAGE.consultationBooked,
              },
            };
          }
        }
      }
    } catch (err) {
      log.warn('C2 ensureAcquisitionDeal failed', {
        contactId,
        role,
        error: err.message,
      });
      deal = { error: err.message };
    }
  }

  log.info('C2 BLVD-first consult ensure', {
    role,
    contactId,
    contactAction: contactUpsert.action,
    dealAction: deal?.action || null,
    meetingType: signal?.meetingType || null,
    dryRun,
  });

  return {
    apply: true,
    role,
    contactId: contactId || null,
    contact: contactUpsert,
    lifecycle,
    deal,
    meetingTypeSignal: signal,
  };
}

module.exports = {
  CONSULT_ROLES,
  MEETING_TYPE_BY_ROLE,
  isConsultRole,
  meetingTypeSignal,
  ensureBlvdFirstConsult,
};
