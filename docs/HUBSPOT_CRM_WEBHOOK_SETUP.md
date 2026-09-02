# Qualified & Engaged — what happens in staging

**Environment:** HubSpot sandbox **51888138** only — [open portal](https://app.hubspot.com/home?portalId=51888138)

When you set a Contact’s **Lifecycle stage** to **Qualified & Engaged**, HubSpot notifies our sync middleware automatically. You do **not** need a Marketing workflow or any API calls.

**Already configured (you don’t need to change this):** a HubSpot private app (**Inkless Sync Webhooks - Staging**) sends lifecycle changes to middleware. Middleware uses your existing **Service Key** integration for all read/write in HubSpot and Boulevard.

---

## What middleware does

Within about **30–60 seconds** after qualify:

1. **Boulevard Client** — created or linked (no duplicate if the email already exists in Boulevard)
2. **BLVD Client ID** — written on the HubSpot Contact
3. **Acquisition Deal** — created at **New Opportunity** if the Contact did not already have an open Acquisition deal
4. **Language** — copied from Contact to the new Deal (English / Spanish)

If **BLVD Client ID** was already set, middleware will not create a second Boulevard client.

---

## How to test

Use **Test A** in the main staging guide: `docs/Inkless_4.1_Staging_Test_Guide_for_Client_Aug31.md`.

Short version:

1. Open a **STAGING-Contact-*** record (or a test Contact with a **unique email**).
2. If the Contact is already **Qualified & Engaged**, change lifecycle to **Lead** (or another stage) first so you can flip it again.
3. Set **Lifecycle stage** → **Qualified & Engaged**.
4. Wait ~30–60 seconds and refresh the Contact.
5. Confirm **BLVD Client ID**, **Acquisition** Deal at **New Opportunity**, and matching client in Boulevard (same email, no duplicate).

| Starting state | Expected |
|----------------|----------|
| No BLVD ID, new email to Boulevard | New client created; ID on HubSpot |
| No BLVD ID, email already in Boulevard | Existing client **linked**; ID on HubSpot |
| BLVD ID already set | No second client; Deal may already exist |

**Pass when:** BLVD Client ID on Contact, client in Boulevard, no duplicate, Acquisition Deal at New Opportunity (if none existed before qualify).

---

## What you do *not* need

| Not needed | Why |
|------------|-----|
| Marketing workflow | Qualify is triggered by the private app webhook, not Automation |
| “Send a webhook” action | Requires Data Hub; not on your plan |
| API or developer tools | Middleware runs in the background |

---

## If something doesn’t look right

| What you see | What to do |
|--------------|------------|
| Nothing after 2+ minutes | Note Contact name/email, time you changed lifecycle, and email Larry |
| BLVD ID set but no Deal | Contact may already have an open Acquisition deal — check Deals on the Contact |
| Duplicate Boulevard client | Stop testing on that email and email Larry with both record links |
| Wrong lifecycle stage | Confirm you used **Qualified & Engaged** (not “Qualified to Buy” or similar) |

Larry can check middleware logs on the staging host if needed.

---

## Related docs

| Doc | Purpose |
|-----|---------|
| Full staging tests (A–G) | `docs/Inkless_4.1_Staging_Test_Guide_for_Client_Aug31.md` |
| Completed 4.1 specs | `docs/Inkless_4.1_BLVD_Sync_Tech_Specs_Completed_Aug20.md` |
