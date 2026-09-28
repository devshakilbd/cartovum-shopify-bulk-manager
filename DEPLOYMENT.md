# Production deployment — https://app.cartovumagency.com

Status: **not deployed.** Everything in the repository is ready; the items marked *decision* need the owner.

## 1. Before going live: separate development app (decision)

Today the development store and production would share **one** Shopify app (client ID `23cb8423…`). `shopify app dev` rewrites that app's URLs to a temporary tunnel every time it runs (`automatically_update_urls_on_dev = true`), which would break the app for every installed merchant.

**Required:** keep *Cartovum Bulk Product Manager* as the production app, and create a second app in the Dev Dashboard (e.g. *Cartovum Bulk Product Manager (dev)*) for `cartovum-bulk-dev`. Then `shopify app config link` the dev app into `shopify.app.toml`, and keep `shopify.app.production.toml` on the production client ID. The dev store gets the dev app installed; the functional tests and seed run against it unchanged.

## 2. Hosting (decision)

The app is one long-running Node.js process: the web server **and** the background worker that runs operations. Requirements:

- Node.js 22 (or 20.19+), always running — not serverless, and not a host that stops idle processes (runs would pause until the next page load)
- HTTPS on `app.cartovumagency.com`
- A persistent database (below)
- Environment variables set on the host (the client secret must never be in the repository)

Suitable options:

| Option | Notes |
|---|---|
| Container host (Render, Fly.io, Railway, DigitalOcean App Platform) | Uses the repository `Dockerfile` as is; add a managed PostgreSQL |
| VPS (e.g. Hostinger VPS) | Run the Docker image (or `npm ci && npm run build && npm run docker-start`) behind a reverse proxy with HTTPS; PostgreSQL on the VPS or managed |
| Hostinger web hosting with Node.js | Only if the plan keeps the process running continuously; database there is MySQL (switch the Prisma provider to `mysql`) |

## 3. Database (decision)

Production needs PostgreSQL (recommended) or MySQL — not SQLite. Change `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

then create the production migration once against an empty database (`npx prisma migrate dev --name init` with that `DATABASE_URL`), commit it, and let `npm run setup` apply it on deploy. The SQLite migrations stay for development.

## 4. DNS

Add a record for `app` on `cartovumagency.com` pointing at the host (CNAME to the host's name, or A record to the VPS). The main website is unaffected.

## 5. Environment variables on the host

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` | production app client ID |
| `SHOPIFY_API_SECRET` | production app client secret (**secret** — enter it in the host's settings yourself) |
| `SHOPIFY_APP_URL` | `https://app.cartovumagency.com` |
| `SCOPES` | `write_products,write_inventory` |
| `DATABASE_URL` | production database connection string (**secret**) |
| `NODE_ENV` | `production` |
| `PORT` | as the host requires (default 3000) |

The server refuses to start in production if `SHOPIFY_APP_URL` is missing or not HTTPS.

## 6. Deploy

1. Build and start: the `Dockerfile` (two-stage build; verified by replaying its steps in a clean copy and starting with production dependencies only), or `npm ci && npm run build && npm run docker-start` (applies migrations, then starts).
2. Check `https://app.cartovumagency.com/` shows the landing page and `/privacy`, `/terms`, `/support` load.
3. Push the Shopify configuration: `npm run config:use shopify.app.production.toml`, then `npm run deploy` (URLs, scopes, webhooks, compliance topics).

## 7. Production smoke test (read-only)

On a store that installs the production app (a dedicated test store is best):

- install from the listing / install link; the app opens in Shopify admin
- a session is stored (offline + online) with `write_inventory,write_products`
- Dashboard, Products (search and filters), Run history, Attribute conversion and Settings load
- signed webhook delivery works (Partner Dashboard → webhook test, or `shopify app webhook trigger` against the production URL); unsigned requests are refused (400/401)
- uninstall: sessions deleted; `shop/redact` 48 h later erases the store's data

No bulk runs against real merchant data as part of the smoke test.

## 8. Monitoring

Logs are one JSON object per line on stdout (`log.server.ts`; secrets are never logged): collect them with the host's log viewer. Recommended: an error-monitoring service (e.g. Sentry) — needs an account; not added yet.
