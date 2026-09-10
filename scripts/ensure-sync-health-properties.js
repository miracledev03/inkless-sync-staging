/**
 * Ensure Phase D sync-health properties exist on BLVD Appointments + Orders.
 *
 * Usage: node scripts/ensure-sync-health-properties.js
 */
const { getConfig } = require('../src/config');
const hs = require('../src/hubspot/client');

const APPT_PROPS = [
  {
    name: 'last_synced_at',
    label: 'Last Synced At',
    type: 'datetime',
    fieldType: 'date',
    groupName: 'blvd_appointments_information',
    description: 'Middleware clock when this record was last written from Boulevard',
  },
  {
    name: 'sync_status',
    label: 'Sync Status',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'blvd_appointments_information',
    description: 'ok | error — last middleware sync result',
    options: [
      { label: 'Ok', value: 'ok', displayOrder: 0, hidden: false },
      { label: 'Error', value: 'error', displayOrder: 1, hidden: false },
    ],
  },
  {
    name: 'sync_error',
    label: 'Sync Error',
    type: 'string',
    fieldType: 'textarea',
    groupName: 'blvd_appointments_information',
    description: 'Last middleware sync error message (cleared on success)',
  },
];

const ORDER_PROPS = [
  {
    name: 'last_synced_at',
    label: 'Last Synced At',
    type: 'datetime',
    fieldType: 'date',
    groupName: 'blvd_orders_information',
    description: 'Middleware clock when this order was last written from Boulevard',
  },
  {
    name: 'sync_status',
    label: 'Sync Status',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'blvd_orders_information',
    options: [
      { label: 'Ok', value: 'ok', displayOrder: 0, hidden: false },
      { label: 'Error', value: 'error', displayOrder: 1, hidden: false },
    ],
  },
  {
    name: 'sync_error',
    label: 'Sync Error',
    type: 'string',
    fieldType: 'textarea',
    groupName: 'blvd_orders_information',
  },
];

async function ensureProperty(token, objectTypeId, def) {
  let existing = null;
  try {
    existing = await hs.hsRequest(
      token,
      'GET',
      `/crm/v3/properties/${objectTypeId}/${def.name}`
    );
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (existing?.name) {
    return { name: def.name, action: 'exists' };
  }
  const body = {
    name: def.name,
    label: def.label,
    type: def.type,
    fieldType: def.fieldType,
    groupName: def.groupName,
    description: def.description || '',
  };
  if (def.options) body.options = def.options;
  await hs.hsRequest(token, 'POST', `/crm/v3/properties/${objectTypeId}`, body);
  return { name: def.name, action: 'created' };
}

async function main() {
  const c = getConfig();
  const appt = await hs.resolveObjectTypeId(c.hubspotToken, c.appointmentObject);
  const order = await hs.resolveObjectTypeId(c.hubspotToken, c.orderObject);
  const results = { appointment: [], order: [] };
  for (const def of APPT_PROPS) {
    results.appointment.push(
      await ensureProperty(c.hubspotToken, appt.objectTypeId, def)
    );
  }
  for (const def of ORDER_PROPS) {
    results.order.push(
      await ensureProperty(c.hubspotToken, order.objectTypeId, def)
    );
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
