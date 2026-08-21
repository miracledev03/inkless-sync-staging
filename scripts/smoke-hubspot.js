/**
 * Smoke: Service Key can read contacts in HubSpot sandbox.
 * Usage: copy .env.staging.example -> .env.staging, set HUBSPOT_ACCESS_TOKEN, then npm run smoke:hs
 */
const fs = require("fs");
const path = require("path");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function hsGet(token, urlPath) {
  const res = await fetch(`https://api.hubapi.com${urlPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  loadEnv(path.join(__dirname, "..", ".env.staging"));

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const portalId = process.env.HUBSPOT_PORTAL_ID || "(unset)";

  if (!token) {
    console.error(
      "Missing HUBSPOT_ACCESS_TOKEN. Copy .env.staging.example to .env.staging and paste the Service Key."
    );
    process.exit(1);
  }

  console.log(`HubSpot portal ID (config): ${portalId}`);
  console.log("GET /crm/v3/objects/contacts?limit=1 ...");

  const contacts = await hsGet(token, "/crm/v3/objects/contacts?limit=1");
  if (contacts.status !== 200) {
    console.error("Contacts smoke FAILED:", contacts.status, contacts.body);
    process.exit(1);
  }
  console.log("Contacts: OK");

  console.log("GET /crm/v3/schemas (custom objects) ...");
  const schemas = await hsGet(token, "/crm/v3/schemas");
  if (schemas.status === 200) {
    const names = (schemas.body.results || []).map(
      (s) => s.name || s.labels?.singular || s.objectTypeId
    );
    console.log(
      "Custom object schemas:",
      names.length ? names.join(", ") : "(none)"
    );

    const want = ["location", "appointment", "appointment_service", "order"];
    const lower = names.map((n) => String(n).toLowerCase().replace(/\s+/g, "_"));
    for (const w of want) {
      const hit = lower.some((n) => n.includes(w));
      console.log(
        `  ${w}: ${hit ? "found" : "NOT FOUND — may need recreate in sandbox"}`
      );
    }
  } else if (schemas.status === 403) {
    console.warn(
      "Schemas: MISSING_SCOPES (contacts OK). Add crm.schemas.custom.read (and custom object read/write) on the Service Key, then re-run."
    );
    if (schemas.body?.errors) {
      console.warn(JSON.stringify(schemas.body.errors, null, 2));
    }
  } else {
    console.error("Schemas check FAILED:", schemas.status, schemas.body);
    process.exit(1);
  }

  console.log("\nDONE: Service Key can read contacts on portal", portalId);
  console.log("Next: npm run fixtures:staging");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
