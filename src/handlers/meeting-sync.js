/**
 * Feature 4.2.1 — HubSpot Meeting → Boulevard (virtual EN/ES).
 *
 * Phase B: booked path (same-slot, Clinic Location, staff map, existing deal).
 * Phases C/D: reschedule / cancel / outcome → BLVD.
 */
const hs = require('../hubspot/client');
const log = require('../logger');
const {
  loadMeetingTypes,
  resolveServiceKeyFromMeeting,
  resolveOutcomeMapping,
} = require('../meeting-types');
const blvd = require('../blvd/api');
const { bookConsult } = require('./book-consult');
const {
  ensureAcquisitionDeal,
  listContactDeals,
  pickOpenAcquisitionDeal,
} = require('../acquisition-deals');
const { STAGE } = require('../acquisition-stages');
const { syncOpenAcquisitionDealProperties } = require('../deal-properties');
const { ORIGIN } = require('../origin');
const {
  matchBookableTime,
  toLocationLocalNaive,
  localDateFromStart,
} = require('../time');
const { processAppointmentWebhook } = require('./appointments');

function pickContactId(body = {}) {
  return (
    body.contactId ||
    body.objectId ||
    body.hs_object_id ||
    body.vid ||
    body?.properties?.hs_object_id ||
    body?.object?.objectId ||
    null
  );
}

function pickMeetingId(body = {}) {
  return (
    body.meetingId ||
    body.hs_meeting_id ||
    body.engagementId ||
    // App Meeting subscription payloads use objectId for the Meeting.
    (body.subscriptionType &&
    String(body.subscriptionType).toLowerCase().includes('meeting')
      ? body.objectId
      : null) ||
    null
  );
}

function pickStartTime(body = {}) {
  return (
    body.startTime ||
    body.startAt ||
    body.hs_meeting_start_time ||
    body.meetingStartTime ||
    null
  );
}

/** HubSpot deal `consultation_type` enumeration values. */
function consultationTypeForService(serviceKey) {
  if (serviceKey === 'virtual_consult_es') return 'Virtual - Spanish';
  if (serviceKey === 'in_office_consult') return 'In-Person';
  return 'Virtual - English';
}

/**
 * Load Meeting properties when the workflow only sends meetingId.
 */
async function hydrateMeetingFromHubSpot(config, meetingId) {
  if (!meetingId) return null;
  const props = [
    'hs_meeting_title',
    'hs_activity_type',
    'hs_meeting_start_time',
    'hs_meeting_end_time',
    'hs_meeting_outcome',
    'hs_timestamp',
    'hubspot_owner_id',
    config.hsMeetingBlvdApptProperty || 'blvd_appointment_id',
  ];
  try {
    return await hs.hsRequest(
      config.hubspotToken,
      'GET',
      `/crm/v3/objects/meetings/${encodeURIComponent(String(meetingId))}?properties=${encodeURIComponent(
        props.join(',')
      )}`
    );
  } catch (err) {
    log.warn('4.2.1 meeting hydrate failed', {
      meetingId: String(meetingId),
      error: err.message,
    });
    return null;
  }
}

async function resolveContactIdForMeeting(config, meetingId, fallback) {
  if (fallback) return String(fallback);
  if (!meetingId) return null;
  try {
    const assoc = await hs.hsRequest(
      config.hubspotToken,
      'GET',
      `/crm/v4/objects/meetings/${encodeURIComponent(String(meetingId))}/associations/contacts`
    );
    const id = assoc?.results?.[0]?.toObjectId;
    return id ? String(id) : null;
  } catch (err) {
    log.warn('4.2.1 meeting→contact assoc failed', {
      meetingId: String(meetingId),
      error: err.message,
    });
    return null;
  }
}

async function stampMeetingAppointment(config, meetingId, appointmentId) {
  const prop = config.hsMeetingBlvdApptProperty || 'blvd_appointment_id';
  try {
    await hs.updateObject(config.hubspotToken, 'meetings', String(meetingId), {
      [prop]: appointmentId,
    });
    return { action: 'stamped', meetingId: String(meetingId), property: prop };
  } catch (err) {
    log.warn('4.2.1 meeting blvd_appointment_id stamp failed', {
      meetingId: String(meetingId),
      error: err.message,
    });
    return { action: 'stamp_failed', error: err.message };
  }
}

