# Shopify App Store readiness

## Complete

- Embedded app on Shopify's current React Router template, App Bridge and Polaris web components.
- Admin GraphQL API **2026-07** (latest stable at build time); every GraphQL document validated against that schema (`npm run validate:graphql`).
- Managed install / token exchange, expiring offline tokens, online tokens for per-staff permission checks.
- Minimum scopes: `read_products, write_products, read_inventory, write_inventory, read_locations`. No customer or order scopes.
- Mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) and `app/uninstalled`, HMAC-verified and idempotent.
- `AppDistribution.AppStore`.
- Privacy and data handling documented ([PRIVACY_DATA_MODEL.md](PRIVACY_DATA_MODEL.md)).
- No billing required; `createOperation` is the single place to add a plan check later.
- Accessible UI: labelled native controls, keyboard-operable dialog with focus management, live regions for progress.

## Remaining (needs you or external accounts)

**BLOCKED BY EXTERNAL REQUIREMENT**

| Item | What is needed |
|---|---|
| App registration | A Shopify Partner account; run `shopify app config link` to create the app and fill `client_id`. |
| Development store | A dev store to install on, for the live end-to-end test (see TESTING.md, "Not yet run"). |
| Hosting | A public HTTPS URL for `application_url`, and a production PostgreSQL database. |
| Listing | App name/tagline, description, feature list (the dashboard list can be reused), screenshots (1600×900), app icon (1200×1200), demo video (optional). |
| Policies | Privacy policy URL (PRIVACY_DATA_MODEL.md is the source), support email/URL (currently https://cartovumagency.com/contact/), terms URL if you want one. |
| Performance review | Shopify's Lighthouse-based check on the dev store after install. |

## Before submission

1. Switch Prisma to PostgreSQL and run `prisma migrate deploy`.
2. Set `NODE_ENV=production`, `SHOPIFY_APP_URL`, API key/secret.
3. `npm run deploy` to push `shopify.app.toml` (scopes, webhooks, compliance topics).
4. Install on the dev store and run the manual checklist in TESTING.md.
