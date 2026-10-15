/** `authToken` is a legacy Basic token, or a full `Bearer …` / `Basic …` header value. */
async function executeGraphQL(url, authToken, query, variables = {}) {
  const authorization = /^(Bearer|Basic) /.test(String(authToken))
    ? authToken
    : `Basic ${authToken}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
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
    const err = new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
    err.status = response.status;
    throw err;
  }

  return payload;
}

function formatErrors(errors) {
  return (errors || []).map((e) => e.message).join('; ');
}

module.exports = { executeGraphQL, formatErrors };
