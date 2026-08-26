async function hsRequest(token, method, urlPath, body) {
  const res = await fetch(`https://api.hubapi.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(`HubSpot ${method} ${urlPath} -> ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function listSchemas(token) {
  return hsRequest(token, 'GET', '/crm/v3/schemas');
}

async function resolveObjectTypeId(token, preferredName) {
  const schemas = await listSchemas(token);
  const want = String(preferredName || '').toLowerCase();
  const match = (schemas.results || []).find((s) => {
    const names = [
      s.name,
      s.labels?.singular,
      s.labels?.plural,
      s.objectTypeId,
    ]
      .filter(Boolean)
      .map((n) => String(n).toLowerCase());
    return names.some((n) => n === want || n.includes(want));
  });
  if (!match) {
    throw new Error(
      `HubSpot custom object not found for "${preferredName}". Available: ${(
        schemas.results || []
      )
        .map((s) => s.name)
        .join(', ')}`
    );
  }
  return {
    objectTypeId: match.objectTypeId || match.fullyQualifiedName || match.name,
    name: match.name,
    properties: (match.properties || []).map((p) => p.name),
  };
}

async function searchByProperty(
  token,
  objectType,
  propertyName,
  value,
  properties = []
) {
  return hsRequest(token, 'POST', `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [
      {
        filters: [
          {
            propertyName,
            operator: 'EQ',
            value,
          },
        ],
      },
    ],
    properties: properties.length ? properties : [propertyName],
    limit: 5,
  });
}

/** Unlabeled default association (v4). */
async function associateDefault(token, fromType, fromId, toType, toId) {
  return hsRequest(
    token,
    'PUT',
    `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`
  );
}

async function createObject(token, objectType, properties) {
  return hsRequest(token, 'POST', `/crm/v3/objects/${objectType}`, {
    properties,
  });
}

async function updateObject(token, objectType, id, properties) {
  return hsRequest(token, 'PATCH', `/crm/v3/objects/${objectType}/${id}`, {
    properties,
  });
}

async function getContact(token, id, properties = []) {
  const qs = properties.length
    ? `?properties=${encodeURIComponent(properties.join(','))}`
    : '';
  return hsRequest(token, 'GET', `/crm/v3/objects/contacts/${id}${qs}`);
}

async function updateContact(token, id, properties) {
  return updateObject(token, 'contacts', id, properties);
}

async function createContact(token, properties) {
  return createObject(token, 'contacts', properties);
}

async function searchContacts(token, filterGroups, properties = [], limit = 5) {
  return hsRequest(token, 'POST', '/crm/v3/objects/contacts/search', {
    filterGroups,
    properties,
    limit,
  });
}

/**
 * Ensure "Imported - BLVD" exists on the contact lifecycle pipeline.
 * Returns the lifecyclestage option value (stage id).
 */
async function ensureImportedBlvdLifecycleStage(
  token,
  label = 'Imported - BLVD'
) {
  const prop = await hsRequest(
    token,
    'GET',
    '/crm/v3/properties/contacts/lifecyclestage'
  );
  const existing = (prop.options || []).find(
    (o) => String(o.label).toLowerCase() === label.toLowerCase()
  );
  if (existing) return existing.value;

  const created = await hsRequest(
    token,
    'POST',
    '/crm/v3/pipelines/contacts/contacts-lifecycle-pipeline/stages',
    {
      label,
      displayOrder: 0,
      metadata: { isClosed: 'false', state: 'OPEN' },
    }
  );
  return created.id;
}

module.exports = {
  hsRequest,
  listSchemas,
  resolveObjectTypeId,
  searchByProperty,
  associateDefault,
  createObject,
  updateObject,
  getContact,
  updateContact,
  createContact,
  searchContacts,
  ensureImportedBlvdLifecycleStage,
};