async function attachDealToAppointmentHs(
  config,
  { dealId, appointmentHsId, appointmentObjectTypeId }
) {
  if (!dealId || !appointmentHsId) {
    return { skipped: true, reason: 'missing_deal_or_appointment' };
  }
  try {
    const toType = appointmentObjectTypeId || config.appointmentObject;
    await hs.associateDefault(
      config.hubspotToken,
      'deals',
      String(dealId),
      toType,
      String(appointmentHsId)
    );
    return { action: 'associated', dealId: String(dealId), appointmentHsId: String(appointmentHsId) };
  } catch (err) {
    log.warn('4.2.1 deal↔appointment associate failed', {
      dealId,
      appointmentHsId,
      error: err.message,
    });
    return { action: 'associate_failed', error: err.message };
  }
}

/**
 * Prefer an existing open Acquisition deal; only create when none exists.
 * Returns { action, dealId, created }.
 */
async function attachExistingAcquisitionDeal(config, contactId, opts = {}) {
  const mutate = opts.mutate !== false;
  const deals = await listContactDeals(
    config.hubspotToken,
    contactId,
    config.languageProperty || 'language'
  );
  const existing = pickOpenAcquisitionDeal(deals);
  if (existing) {
    if (mutate && opts.consultationType) {
      try {
        await syncOpenAcquisitionDealProperties(config, {
          contactId,
          consultationType: opts.consultationType,
        });
      } catch (err) {
        log.warn('4.2.1 consultation_type sync failed', {
          dealId: existing.id,
          error: err.message,
        });
      }
    }
    // Advance to Consultation Booked when still earlier (best-effort).
    const stage = existing.properties?.dealstage;
    if (
      mutate &&
      opts.dealStage &&
      stage &&
      stage !== opts.dealStage &&
      stage !== STAGE.consultationAttended &&
      stage !== STAGE.firstSessionBooked &&
      stage !== STAGE.closedWon &&
      stage !== STAGE.closedLost
    ) {
      try {
        await hs.updateObject(config.hubspotToken, 'deals', existing.id, {
          dealstage: opts.dealStage,
        });
      } catch (err) {
        log.warn('4.2.1 deal stage bump failed', {
          dealId: existing.id,
          error: err.message,
          from: stage,
          to: opts.dealStage,
        });
      }
    }
    return {
      action: 'existing',
      dealId: existing.id,
      created: false,
      mutated: mutate,
      deal: existing,
    };
  }

  if (opts.createIfMissing === false || !mutate) {
    return { action: 'missing', dealId: null, created: false };
  }

  return ensureAcquisitionDeal(config, contactId, {
    dealStage: opts.dealStage || STAGE.consultationBooked,
    dealName: opts.dealName || 'Acquisition — Consult',
    consultationType: opts.consultationType,
  });
}

/**
 * Meeting booked (client or rep) → Boulevard cart book + existing Acquisition deal.
 */
