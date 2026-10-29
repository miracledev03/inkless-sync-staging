/**
 * Backfill unique uid properties and collapse duplicate HubSpot rows that
 * share the same Boulevard id.
 *
 * Dry run (default):
 *   ENV_FILE=.env.production node scripts/backfill-blvd-uids.js
 * Apply:
 *   ENV_FILE=.env.production node scripts/backfill-blvd-uids.js --apply
 * Also refresh Andrew Adams deal amounts after cleanup:
 *   ... --apply --refresh-contact=258328948864
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');
const { refreshDealAmounts } = require('../src/deal-amounts');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function listAll(token, objectTypeId, properties) {
  const all = [];
  let after = undefined;
  const propsQs = encodeURIComponent(properties.join(','));
  for (let page = 0; page < 200; page += 1) {
    let path = `/crm/v3/objects/${objectTypeId}?limit=100&properties=${propsQs}`;
    if (after) path += `&after=${encodeURIComponent(after)}`;
    const res = await hs.hsRequest(token, 'GET', path);
    all.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (!after) break;
  }
  return all;
}

function pickKeeper(rows) {
  return [...rows].sort((a, b) => {
    const aOk = a.properties?.sync_status === 'ok' ? 1 : 0;
    const bOk = b.properties?.sync_status === 'ok' ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;
    const aCreated = Number(a.properties?.hs_createdate || 0);
    const bCreated = Number(b.properties?.hs_createdate || 0);
    if (aCreated !== bCreated) return bCreated - aCreated;
    return String(b.id).localeCompare(String(a.id));
  })[0];
}

async function collapseAndBackfill({
  token,
  objectTypeId,
  legacyProp,
  uidProp,
  label,
  apply,
}) {
  const rows = await listAll(token, objectTypeId, [
    legacyProp,
    uidProp,
    'sync_status',
    'hs_createdate',
  ]);
  const byLegacy = new Map();
  for (const row of rows) {
    const key = row.properties?.[legacyProp];
    if (!key) continue;
    if (!byLegacy.has(key)) byLegacy.set(key, []);
    byLegacy.get(key).push(row);
  }

  const summary = {
    label,
    scanned: rows.length,
    boulevardIds: byLegacy.size,
    duplicatesGroups: 0,
    wouldDelete: [],
    wouldSetUid: [],
    deleted: [],
    setUid: [],
    errors: [],
  };

  for (const [blvdId, group] of byLegacy.entries()) {
    const keeper = pickKeeper(group);
    const extras = group.filter((r) => r.id !== keeper.id);
    if (extras.length) {
      summary.duplicatesGroups += 1;
      for (const extra of extras) {
        summary.wouldDelete.push({
          hsId: extra.id,
          blvdId,
          keep: keeper.id,
        });
        if (apply) {
          try {
            await hs.deleteObject(token, objectTypeId, extra.id);
            summary.deleted.push(extra.id);
          } catch (err) {
            summary.errors.push({
              action: 'delete',
              hsId: extra.id,
              error: err.message,
              body: err.body,
            });
          }
        }
      }
    }

    const currentUid = keeper.properties?.[uidProp];
    if (currentUid !== blvdId) {
      summary.wouldSetUid.push({ hsId: keeper.id, blvdId });
      if (apply) {
        try {
          await hs.updateObject(token, objectTypeId, keeper.id, {
            [uidProp]: blvdId,
          });
          summary.setUid.push(keeper.id);
        } catch (err) {
          summary.errors.push({
            action: 'set_uid',
            hsId: keeper.id,
            blvdId,
            error: err.message,
            body: err.body,
          });
        }
      }
    }
  }

  return summary;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const refreshContact = arg('refresh-contact');
  const c = getConfig();
  const token = c.hubspotToken;
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN is not set');

  const apptUid = c.appointmentUidProperty || 'blvd_appointment_uid';
  const orderUid = c.orderUidProperty || 'blvd_order_uid';
  const apptId = c.appointmentIdProperty || 'blvd_appointment_id';
  const orderId = c.orderIdProperty || 'blvd_order_id';

  const appt = await hs.resolveObjectTypeId(token, c.appointmentObject);
  const order = await hs.resolveObjectTypeId(token, c.orderObject);

  if (!appt.properties.includes(apptUid) || !order.properties.includes(orderUid)) {
    throw new Error(
      `Missing uid properties. Run: ENV_FILE=… node scripts/ensure-blvd-uid-properties.js`
    );
  }

  console.log(apply ? 'Mode: APPLY' : 'Mode: dry run (pass --apply to write)');

  const appointment = await collapseAndBackfill({
    token,
    objectTypeId: appt.objectTypeId,
    legacyProp: apptId,
    uidProp: apptUid,
    label: 'appointments',
    apply,
  });
  const orders = await collapseAndBackfill({
    token,
    objectTypeId: order.objectTypeId,
    legacyProp: orderId,
    uidProp: orderUid,
    label: 'orders',
    apply,
  });

  let dealAmounts = null;
  if (apply && refreshContact) {
    dealAmounts = await refreshDealAmounts(c, { contactId: refreshContact });
  } else if (refreshContact) {
    dealAmounts = await refreshDealAmounts(c, {
      contactId: refreshContact,
      dryRun: true,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: summaryOk(appointment, orders),
        appointment,
        orders,
        dealAmounts,
      },
      null,
      2
    )
  );
  if (appointment.errors.length || orders.errors.length) process.exit(2);
}

function summaryOk(appointment, orders) {
  return appointment.errors.length === 0 && orders.errors.length === 0;
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
