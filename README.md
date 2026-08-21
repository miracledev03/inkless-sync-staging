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
| `npm run create:client -- <contactId>` | Lookup/create BLVD client for HS contact |
| `npm run discover:services` | Fill `config/service-map.staging.json` |
| `npm start` | Webhook + health server |

## Endpoints

- `GET /health`
- `GET /health/blvd`
- `GET /health/hubspot`
- `GET /health/services`
- `POST /webhooks/boulevard` (HMAC verified)
- `POST /create-client` `{ "contactId": "..." }`

## Host for client demos

See [DEPLOY.md](./DEPLOY.md) — deploy **this folder** (not Auth test) to Render/Railway free tier for a stable HTTPS URL.
