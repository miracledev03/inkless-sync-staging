# Inkless Feature 4.1 staging middleware

Sandbox only. Never point at production BLVD or HubSpot until Phase D.

## Setup

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
| `npm run discover:services` | Fill `config/service-map.staging.json` |
| `npm run inspect:appointment` | Classify appointment webhook (add `--apply` to write HubSpot) |
| `npm start` | Webhook + health server |

## Endpoints

- `GET /health`
- `GET /health/blvd`
- `GET /health/hubspot`
- `GET /health/services`
- `POST /webhooks/boulevard` (HMAC verified; appointment events upsert HubSpot Appointment + Appointment Service)
- `POST /create-client` `{ "contactId": "..." }`
- `POST /sync-contact` `{ "blvdClientId": "...", "dryRun": true }`
- `POST /backfill-clients` `{ "apply": false, "limit": 10 }` (default dry-run)

Phase B Origin System notes: `../docs/Inkless_4.1_Origin_System_Phase_B.md`.

## Phase A exit (staging)

- A1–A4, A7: auth, webhooks, locations, createClient, service map
- A5: `npm run sync:contacts` (or `/sync-contact`)
- A6: `npm run backfill:clients` dry-run → Imported - BLVD (`1422909443` in sandbox)
- Optional UI: qualify workflow → `/create-client` (see `../docs/HUBSPOT_QUALIFY_WORKFLOW.md`)

## Host for client demos

See `../docs/DEPLOY_STAGING_MIDDLEWARE.md` in the Inkless workspace (not inside this app folder).
