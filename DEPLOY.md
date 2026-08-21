# Deploy staging middleware (client demo)

**Product to host:** `sync-middleware` only (not `Boulevard/Auth test`).

Use a free HTTPS host so Boulevard webhooks and HubSpot workflow callbacks have a stable URL instead of ngrok/localtunnel.

## Recommended: Render (free web service)

1. Push `sync-middleware` to a GitHub repo (or the Inkless monorepo with root dir set to `sync-middleware`).
2. Go to [https://render.com](https://render.com) → New → Web Service → connect the repo.
3. Settings:
   - **Root directory:** `sync-middleware` (if monorepo)
   - **Runtime:** Node
   - **Build command:** `echo no-build` (no npm dependencies yet)
   - **Start command:** `npm start`
   - **Plan:** Free
4. Environment variables (sandbox only — never production keys):

| Key | Value |
|-----|--------|
| `HUBSPOT_PORTAL_ID` | `51888138` |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot sandbox Service Key |
| `BLVD_ENV` | `sandbox` |
| `BLVD_BUSINESS_ID` | from Auth test `.env` |
| `BLVD_API_KEY` | from Auth test `.env` |
| `BLVD_SECRET_KEY` | from Auth test `.env` |
| `BLVD_WEBHOOK_PATH` | `/webhooks/boulevard` |
| `HUBSPOT_LOCATION_BLVD_ID_PROPERTY` | `location_external_id` |

5. After deploy, copy the public URL, e.g. `https://inkless-sync-staging.onrender.com`
6. Set `WEBHOOK_PUBLIC_URL=https://<your-service>.onrender.com/webhooks/boulevard`
7. Point Boulevard sandbox webhooks at that URL (delete old tunnel webhooks first).
8. Demo checks:
   - `GET https://<host>/health`
   - `GET https://<host>/health/blvd`
   - `GET https://<host>/health/hubspot`
   - Create/cancel a sandbox appointment → event under hosted `data/webhook-events` (ephemeral on free tier; logs still show receipt)

### Free-tier caveat

Render free services **spin down after ~15 minutes idle**. First request after sleep can take 30–60s. For a live client walkthrough, hit `/health` once before the demo, or upgrade later.

## Alternatives

| Host | Notes |
|------|--------|
| **Railway** | Easy Node deploy; free credit, then paid |
| **Fly.io** | Good for always-on small VMs; slightly more setup |
| **Cloudflare Tunnel** | Free public URL to your laptop — fine for you, weaker for “hosted product” demos |

## After it is live

Tell the client:

- Staging middleware URL (health page)
- HubSpot sandbox portal `51888138`
- Boulevard sandbox `https://sandbox.joinblvd.com`

Do **not** use production credentials on this free host.
