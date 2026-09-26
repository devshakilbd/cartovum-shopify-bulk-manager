# Cartovum Bulk Product Manager for Shopify

The Shopify version of the Cartovum Bulk Product Manager v1.3.9 WooCommerce plugin: find products, select them (page by page or every match), then set stock status or edit one attribute across all of them — in batches of 10, with every product checked afterwards, a log of every run, and a safe Put back. Includes the typed → shared attribute conversion with dry run, CSV report, approved mappings, held values and planned values.

- Embedded Shopify admin app (React Router template, App Bridge, Polaris web components)
- Admin GraphQL API **2026-07**
- Prisma (SQLite in development, PostgreSQL in production)

Documentation: [ARCHITECTURE](ARCHITECTURE.md) · [Data mapping](SHOPIFY_DATA_MAPPING.md) · [Parity matrix](SHOPIFY_FEATURE_PARITY.md) · [Parity report](FEATURE_PARITY_REPORT.md) · [Security](SECURITY.md) · [Privacy](PRIVACY_DATA_MODEL.md) · [App Store readiness](APP_STORE_READINESS.md) · [Testing](TESTING.md)

## Requirements

Node 20.19+ or 22.12+, npm, the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli), a Shopify Partner account and a development store.

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Database setup (development) | `npx prisma migrate dev` |
| Link to your Partner app | `npm run config:link` |
| Development (tunnel + dev store) | `npm run dev` |
| Tests | `npm test` |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| GraphQL check against the API schema | `npm run graphql-codegen && npm run validate:graphql` |
| Build | `npm run build` |
| Production (after build) | `npm run setup && npm run start` |
| Push app config, scopes and webhooks | `npm run deploy` |

## Production database

Development uses SQLite. For production, change `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

then create a PostgreSQL migration once (`npx prisma migrate dev --name init` against a PostgreSQL `DATABASE_URL`) and deploy with `npm run setup`. The schema stores JSON as text, so it works unchanged on both.

## Environment

See [.env.example](.env.example). The Shopify CLI supplies these during `npm run dev`.

## Background work

Runs are processed by a worker loop inside the web process (`app/lib/services.server.ts`). It claims one run at a time with a database lease, processes one batch of 10, and releases it, so several processes can share the work and an interrupted run resumes. Set `CARTOVUM_WORKER=off` on processes that should only serve requests.

## Settings that change behaviour

In the app's Settings page: local attribute namespaces (default `cartovum_local`), leave products with variants alone (on), runs kept (25), most products per run (50,000), conversion writes (off — dry run only), staged conversion statuses and individually approved products.

## Support

Cartovum Agency — https://cartovumagency.com/contact/