async function processMeetingBooked(config, body = {}) {
  const meetingId = pickMeetingId(body);
  const meeting = meetingId
    ? await hydrateMeetingFromHubSpot(config, meetingId)
    : null;
  const meetingProps = meeting?.properties || {};

  const contactId = await resolveContactIdForMeeting(
    config,
    meetingId,
    pickContactId(body)
  );
  if (!contactId) {
    const err = new Error('contactId required (or Meeting→Contact association)');
    err.code = 'MISSING_CONTACT';
    throw err;
  }

  const { path: mapPath, map } = loadMeetingTypes(config);
  if (!map) {
    const err = new Error(`meeting types map not found at ${mapPath}`);
    err.code = 'MEETING_TYPES_MISSING';
    throw err;
  }

  // Idempotent: Meeting already linked to a BLVD appointment.
  const existingAppt =
    body.appointmentId ||
    body.blvdAppointmentId ||
    meetingProps[config.hsMeetingBlvdApptProperty || 'blvd_appointment_id'] ||
    null;
  if (existingAppt && body.force !== true && body.dryRun !== true) {
    const deal = await attachExistingAcquisitionDeal(config, String(contactId), {
      dealStage: STAGE.consultationBooked,
      consultationType: undefined,
      createIfMissing: false,
    });
    return {
      action: 'already_booked',
      feature: '4.2.1',
      contactId: String(contactId),
      meetingId: meetingId ? String(meetingId) : null,
      appointmentId: String(existingAppt),
      deal,
      hint: 'Pass force=true to rebook',
    };
  }

  const enrichBody = {
    ...body,
    meetingTypeName:
      body.meetingTypeName ||
      body.hs_activity_type ||
      meetingProps.hs_activity_type ||
      body.hs_meeting_title ||
      meetingProps.hs_meeting_title,
    hs_activity_type:
      body.hs_activity_type || meetingProps.hs_activity_type || undefined,
    meetingTypeId: body.meetingTypeId || body.hs_meeting_type_id,
    startTime:
      pickStartTime(body) ||
      meetingProps.hs_meeting_start_time ||
      meetingProps.hs_timestamp,
    ownerId: body.ownerId || body.hsOwnerId || meetingProps.hubspot_owner_id,
    ownerEmail: body.ownerEmail || body.hsOwnerEmail,
    ownerName: body.ownerName || body.hsOwnerName,
  };

  const serviceKey =
    body.serviceKey || resolveServiceKeyFromMeeting(map, enrichBody);
  if (!serviceKey) {
    const err = new Error(
      'Could not resolve Meeting Type → serviceKey (Virtual EN / Virtual ES). Set meetingTypeId in meeting-types config or pass serviceKey.'
    );
    err.code = 'MEETING_TYPE_UNMAPPED';
    throw err;
  }

  const consultationType = consultationTypeForService(serviceKey);

  const bookBody = {
    contactId: String(contactId),
    serviceKey,
    locationId: body.locationId || undefined,
    startTime: enrichBody.startTime || undefined,
    bookableTimeId: body.bookableTimeId || undefined,
    itemStaffVariantId: body.itemStaffVariantId || undefined,
    staffId: body.staffId || body.blvdStaffId,
    ownerEmail: enrichBody.ownerEmail,
    ownerId: enrichBody.ownerId,
    ownerName: enrichBody.ownerName,
    staffMap: map.staff || [],
    dryRun: body.dryRun === true,
    availabilityOnly: body.availabilityOnly === true,
    clientMessage:
      body.clientMessage ||
      `Booked via HubSpot Meeting${meetingId ? ` ${meetingId}` : ''} (Inkless 4.2.1)`,
  };

  const booked = await bookConsult(config, bookBody);

  let deal = null;
  if (
    booked.action === 'booked' ||
    booked.action === 'availability' ||
    booked.action === 'would_book'
  ) {
    try {
      deal = await attachExistingAcquisitionDeal(config, String(contactId), {
        dealStage: STAGE.consultationBooked,
        dealName: 'Acquisition — Consult',
        consultationType,
        // Only mutate/create on a real checkout.
        mutate: booked.action === 'booked',
        createIfMissing: booked.action === 'booked',
      });
    } catch (err) {
      log.warn('4.2.1 attachExistingAcquisitionDeal failed', {
        contactId: String(contactId),
        error: err.message,
      });
      deal = { error: err.message };
    }
  }

  let dealAttach = null;
  const appointmentHsId =
    booked.hubspot?.appointment?.hsId ||
    booked.hubspot?.hsId ||
    null;
  const appointmentObjectTypeId =
    booked.hubspot?.appointment?.objectTypeId ||
    booked.hubspot?.objectTypeId ||
    null;
  // Matrix usually associates already; this is a belt-and-suspenders attach.
  if (
    booked.action === 'booked' &&
    deal?.dealId &&
    appointmentHsId &&
    !booked.hubspot?.matrix?.associations?.dealToAppointment?.ok
  ) {
    dealAttach = await attachDealToAppointmentHs(config, {
      dealId: deal.dealId,
      appointmentHsId,
      appointmentObjectTypeId,
    });
  } else if (booked.hubspot?.matrix?.associations?.dealToAppointment?.ok) {
    dealAttach = {
      action: 'associated_via_matrix',
      dealId: deal?.dealId || null,
      appointmentHsId,
    };
  }

  let meetingStamp = null;
  if (
    meetingId &&
    booked.appointmentId &&
    body.dryRun !== true &&
    body.availabilityOnly !== true
  ) {
    meetingStamp = await stampMeetingAppointment(
      config,
      meetingId,
      booked.appointmentId
    );
  }

  log.info('4.2.1 meeting booked processed', {
    contactId: String(contactId),
    meetingId: meetingId ? String(meetingId) : null,
    serviceKey,
    action: booked.action,
    appointmentId: booked.appointmentId || null,
    dealId: deal?.dealId || null,
    locationSource: booked.locationSource || null,
    staffSource: booked.staffSource || null,
    localStart: booked.localStart || null,
  });

  return {
    action: booked.action,
    feature: '4.2.1',
    contactId: String(contactId),
    meetingId: meetingId ? String(meetingId) : null,
    serviceKey,
    consultationType,
    deal,
    dealAttach,
    meetingStamp,
    book: booked,
  };
}

