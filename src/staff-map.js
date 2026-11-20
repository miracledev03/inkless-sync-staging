/**
 * Feature 4.2.1 — HubSpot Meeting owner / calendar → Boulevard staff variant.
 * Staff rows live on meeting-types.{env}.json under `staff`.
 */

function variantHaystack(v) {
  return `${v.staff?.displayName || v.staff || ''} ${v.staffId || ''} ${
    v.staff?.id || ''
  } ${v.id || ''}`.toLowerCase();
}

function rowMatchesHints(row, hints = {}) {
  const emails = (row.hsOwnerEmails || [])
    .concat(row.hsOwnerEmail ? [row.hsOwnerEmail] : [])
    .map((e) => String(e).toLowerCase());
  const ids = (row.hsOwnerIds || [])
    .concat(row.hsOwnerId ? [row.hsOwnerId] : [])
    .map((id) => String(id));
  const ownerEmail = String(hints.ownerEmail || '').toLowerCase();
  const ownerId = String(hints.ownerId || '');
  if (ownerEmail && emails.includes(ownerEmail)) return true;
  if (ownerId && ids.includes(ownerId)) return true;

  const name = String(hints.ownerName || hints.staffName || '').toLowerCase();
  const patterns = (row.namePatterns || [])
    .concat(row.blvdStaffNamePattern ? [row.blvdStaffNamePattern] : [])
    .map((p) => String(p).toLowerCase());
  if (name && patterns.some((p) => name.includes(p) || p.includes(name))) {
    return true;
  }
  return false;
}

function findVariantForRow(variants, row) {
  if (!variants?.length || !row) return null;
  if (row.blvdStaffId) {
    const id = String(row.blvdStaffId).toLowerCase();
    const byId = variants.find((v) => {
      const hay = variantHaystack(v);
      return (
        hay.includes(id) ||
        String(v.staffId || '').toLowerCase() === id ||
        String(v.staff?.id || '').toLowerCase() === id ||
        String(v.id || '').toLowerCase().includes(id.replace(/^urn:blvd:staff:/i, ''))
      );
    });
    if (byId) return byId;
  }
  const patterns = (row.namePatterns || [])
    .concat(row.blvdStaffNamePattern ? [row.blvdStaffNamePattern] : [])
    .filter(Boolean);
  for (const p of patterns) {
    const re = new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const hit = variants.find((v) => re.test(variantHaystack(v)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve staffVariants entry for a Meeting book.
 * Priority: explicit body.itemStaffVariantId / staffId → mapped owner → name pattern → default Joey sandbox → first variant.
 */
function resolveStaffVariant(variants, opts = {}) {
  const list = variants || [];
  if (!list.length) {
    return { variant: null, source: 'none' };
  }

  if (opts.itemStaffVariantId) {
    const hit =
      list.find((v) => v.id === opts.itemStaffVariantId) ||
      list.find((v) => String(v.id).includes(String(opts.itemStaffVariantId)));
    if (hit) return { variant: hit, source: 'body_variant' };
  }

  if (opts.staffId) {
    const id = String(opts.staffId).toLowerCase();
    const hit = list.find((v) => variantHaystack(v).includes(id));
    if (hit) return { variant: hit, source: 'body_staff_id' };
  }

  const staffRows = opts.staffMap || [];
  for (const row of staffRows) {
    if (!rowMatchesHints(row, opts)) continue;
    const hit = findVariantForRow(list, row);
    if (hit) return { variant: hit, source: 'owner_map', row: row.label || null };
  }

  // Staging default: Joey / known sandbox staff UUID (legacy B10 behavior).
  const joey = list.find((v) =>
    /Joseph Rios|42e5b97d-7c6a-4d90-ba3d-908994ef205d/i.test(variantHaystack(v))
  );
  if (joey) return { variant: joey, source: 'sandbox_joey_default' };

  return { variant: list[0], source: 'first_variant' };
}

module.exports = {
  resolveStaffVariant,
  findVariantForRow,
  rowMatchesHints,
};
