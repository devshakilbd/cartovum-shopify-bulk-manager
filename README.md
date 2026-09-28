# Cartovum Bulk Product Manager for Shopify

The Shopify version of the Cartovum Bulk Product Manager v1.3.9 WooCommerce plugin. Find and filter products, select them (page by page or every match), choose an operation, review a preview, then run it. Runs go in batches of 10. Every product is checked afterwards and marked changed, skipped or failed with a reason, and any run can be put back without overwriting later edits. It also includes the typed → shared attribute conversion, with dry run, CSV report, approved mappings, held values and planned values.

- Embedded Shopify admin app: Shopify's React Router template, App Bridge, Polaris web components
- Admin GraphQL API **2026-07**
- Scopes: `write_products, write_inventory` ([ACCESS_SCOPES.md](ACCESS_SCOPES.md))
- Prisma: SQLite in development, PostgreSQL in production

Documentation: [Migration map](MIGRATION_MAP.md) · [Access scopes](ACCESS_SCOPES.md) · [Architecture](ARCHITECTURE.md) · [Data mapping](SHOPIFY_DATA_MAPPING.md) · [Parity matrix](SHOPIFY_FEATURE_PARITY.md) · [Parity report](FEATURE_PARITY_REPORT.md) · [Security](SECURITY.md) · [Privacy](PRIVACY_DATA_MODEL.md) · [App Store readiness](APP_STORE_READINESS.md) · [Testing](TESTING.md)

> **Status:** every feature is covered by automated tests against an in-memory Shopify. The app has **not yet been installed on a real store**; that is Stage 2 in [MIGRATION_MAP.md](MIGRATION_MAP.md).

## Requirements

- Node.js 20.19+ or 22.12+, and npm
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli) (`npm install -g @shopify/cli`)
- Access to the existing **Cartovum Bulk Product Manager** app in the Shopify Dev Dashboard, and a development store

## Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Create the local database | `npx prisma migrate dev` |
| Link to the existing Dev Dashboard app | `npm run config:link` |
| Local development (tunnel + dev store) | `npm run dev` |
| Tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Check GraphQL against the API schema | `npm run graphql-codegen && npm run validate:graphql` |
| Production build | `npm run build` |
| Production start (after build) | `npm run setup && npm run start` |
| Push app config (URLs, scopes, webhooks) to Shopify | `npm run deploy` |
| Development-store test data (plan / preflight / apply / verify) | `npm run seed:dev` — see [TESTING.md](TESTING.md#development-store-seed) |

## Local development

1. Run `npm install`, then `npx prisma migrate dev`. This creates `prisma/dev.sqlite`.
2. Run `npm run config:link` and choose the **existing** app, *Cartovum Bulk Product Manager*. Don't create a new one. This fills `client_id` in `shopify.app.toml`. The client ID is public, so it's safe to commit.
3. Run `npm run dev`. The CLI:
   - starts a tunnel;
   - gives the process `SHOPIFY_APP_URL`, the API key and secret, and `SCOPES`, so no `.env` is needed;
   - points the app's URLs at the tunnel (`automatically_update_urls_on_dev = true`).
4. Press `p` in the CLI to open the app in the development store, and approve the scopes.

## Shopify development store setup

1. In the Dev Dashboard, create a development store (or use an existing one) in the same organisation as the app.
2. Add test products that cover the cases the app treats differently:
   - simple products, and products with variants;
   - inventory that is not tracked, tracked with stock, and tracked at zero;
   - several collections, product types and tags.
3. Set up attributes:
   - **Shared attributes:** in *Settings → Custom data → Products*, create metafield definitions of type *Single line text* (one value or a list) and turn on **Limit to preset choices**. The choices are the shared values.
   - **Local attributes:** text metafields in the namespace `cartovum_local`. The namespace can be changed in the app's Settings.
4. Install the app on the store with `npm run dev` (step 4 above).

## Shopify app configuration

| File | Used for | `application_url` | Redirect URL |
|---|---|---|---|
| `shopify.app.toml` | development (`npm run dev`) | replaced by the CLI tunnel automatically | `<tunnel>/auth/callback`, automatic |
| `shopify.app.production.toml` | production | `https://app.cartovumagency.com` | `https://app.cartovumagency.com/auth/callback` |

Both files declare the same scopes. They also declare the `app/uninstalled` and `app/scopes_update` webhooks, and the mandatory compliance webhooks (`/webhooks/compliance`).

**Redirect URL requirements:**
- It is the app URL plus `/auth/callback`.
- It must use HTTPS.
- It must be in the configuration pushed with `npm run deploy`. Shopify rejects an install whose redirect URL isn't listed.

## Environment variables

See [.env.example](.env.example). All are required in production.

| Variable | Meaning |
|---|---|
| `SHOPIFY_API_KEY` | Client ID from the Dev Dashboard |
| `SHOPIFY_API_SECRET` | Client secret. **Secret.** Also used to verify webhook HMACs. |
| `SHOPIFY_APP_URL` | The app's public origin, e.g. `https://app.cartovumagency.com`. In production it must be HTTPS, or the server refuses to start. |
| `SCOPES` | `write_products,write_inventory` |
| `DATABASE_URL` | PostgreSQL connection string (production) |
| `NODE_ENV`, `PORT` | `production` and the listening port |
| `CARTOVUM_WORKER` | `off` on processes that should not run the background worker |

## App URL

The planned production URL is **https://app.cartovumagency.com**. It's a dedicated subdomain, separate from the public website at https://cartovumagency.com, which this project doesn't touch.

The subdomain is **not deployed yet**. Until it is:
- local development uses the CLI tunnel;
- **don't** run `npm run deploy` with `shopify.app.production.toml`. Pushing a URL that doesn't answer would break the app for every store that has it installed.

To change the URL later, edit `application_url` and `redirect_urls` in `shopify.app.production.toml`, set `SHOPIFY_APP_URL` to match, and deploy.

## Production deployment requirements

- **Host:** Node.js 20.19+ or 22.12+, running one long-lived process. The background worker runs inside it, so serverless or request-only platforms won't work. Several processes are fine: each run is claimed with a database lease.
- **HTTPS on `app.cartovumagency.com`:** a DNS record for the subdomain pointing at the host. The main website is unaffected.
- **Environment:** the variables above.
- **Steps:** `npm ci` → `npm run build` → `npm run setup` (Prisma generate + migrations) → `npm run start`.
- **Shopify configuration:** once the URL answers over HTTPS, run `npm run config:use shopify.app.production.toml`, then `npm run deploy`.
- **Known issue:** the `Dockerfile` came from Shopify's template. It installs production dependencies only and then builds, but the build needs Vite, which is a development dependency. It needs a separate build stage before it can be used. This is untested, because Docker doesn't run on the development PC.

## Production database

Development uses SQLite. Production needs **PostgreSQL**, because SQLite does not support several server processes. Change `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then create a fresh migration once, against a PostgreSQL `DATABASE_URL` (`npx prisma migrate dev --name init`), and apply it in production with `npm run setup`. JSON is stored as text, so no other schema changes are needed.

The database holds:
- sessions;
- run history (the newest 25 runs per store by default);
- per-store settings and conversion decisions;
- the latest dry run.

See [PRIVACY_DATA_MODEL.md](PRIVACY_DATA_MODEL.md).

## Required Shopify scopes

`write_products` and `write_inventory`. Write scopes include read access, so no separate read scopes are requested. [ACCESS_SCOPES.md](ACCESS_SCOPES.md) lists which feature and which API call needs each one.

## Settings that change behaviour

In the app's Settings page:

| Setting | Default |
|---|---|
| Local attribute namespaces | `cartovum_local` |
| Leave products with variants alone | on |
| Runs kept | 25 |
| Most products per run | 50,000 |
| Conversion writes | **off** (dry run only) |
| Staged conversion statuses and individually approved products | none |

## Support

Cartovum Agency — https://cartovumagency.com/contact/