/**
 * Resolve BLVD appointment id from body, Meeting stamp, or contact's HS appointment.
 */
async function resolveLinkedAppointmentId(config, body = {}) {
  const direct =
    body.appointmentId ||
    body.blvdAppointmentId ||
    body?.[config.hsMeetingBlvdApptProperty] ||
    null;
  if (direct) return String(direct);

  const meetingId = pickMeetingId(body);
  if (meetingId) {
    const meeting = await hydrateMeetingFromHubSpot(config, meetingId);
    const stamped =
      meeting?.properties?.[
        config.hsMeetingBlvdApptProperty || 'blvd_appointment_id'
      ] || null;
    if (stamped) return String(stamped);
  }

  const contactId = pickContactId(body);
  if (!contactId) return null;
  try {
    const apptMeta = await hs.resolveObjectTypeId(
      config.hubspotToken,
      config.appointmentObject
    );
    const assoc = await hs.hsRequest(
      config.hubspotToken,
      'GET',
      `/crm/v4/objects/contacts/${encodeURIComponent(
        String(contactId)
      )}/associations/${encodeURIComponent(apptMeta.objectTypeId)}`
    );
    const hsApptId = assoc?.results?.[0]?.toObjectId;
    if (!hsApptId) return null;
    const idProp = config.appointmentIdProperty || 'blvd_appointment_id';
    const record = await hs.hsRequest(
      config.hubspotToken,
      'GET',
      `/crm/v3/objects/${encodeURIComponent(
        apptMeta.objectTypeId
      )}/${encodeURIComponent(String(hsApptId))}?properties=${encodeURIComponent(
        idProp
      )}`
    );
    const blvdId = record?.properties?.[idProp];
    return blvdId ? String(blvdId) : null;
  } catch (err) {
    log.warn('4.2.1 resolve appointment via contact assoc failed', {
      contactId: String(contactId),
      error: err.message,
    });
    return null;
  }
}

