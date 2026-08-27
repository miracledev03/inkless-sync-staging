# HubSpot staging: Qualified & Engaged → createClient

Portal: **51888138** (sandbox only)

Middleware endpoint:

`POST https://inkless-sync-staging-rubetech.onrender.com/create-client`

Body:

```json
{ "contactId": "{{ contact.hs_object_id }}" }
```

## Create the workflow (UI)

1. In HubSpot sandbox → **Automation** → **Workflows** → **Create workflow**
2. **Contact-based** → **From scratch**
3. Name: `STAGING - Qualify to BLVD createClient`
4. **Enrollment trigger:** Contact property **Lifecycle Stage** is any of **Qualified to Buy** / **Qualified & Engaged**  
   (use the exact option label in this portal — confirm under Settings → Properties → Lifecycle Stage)
5. Re-enrollment: **Off** for staging (or On only if testing repeatedly)
6. Add action → **Send a webhook** (or **Webhook**):
   - Method: `POST`
   - URL: `https://inkless-sync-staging-rubetech.onrender.com/create-client`
   - Body type: JSON
   - Body:
     ```json
     {
       "contactId": "{{ hs_object_id }}"
     }
     ```
   - If the token picker uses a different name, choose **Record ID** / **Contact ID**
7. Optional filter before webhook: **BLVD Client ID** is unknown  
   (avoids calling create when already linked)
8. **Review and publish**

## Smoke test

1. Open a `STAGING-Contact-*` contact (or clone one)
2. Clear **BLVD Client ID** if you want a fresh create (or leave it to test skip/link)
3. Set Lifecycle to **Qualified & Engaged** (exact portal label)
4. Check Render logs for `createClient created` / `linked` / `existing`
5. Confirm **BLVD Client ID** is set on the contact

## Manual API test (no workflow)

```powershell
# Warm free tier
Invoke-RestMethod https://inkless-sync-staging-rubetech.onrender.com/health

# Replace CONTACT_ID
Invoke-RestMethod -Method POST `
  -Uri https://inkless-sync-staging-rubetech.onrender.com/create-client `
  -ContentType 'application/json' `
  -Body '{"contactId":"CONTACT_ID"}'
```

Or locally:

```powershell
cd E:\HubSpot\RubeTech\Inkless\sync-middleware
npm run create:client -- CONTACT_ID
```
