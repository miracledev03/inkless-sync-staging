/**
 * Create STAGING-* fixture contacts in HubSpot sandbox.
 * Requires HUBSPOT_ACCESS_TOKEN in .env.staging.
 * Optional: HUBSPOT_LANGUAGE_PROPERTY (default: language)
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

async function hs(token, method, urlPath, body) {
  const res = await fetch(`https://api.hubapi.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
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

async function main() {
  loadEnv(path.join(__dirname, "..", ".env.staging"));
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    console.error("Missing HUBSPOT_ACCESS_TOKEN in .env.staging");
    process.exit(1);
  }

  const langProp = process.env.HUBSPOT_LANGUAGE_PROPERTY || "language";
  const fixtures = [
    {
      email: "staging.virtual.en@example.com",
      firstname: "STAGING-Contact-Virtual-EN",
      lastname: "Fixture",
      [langProp]: "English",
    },
    {
      email: "staging.virtual.es@example.com",
      firstname: "STAGING-Contact-Virtual-ES",
      lastname: "Fixture",
      [langProp]: "Spanish",
    },
    {
      email: "staging.inperson@example.com",
      firstname: "STAGING-Contact-InPerson",
      lastname: "Fixture",
      [langProp]: "English",
    },
  ];

  for (const props of fixtures) {
    try {
      const created = await hs(token, "POST", "/crm/v3/objects/contacts", {
        properties: props,
      });
      console.log(`Created ${props.firstname} id=${created.id}`);
    } catch (e) {
      if (e.status === 409 || (e.body && String(e.body.message || "").includes("Existing"))) {
        console.log(`Exists (skip/conflict): ${props.firstname}`, e.body?.message || e.body);
      } else if (e.body?.category === "VALIDATION_ERROR") {
        console.error(
          `Validation failed for ${props.firstname}. Check Language property internal name.`,
          e.body
        );
        console.error(
          `Hint: set HUBSPOT_LANGUAGE_PROPERTY in .env.staging to Joey's exact internal name.`
        );
        process.exit(1);
      } else {
        console.error(`Failed ${props.firstname}:`, e.status, e.body);
        process.exit(1);
      }
    }
  }

  console.log("DONE: staging fixtures.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
