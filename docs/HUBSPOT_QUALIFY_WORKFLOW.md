# HubSpot staging: Qualified & Engaged → createClient + Acquisition Deal

Portal: **51888138** (sandbox only)

When a Contact reaches **Qualified & Engaged**, the workflow calls middleware which:

1. **createClient** in Boulevard (lookup-before-create; writes **BLVD Client ID** on Contact)
2. **Creates Acquisition Deal** at **New Opportunity** if none open (copies **Language** Contact → Deal)

Middleware endpoint:

`POST https://inkless-sync-staging-rubetech.onrender.com/create-client`

Body:

```json
{ "contactId": "{{ contact.hs_object_id }}" }
```

## Create the workflow (UI — ~10 min)

1. HubSpot sandbox → **Automation** → **Workflows** → **Create workflow**
2. **Contact-based** → **From scratch**
3. Name: `STAGING - Qualify to BLVD createClient`
4. **Enrollment trigger:** Lifecycle stage is **Qualified & Engaged**  
   (internal value `1409285288` in portal 51888138)
5. Re-enrollment: **Off** for staging
6. **Optional filter** (recommended): **BLVD Client ID** is unknown  
   AND no open Acquisition deal exists (or skip filter — middleware is idempotent)
7. Add action → **Webhook**:
   - Method: `POST`
   - URL: `https://inkless-sync-staging-rubetech.onrender.com/create-client`
   - Body type: JSON
   - Body:
     ```json
     {
       "contactId": "{{ contact.hs_object_id }}"
     }
     ```
   - Use **Record ID** / **Contact ID** token if `hs_object_id` is not listed
8. **Review and publish**

## Smoke test (workflow)

1. Open a `STAGING-Contact-*` contact (or clone one with unique email)
2. Confirm **BLVD Client ID** empty (or leave set to test skip)
3. Set Lifecycle to **Qualified & Engaged**
4. Within ~1 minute:
   - **BLVD Client ID** on Contact
   - **Acquisition** Deal at **New Opportunity** (if none existed)
   - Deal **Language** matches Contact (English / Spanish)
5. Check Render logs for `qualify path complete`

## Smoke test (API — no workflow)

```powershell
# Warm free tier
Invoke-RestMethod https://inkless-sync-staging-rubetech.onrender.com/health

# STAGING-Contact-Virtual-EN example id — use your contact id
Invoke-RestMethod -Method POST `
  -Uri https://inkless-sync-staging-rubetech.onrender.com/create-client `
  -ContentType 'application/json' `
  -Body '{"contactId":"242593490043"}'
```

Or locally:

```powershell
cd E:\HubSpot\RubeTech\Inkless\sync-middleware
npm run verify:qualify -- 242593490043
npm run verify:qualify -- 242593490043 --staging
```

Expected response shape:

```json
{
  "ok": true,
  "blvd": { "action": "existing|linked|created", "contactId": "...", "blvdClientId": "urn:blvd:Client:..." },
  "acquisitionDeal": { "action": "existing|created", "dealId": "..." }
}
```

## Troubleshooting

| Symptom | Check |
|---------|--------|
| No BLVD Client ID | Render logs; BLVD sandbox reachable (`/health/blvd`) |
| No Deal | Contact may already have open Acquisition deal (action = `existing`) |
| Workflow never fires | Lifecycle label must be exact **Qualified & Engaged**; workflow published |
| 400 contactId required | Webhook body token — use Record ID |