function ymdAddDays(ymdStr, days) {
  const [y, m, d] = String(ymdStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Meeting reschedule → Boulevard appointmentReschedule (same consultant/service).
 */
async function processMeetingRescheduled(config, body = {}) {
  const meetingId = pickMeetingId(body);
  const contactId =
    (await resolveContactIdForMeeting(config, meetingId, pickContactId(body))) ||
    null;
  const appointmentId = await resolveLinkedAppointmentId(config, body);
  if (!appointmentId) {
    const err = new Error(
      'appointmentId required (pass blvd appointment id or stamp Meeting blvd_appointment_id first)'
    );
    err.code = 'MISSING_APPOINTMENT';
    throw err;
  }

  const startTime =
    pickStartTime(body) ||
    body.hs_meeting_start_time ||
    null;
  if (!startTime && !body.bookableTimeId) {
    const err = new Error('startTime or bookableTimeId required to reschedule');
    err.code = 'MISSING_START';
    throw err;
  }

  const existing = await blvd.getAppointment(config, appointmentId);
  if (!existing) {
    const err = new Error(`Boulevard appointment not found: ${appointmentId}`);
    err.code = 'APPOINTMENT_NOT_FOUND';
    throw err;
  }
  if (existing.cancelled) {
    const err = new Error('Cannot reschedule a cancelled Boulevard appointment');
    err.code = 'APPOINTMENT_CANCELLED';
    throw err;
  }

  const tz =
    body.tz ||
    existing.location?.tz ||
    'America/Los_Angeles';
  const localStart = startTime
    ? toLocationLocalNaive(startTime, tz)
    : null;
  const searchDate =
    localDateFromStart(startTime, tz) ||
    (localStart ? localStart.slice(0, 10) : null);

  let bookableTimeId = body.bookableTimeId || null;
  let matched = null;
  let availableTimes = [];

  if (!bookableTimeId) {
    if (!searchDate) {
      const err = new Error('Could not derive local date from startTime');
      err.code = 'MISSING_START';
      throw err;
    }
    try {
      await blvd.appointmentRescheduleAvailableDates(config, {
        appointmentId,
        searchRangeLower: ymdAddDays(searchDate, -1),
        searchRangeUpper: ymdAddDays(searchDate, 14),
        tz,
      });
    } catch (err) {
      log.warn('4.2.1 reschedule availableDates probe failed', {
        appointmentId,
        error: err.message,
      });
    }

    availableTimes = await blvd.appointmentRescheduleAvailableTimes(config, {
      appointmentId,
      date: searchDate,
      tz,
    });
    const normalized = availableTimes.map((t) => ({
      id: t.bookableTimeId,
      startTime: t.startTime,
    }));
    matched = matchBookableTime(normalized, startTime, tz);
    if (!matched?.id) {
      const err = new Error(
        `No matching reschedule slot for ${startTime} (local ${localStart || 'n/a'}) on ${searchDate}`
      );
      err.code = 'NO_MATCHING_TIME';
      err.times = availableTimes;
      err.localStart = localStart;
      throw err;
    }
    bookableTimeId = matched.id;
  }

  if (body.dryRun === true) {
    return {
      action: 'would_reschedule',
      feature: '4.2.1',
      phase: 'C',
      contactId,
      meetingId: meetingId ? String(meetingId) : null,
      appointmentId,
      bookableTimeId,
      startTime: matched?.startTime || startTime,
      localStart,
      tz,
      previousStartAt: existing.startAt,
      sampleTimes: availableTimes.slice(0, 8),
    };
  }

  const updated = await blvd.appointmentReschedule(config, {
    appointmentId,
    bookableTimeId,
    sendNotification: body.sendNotification === true,
  });

  let hubspot = null;
  try {
    hubspot = await processAppointmentWebhook(config, {
      eventType: 'APPOINTMENT_UPDATED',
      payload: { resourceId: appointmentId },
      forceOrigin: ORIGIN.HUBSPOT,
    });
  } catch (err) {
    log.warn('4.2.1 reschedule HS sync deferred', {
      appointmentId,
      error: err.message,
    });
    hubspot = { error: err.message };
  }

  log.info('4.2.1 meeting rescheduled', {
    contactId,
    meetingId: meetingId ? String(meetingId) : null,
    appointmentId,
    from: existing.startAt,
    to: updated?.startAt,
  });

  return {
    action: 'rescheduled',
    feature: '4.2.1',
    phase: 'C',
    contactId,
    meetingId: meetingId ? String(meetingId) : null,
    appointmentId,
    bookableTimeId,
    previousStartAt: existing.startAt,
    startAt: updated?.startAt || null,
    localStart,
    tz,
    appointment: updated,
    hubspot,
  };
}

/**
 * Meeting canceled → Boulevard cancelAppointment.
 */
async function processMeetingCanceled(config, body = {}) {
  const meetingId = pickMeetingId(body);
  const contactId =
    (await resolveContactIdForMeeting(config, meetingId, pickContactId(body))) ||
    null;
  const appointmentId = await resolveLinkedAppointmentId(config, body);
  if (!appointmentId) {
    const err = new Error(
      'appointmentId required (pass blvd appointment id or stamp Meeting blvd_appointment_id first)'
    );
    err.code = 'MISSING_APPOINTMENT';
    throw err;
  }

  const existing = await blvd.getAppointment(config, appointmentId);
  if (!existing) {
    const err = new Error(`Boulevard appointment not found: ${appointmentId}`);
    err.code = 'APPOINTMENT_NOT_FOUND';
    throw err;
  }

  if (existing.cancelled) {
    return {
      action: 'already_cancelled',
      feature: '4.2.1',
      phase: 'C',
      contactId,
      meetingId: meetingId ? String(meetingId) : null,
      appointmentId,
      appointment: existing,
    };
  }

  const reason = body.cancelReason || body.reason || 'CLIENT_CANCEL';
  const notes =
    body.notes ||
    `Cancelled via HubSpot Meeting${meetingId ? ` ${meetingId}` : ''} (Inkless 4.2.1)`;

  if (body.dryRun === true) {
    return {
      action: 'would_cancel',
      feature: '4.2.1',
      phase: 'C',
      contactId,
      meetingId: meetingId ? String(meetingId) : null,
      appointmentId,
      reason,
      notes,
      startAt: existing.startAt,
    };
  }

  const cancelled = await blvd.cancelAppointment(config, {
    id: appointmentId,
    reason,
    notes,
    notifyClient: body.notifyClient === true,
  });

  let hubspot = null;
  try {
    hubspot = await processAppointmentWebhook(config, {
      eventType: 'APPOINTMENT_CANCELLED',
      payload: { resourceId: appointmentId },
      forceOrigin: ORIGIN.HUBSPOT,
    });
  } catch (err) {
    log.warn('4.2.1 cancel HS sync deferred', {
      appointmentId,
      error: err.message,
    });
    hubspot = { error: err.message };
  }

  log.info('4.2.1 meeting canceled', {
    contactId,
    meetingId: meetingId ? String(meetingId) : null,
    appointmentId,
    reason,
  });

  return {
    action: 'cancelled',
    feature: '4.2.1',
    phase: 'C',
    contactId,
    meetingId: meetingId ? String(meetingId) : null,
    appointmentId,
    reason,
    appointment: cancelled,
    hubspot,
  };
}

/**
 * AskElephant / Meeting Outcome → Boulevard Final or Cancelled, then 4.1 sync.
 *
 * Completed  → finalizeAppointment (bookingCreateFromAppointment + bookingComplete)
 * No show    → cancelAppointment reason NO_SHOW + notes "Client did not show up"
 * Canceled   → cancelAppointment reason CLIENT_CANCEL
 */
async function processMeetingOutcome(config, body = {}) {
  const { path: mapPath, map } = loadMeetingTypes(config);
  if (!map) {
    const err = new Error(`meeting types map not found at ${mapPath}`);
    err.code = 'MEETING_TYPES_MISSING';
    throw err;
  }

  const meetingId = pickMeetingId(body);
  const meeting = meetingId
    ? await hydrateMeetingFromHubSpot(config, meetingId)
    : null;
  const meetingProps = meeting?.properties || {};

  const raw =
    body.outcome ||
    body.hs_meeting_outcome ||
    body.meetingOutcome ||
    body.value ||
    meetingProps.hs_meeting_outcome ||
    '';
  const mapped = resolveOutcomeMapping(map, raw);
  if (!mapped) {
    const err = new Error(
      `Unmapped meeting outcome: ${raw || '(empty)'}. Expected Completed / No show / Canceled.`
    );
    err.code = 'OUTCOME_UNMAPPED';
    throw err;
  }

  const contactId = await resolveContactIdForMeeting(
    config,
    meetingId,
    pickContactId(body)
  );
  const appointmentId = await resolveLinkedAppointmentId(config, {
    ...body,
    contactId: contactId || body.contactId,
    meetingId,
  });
  if (!appointmentId) {
    const err = new Error(
      'appointmentId required (pass blvd id, Meeting stamp, or contact with BLVD appointment)'
    );
    err.code = 'MISSING_APPOINTMENT';
    throw err;
  }

  const existing = await blvd.getAppointment(config, appointmentId);
  if (!existing) {
    const err = new Error(`Boulevard appointment not found: ${appointmentId}`);
    err.code = 'APPOINTMENT_NOT_FOUND';
    throw err;
  }

  const planned =
    mapped.key === 'completed'
      ? {
          blvd: 'FINAL via bookingComplete',
          dealStage: 'consultationAttended',
        }
      : {
          blvd: 'CANCELLED',
          cancelReasonEnum:
            mapped.key === 'no_show' ? 'NO_SHOW' : 'CLIENT_CANCEL',
          cancelNotes:
            mapped.cancelReason ||
            (mapped.key === 'no_show'
              ? 'Client did not show up'
              : 'Cancelled via HubSpot Meeting Outcome'),
          dealStage: 'consultationNoShowCancelled',
          incrementNoShow: mapped.key === 'no_show',
        };

  if (body.dryRun === true) {
    return {
      action: 'would_apply_outcome',
      feature: '4.2.1',
      phase: 'D',
      contactId: contactId ? String(contactId) : null,
      meetingId: meetingId ? String(meetingId) : null,
      appointmentId,
      outcome: raw,
      mapped,
      currentState: existing.state,
      cancelled: existing.cancelled,
      planned,
    };
  }

  let blvdResult = null;
  let syncEventType = 'APPOINTMENT_UPDATED';
  let hubspot = null;
  let simulatedDeal = null;

  try {
    if (mapped.key === 'completed') {
      if (String(existing.state || '').toUpperCase() === 'FINAL') {
        blvdResult = { action: 'already_final', appointment: existing };
        syncEventType = 'APPOINTMENT_COMPLETED';
      } else {
        blvdResult = await blvd.finalizeAppointment(config, appointmentId, {
          appointment: existing,
          notifyClient: body.notifyClient === true,
          staffId: body.staffId || body.blvdStaffId,
        });
        syncEventType = 'APPOINTMENT_COMPLETED';
      }
    } else if (existing.cancelled) {
      blvdResult = { action: 'already_cancelled', appointment: existing };
      syncEventType = 'APPOINTMENT_CANCELLED';
    } else {
      const reasonEnum =
        mapped.key === 'no_show'
          ? body.cancelReason || 'NO_SHOW'
          : body.cancelReason || 'CLIENT_CANCEL';
      const notes =
        mapped.cancelReason ||
        body.notes ||
        (mapped.key === 'no_show'
          ? 'Client did not show up'
          : `Cancelled via HubSpot Meeting Outcome${
              meetingId ? ` ${meetingId}` : ''
            } (Inkless 4.2.1)`);
      const cancelled = await blvd.cancelAppointment(config, {
        id: appointmentId,
        reason: reasonEnum,
        notes,
        notifyClient: body.notifyClient === true,
      });
      blvdResult = {
        action: 'cancelled',
        reason: reasonEnum,
        notes,
        appointment: cancelled,
      };
      syncEventType = 'APPOINTMENT_CANCELLED';
    }

    // Free virtual consults: bookingComplete may leave state CONFIRMED (not FINAL).
    // If Completed outcome did not land Final, apply Acquisition matrix from the
    // Meeting Outcome so the deal still advances (Joey: Outcome → deal via 4.1 path).
    const postState = String(
      blvdResult?.appointment?.state || existing.state || ''
    ).toUpperCase();
    const needsCompletedDealFallback =
      mapped.key === 'completed' &&
      postState !== 'FINAL' &&
      postState !== 'COMPLETED';

    if (needsCompletedDealFallback) {
      log.warn(
        '4.2.1 Completed: BLVD not Final after finalize; applying deal from Meeting Outcome',
        { appointmentId, postState, blvdAction: blvdResult?.action }
      );
      simulatedDeal = await applySimulatedVirtualOutcomeDeal(config, {
        appointment: blvdResult?.appointment || existing,
        mapped,
        contactId,
        dryRun: false,
      });
      hubspot = {
        skippedWebhook: true,
        reason: 'blvd_not_final_after_booking_complete',
        postState,
      };
    } else {
      try {
        hubspot = await processAppointmentWebhook(config, {
          eventType: syncEventType,
          payload: { resourceId: appointmentId },
          forceOrigin: ORIGIN.HUBSPOT,
        });
      } catch (err) {
        log.warn('4.2.1 outcome HS sync deferred', {
          appointmentId,
          outcome: mapped.key,
          error: err.message,
        });
        hubspot = { error: err.message };
      }
    }
  } catch (err) {
    // Staging OAuth often lacks appointment:write. Optional simulateDeal applies
    // the virtual matrix as if BLVD already reflected the outcome.
    if (err.code === 'BLVD_SCOPE_MISSING' && body.simulateDeal === true) {
      log.warn('4.2.1 BLVD write blocked; simulating deal move from outcome', {
        appointmentId,
        outcome: mapped.key,
      });
      simulatedDeal = await applySimulatedVirtualOutcomeDeal(config, {
        appointment: existing,
        mapped,
        contactId,
        dryRun: false,
      });
      blvdResult = {
        action: 'blvd_scope_missing',
        error: err.message,
        simulated: true,
      };
    } else {
      throw err;
    }
  }

  log.info('4.2.1 meeting outcome applied', {
    contactId: contactId ? String(contactId) : null,
    meetingId: meetingId ? String(meetingId) : null,
    appointmentId,
    outcome: mapped.key,
    blvdAction: blvdResult?.action,
    dealId:
      hubspot?.matrix?.deal?.dealId || simulatedDeal?.deal?.dealId || null,
  });

  return {
    action: simulatedDeal
      ? blvdResult?.action === 'blvd_scope_missing'
        ? 'outcome_deal_simulated'
        : 'outcome_applied_deal_fallback'
      : 'outcome_applied',
    feature: '4.2.1',
    phase: 'D',
    contactId: contactId ? String(contactId) : null,
    meetingId: meetingId ? String(meetingId) : null,
    appointmentId,
    outcome: raw,
    mapped,
    planned,
    blvd: blvdResult,
    hubspot,
    simulatedDeal,
  };
}

/**
 * Apply Acquisition matrix as if Boulevard already has Final / Cancelled.
 * Used when OAuth lacks appointment:write (staging) or for deal-path unit smoke.
 */
async function applySimulatedVirtualOutcomeDeal(
  config,
  { appointment, mapped, contactId, dryRun }
) {
  const { classifyAppointmentServices } = require('../classify-service');
  const { applyAcquisitionMatrix } = require('./acquisition-matrix');

  let simulated;
  let eventType;
  if (mapped.key === 'completed') {
    simulated = { ...appointment, state: 'FINAL', cancelled: false };
    eventType = 'APPOINTMENT_COMPLETED';
  } else if (mapped.key === 'no_show') {
    simulated = {
      ...appointment,
      state: 'CANCELLED',
      cancelled: true,
      cancellation: {
        reason: 'NO_SHOW',
        notes: mapped.cancelReason || 'Client did not show up',
      },
    };
    eventType = 'APPOINTMENT_CANCELLED';
  } else {
    simulated = {
      ...appointment,
      state: 'CANCELLED',
      cancelled: true,
      cancellation: {
        reason: 'CLIENT_CANCEL',
        notes: 'Cancelled via HubSpot Meeting Outcome',
      },
    };
    eventType = 'APPOINTMENT_CANCELLED';
  }

  const classification = classifyAppointmentServices(
    config,
    appointment.appointmentServices || []
  );
  return applyAcquisitionMatrix(config, {
    appointment: simulated,
    eventType,
    classification,
    contactId: contactId ? String(contactId) : null,
    dryRun: dryRun === true,
  });
}

module.exports = {
  processMeetingBooked,
  processMeetingRescheduled,
  processMeetingCanceled,
  processMeetingOutcome,
  pickContactId,
  pickMeetingId,
  attachExistingAcquisitionDeal,
  hydrateMeetingFromHubSpot,
  resolveLinkedAppointmentId,
  consultationTypeForService,
  applySimulatedVirtualOutcomeDeal,
};
