# HubSpot CRM webhook — internal setup (Larry / RubeTech)

Portal: **51888138** (sandbox)

Dan-facing summary: `HUBSPOT_CRM_WEBHOOK_SETUP.md`

Endpoint: `https://inkless-sync-staging-rubetech.onrender.com/webhooks/hubspot`

On `contact.propertyChange` for `lifecyclestage` = **1409285288**, middleware runs `processQualifyPath` (createClient + Acquisition Deal).

---

## Two credentials

| Credential | Used for | Where |
|------------|----------|--------|
| **Service Key** (`Inkless BLVD Sync - Staging`) | Middleware API (`HUBSPOT_ACCESS_TOKEN`) | Development → Keys → Service Keys |
| **Private app** (`Inkless Sync Webhooks - Staging`) | CRM webhook subscription + signature secret | Settings → Integrations → Private apps |

Service Keys **do not** support webhooks. The private app’s access token is **not** used by middleware — only its **client secret** for signature verification.

---

## Private app setup

1. Settings → Integrations → **Private apps** → `Inkless Sync Webhooks - Staging`
2. **Scopes:** `crm.objects.contacts.read` (required for `contact.propertyChange`; not `origins.ip_ranges.webhook.*`)
3. **Webhooks** tab:
   - Target URL: `https://inkless-sync-staging-rubetech.onrender.com/webhooks/hubspot`
   - Subscription: **Contact** → **Property changed** → `lifecyclestage`
4. Copy **Client secret** → Render + `.env.staging`

---

## Render environment

| Variable | Value |
|----------|--------|
| `HUBSPOT_CLIENT_SECRET` | Private app client secret |
| `HUBSPOT_WEBHOOK_PUBLIC_URL` | `https://inkless-sync-staging-rubetech.onrender.com/webhooks/hubspot` |
| `HUBSPOT_QUALIFIED_LIFECYCLE_VALUE` | `1409285288` (optional; default) |

Redeploy after env changes. `WEBHOOK_PUBLIC_URL` stays on Boulevard path.

---

## Local dev

```powershell
# Terminal 1
cd sync-middleware
npm start

# Terminal 2
$env:HUBSPOT_WEBHOOK_SKIP_VERIFY="true"
npm run simulate:hs-qualify -- <contactId>
```

Or: `npm run verify:qualify -- <contactId> --staging`

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 invalid_signature | `HUBSPOT_CLIENT_SECRET` + `HUBSPOT_WEBHOOK_PUBLIC_URL` must match HubSpot Target URL exactly |
| No webhook received | Subscription on **private app** (not Service Key); lifecycle actually changed |
| BLVD ID missing | `/health/blvd`; Render logs for qualify errors |
| Duplicate runs | Idempotency on HubSpot `eventId` — expected safe |

Manual fallback: `POST /create-client` with `{ "contactId": "..." }`.
