# Shopify App Store readiness

Status on 2026-09-29: **not ready to submit** — production is not deployed yet, and the items below need the owner.

## Done and verified

- Embedded app on Shopify's React Router template, App Bridge and Polaris web components; installed and working on `cartovum-bulk-dev`.
- Admin GraphQL API **2026-07**; every GraphQL document validated against that schema; every query within Shopify's 1,000-point cost limit (measured).
- Managed install / token exchange; offline and online sessions stored with exactly `write_products,write_inventory` (verified in the database).
- Minimum scopes, justified in [ACCESS_SCOPES.md](ACCESS_SCOPES.md) and [APP_STORE_LISTING.md](APP_STORE_LISTING.md).
- Mandatory compliance webhooks and `app/uninstalled`: HMAC-verified, idempotent; tested live with signed deliveries (accepted) and unsigned / wrongly signed requests (refused).
- No access without a valid Shopify session (tested live: missing, garbage and forged tokens refused; a forged write created nothing).
- Functional matrix on the development store: see [FUNCTIONAL_TEST_REPORT.md](FUNCTIONAL_TEST_REPORT.md).
- Public pages served by the app: landing `/`, `/privacy`, `/terms`, `/support` (checked at desktop and 375 px phone width). The template placeholder landing page and its "shop domain" login form are gone.
- Production image: two-stage `Dockerfile` (steps replayed in a clean copy and started with production dependencies only); `.dockerignore` excludes secrets, the development database and test output.
- Repository audit: no tunnel URLs, dev-store IDs, secrets, seed or test code in the app or its build; no `console.log` in app code.

## Needs the owner

| Item | What is needed |
|---|---|
| Separate development app | Create a dev app in the Dev Dashboard so `shopify app dev` never rewrites the production app's URLs ([DEPLOYMENT.md](DEPLOYMENT.md) §1) |
| Hosting + database | Choose a host that keeps the process running, and PostgreSQL (or MySQL) ([DEPLOYMENT.md](DEPLOYMENT.md) §2–3) |
| DNS | `app.cartovumagency.com` record pointing at the host |
| Secrets | Client secret and database URL entered in the host's settings |
| K1 | Create CBM Test K1 by hand in cartovum-bulk-dev, then run `npm run test:functional -- k1 --confirm cartovum-bulk-dev` |
| Listing | Pricing decision, support email, app icon (1200×1200), screenshots (1600×900) — see [APP_STORE_LISTING.md](APP_STORE_LISTING.md) |
| Policies | Review the privacy policy and terms text (drafted from the app's actual data handling) before publishing |
| Performance check | Shopify's admin performance check runs against the installed production app |
