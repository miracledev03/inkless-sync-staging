# Inkless HubSpot Boulevard Sync (Feature 4.1)

Same code runs in staging (sandbox HubSpot + BLVD) and production (separate HubSpot portal + BLVD business).
Environment differences live only in env vars and per-environment config files:

| | Staging | Production |
|---|---|---|
| Branch / Render | `master` → auto-deploy | `production` → manual deploy (tag releases, e.g. `v4.1.0`) |
| Env | `.env.staging` / Render staging vars | `.env.production.example` → Render production vars |
| HubSpot IDs | `config/hubspot-ids.staging.json` | `config/hubspot-ids.production.json` |
| Service map | `config/service-map.staging.json` | `config/service-map.production.json` |
| Pollers | on | off |
| Ops endpoints | open unless `ADMIN_API_TOKEN` set | require `ADMIN_API_TOKEN` |

`BLVD_ENV=production` (or `prod` / `live`) selects the production BLVD API and the production config files.
Production refuses to start if the ID map is incomplete, belongs to another portal, or either map is not `env: production`.

Code changes go to `master` first, are verified on staging, then merged into `production`.

## Production setup

1. Copy `.env.production.example` → `.env.production` (gitignored) and fill production credentials.
2. In PowerShell: `$env:ENV_FILE='.env.production'`
3. `npm run pull:hubspot-ids` → review → `npm run pull:hubspot-ids -- --write`
4. `npm run discover:services` → review → `npm run discover:services -- --write`; add retail / gift card / non-treatment service IDs to `excludedServiceIds`
5. `npm run check:env` (read-only) until all checks pass
6. Commit both production config files on `master`, merge into `production`, deploy Render production
7. `GET /health` → `production: true`, pollers `enabled: false`, `hubspotIdMap.env: production`
8. Register production webhooks (BLVD + HubSpot CRM webhook) against the production host
9. `Remove-Item Env:ENV_FILE` when done so local scripts go back to staging

## Setup (staging)

1. Copy `.env.staging.example` → `.env.staging` (already created if you followed staging guide).
2. Ensure `HUBSPOT_ACCESS_TOKEN` is the sandbox Service Key (portal `51888138`).
3. Pull BLVD sandbox keys from Auth test:

```powershell
npm run merge:blvd-env
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run smoke:gate` | Ready-for-Phase-A checks |
| `npm run smoke:blvd` | BLVD auth + locations |
| `npm run smoke:hs` | HubSpot contacts |
| `npm run sync:locations` | BLVD locations → HS Location object |
| `npm run sync:contacts` | A5 BLVD clients → HS Contact upsert (`--dry-run`, `--email=`) |
| `npm run backfill:clients` | A6 client-only backfill (default dry-run; `--apply` to write) |
| `npm run create:client -- <contactId>` | Lookup/create BLVD client for HS contact |
| `npm run discover:services` | List BLVD services, map the 4 Acquisition roles in the active service map (`--write` to save) |
| `npm run pull:hubspot-ids` | Read pipeline / stage / lifecycle IDs from the active portal (`--write` to save) |
| `npm run check:env` | Read-only readiness check for the active environment |
| `npm run inspect:appointment` | Classify appointment webhook (add `--apply` to write HubSpot) |
| `npm run inspect:matrix` | Resolve Acquisition matrix for an appointment |
| `npm run inspect:journey` | C4/C5 Treatment Journey attach dry-run (`--apply` to write) |
| `npm run check:staging` | Staging host health |
| `npm start` | Webhook + health server |

## Endpoints

- `GET /health`
- `GET /health/blvd`
- `GET /health/hubspot`
- `GET /health/services`
- `POST /webhooks/boulevard` (HMAC verified; appointment events upsert HubSpot Appointment + Appointment Service; Acquisition matrices + Treatment Journey attach)
- `POST /webhooks/hubspot` (CRM webhook; Qualified & Engaged → createClient + Acquisition Deal)
- `POST /create-client` `{ "contactId": "..." }` (manual / dev fallback)
- `POST /sync-contact` `{ "blvdClientId": "...", "dryRun": true }`
- `POST /backfill-clients` `{ "apply": false, "limit": 10 }` (default dry-run)

Ops endpoints (`/create-client`, `/sync-contact`, `/sync-appointment`, `/refresh-deal-amounts`, `/backfill-clients`, `/book-consult`, `/integration-review`) need header `x-admin-token` (or `Authorization: Bearer`) when `ADMIN_API_TOKEN` is set; in production they are locked until it is set.

Phase B Origin System notes: `../docs/Inkless_4.1_Origin_System_Phase_B.md`.

## Phase A exit (staging)

- A1–A4, A7: auth, webhooks, locations, createClient, service map
- A5: `npm run sync:contacts` (or `/sync-contact`)
- A6: `npm run backfill:clients` dry-run → **BLVD Pre-Cutover Client** + Lifecycle **Lead** (Dan Sep 24)
- Ensure property: `npm run ensure:pre-cutover-property`
- Qualify trigger: private app CRM webhook → `/webhooks/hubspot` (Dan: `docs/HUBSPOT_CRM_WEBHOOK_SETUP.md`; setup: `docs/HUBSPOT_CRM_WEBHOOK_INTERNAL.md`)

## Host for client demos

See `../docs/DEPLOY_STAGING_MIDDLEWARE.md` in the Inkless workspace (not inside this app folder).
