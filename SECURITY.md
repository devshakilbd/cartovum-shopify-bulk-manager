# Security

## Audit results

| Area | How it is handled | Where |
|---|---|---|
| Authentication | Every page loader and API call runs `authenticate.admin`, which validates the App Bridge session token (signed JWT). Unauthenticated requests get no data (smoke-tested: 410 from the library). | routes |
| Shop identity | Always taken from the verified session, never from the request body or query. | `app.api.$action.tsx` |
| Staff authorization | Online tokens are on. Every write action (start, revert, stop, decisions, settings) checks the staff member's own `associated_user_scope`: `write_products`, plus `write_inventory` for stock and revert. A staff member without those permissions is refused on the server. | `requireStaffScopes` |
| Shop isolation | Every Store method takes the shop and filters by it, including child rows (targets, dry-run items). Tested: another shop cannot read, step, or revert a run. | `store.server.ts`, `safety.test.ts`, `api.test.ts` |
| OAuth / install | Managed install and token exchange through `@shopify/shopify-app-react-router`; no hand-written OAuth. Offline tokens are expiring tokens (`expiringOfflineAccessTokens`). | `shopify.server.ts` |
| Webhooks | `authenticate.webhook` verifies the HMAC; unsigned requests are rejected (smoke-tested: 400). Deliveries are de-duplicated by webhook ID. | `webhooks.*` |
| GraphQL injection | Every document is a constant with variables. The only interpolated input is the product search string, built from values that are parsed, length-limited and quoted/escaped (`quote`), or restricted to digits (collection ID) and fixed enums (status). | `gateway.server.ts`, `filters.ts` |
| Input validation | Every endpoint parses input into a closed shape: enums checked, GIDs matched by pattern and type, conditions limited to 10, SKUs to 500, strings length-limited, cursors pattern-checked, settings clamped, namespaces restricted (no `app--` namespaces of other apps). | `filters.ts`, `parseOp`, `parseSettings` |
| Trusting the browser | Product IDs are only used through the shop's own token, so another shop's IDs cannot be reached. Conversion signatures come from the server's stored dry run, not the browser. Batch size is fixed server-side. | `engine.ts` |
| SQL | Prisma only, no raw SQL. | `store.server.ts` |
| XSS | React escapes all output; no `dangerouslySetInnerHTML`. CSV cells that could be read as formulas are prefixed with `'`. | UI, `csv` |
| CSRF | Requests are authorised by a bearer session token, not cookies, so cross-site requests carry no credentials. | — |
| Secrets | Read from environment variables only. Tokens are never sent to the browser. The logger drops any field named like a secret. | `log.server.ts` |
| Rate limiting | At most 30 run-starting requests per shop per minute (per process). Shopify's own API cost limits are respected with backoff. | API route, gateway |
| Replay / duplicates | Runs are processed from a frozen, de-duplicated target list; each product is processed once; an interrupted write is reconciled by reading back, never re-applied. | `engine.ts` |
| Mutation retries | Writes are never retried automatically; an uncertain outcome is decided by reading back. | `gateway.server.ts` |
| Uninstall | Access tokens deleted at once and running jobs stopped; all data erased on `shop/redact`. | webhooks |
| Audit log | Each run records who started it, what, when, and the per-product before/after. Structured logs record run creation, reverts, Shopify errors, uncertain writes and webhook handling. | `Operation`, `log.server.ts` |

## Residual risks

- The per-shop rate limit is per process; with several processes, the effective limit multiplies. Use a shared store (e.g. Redis) if that matters.
- SQLite is for development only. Production must use PostgreSQL or MySQL (see README).

## Reporting a vulnerability

Contact Cartovum Agency: https://cartovumagency.com/contact/
