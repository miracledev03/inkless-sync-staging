async function executeGraphQL(url, authToken, query, variables = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function formatErrors(errors) {
  return (errors || []).map((e) => e.message).join('; ');
}

module.exports = { executeGraphQL, formatErrors };
