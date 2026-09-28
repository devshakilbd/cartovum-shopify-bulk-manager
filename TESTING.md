# Testing

```bash
npm test                  # 100 automated tests (vitest)
npm run typecheck
npm run lint
npm run graphql-codegen && npm run validate:graphql   # checks every GraphQL document against the 2026-07 schema
npm run build
```

## What is covered

| File | Kind | Covers |
|---|---|---|
| `test/core.test.ts` | Unit | Filter parsing and hardening, SKU list, 10-condition cap, AND semantics, option conditions, search-string escaping, cursor paging across pages (every match once), forged cursors, fingerprint determinism and unexpected-change detection, stock derivation, every attribute operation, clash, set-local rules, variant protection, stock mapping and quantity protection, preview |
| `test/convert.test.ts` | Unit + flow | Normalisation (18 = 18", 57.10 ≠ 57.1), every resolution kind, blocked/held/duplicate/variant plans, verification, dry run writes nothing, converting ready products only, signature skip, staged statuses + approved IDs, stop on first failure, dry-run-only refusal, conversion put back |
| `test/safety.test.ts` | Safety / failure injection | Unrelated field changed during write, write reported OK but did not stick, Shopify userError, timeout that actually applied (verified, not retried), product deleted mid-run, revert, revert conflict (Blue → Green is never overwritten, message shows expected/current), stock revert conflict, batches of 10, stop after batch, oversized batch refused, crash mid-write (no double apply, still revertable), server-side select all, shop isolation, pruning |
| `test/scale.test.ts` | Large catalogue | 10, 100, 1,000 and 10,000 simulated products: select all matching, batching, 1-in-97 injected write failures, exact counts, a result for every product, memory bound, full revert |
| `test/gateway.test.ts` | Integration (mocked HTTP) | GraphQL → product mapping, global vs local vs foreign metafields, inventory levels, IDs as variables, throttle retry with backoff, writes never retried, uncertain transport failures, userErrors surfaced, exact mutation variables |
| `test/stage1.test.ts` | Unit + flow | Product type and tag filters: parsing (trim, de-duplicate, max 10), escaped search string, not counted as exact, type match ignoring case, every tag required, combined with every existing filter, cursor paging, select all matching by type + tag, older saved filter snapshots still resolve; app URL: origin trimming, redirect URL, localhost allowed, production refuses missing/http/invalid/path URLs |
| `test/search-fixes.test.ts` | Unit + flow | Any status = every status named (search, select all, dry run, staged Draft conversion); name search built from word prefixes only, special characters dropped, accents and non-Latin kept, app check and Shopify narrowing agree. The in-memory Shopify follows the documented rules (Active-only default, trailing wildcard only), so the old queries fail these tests. |
| `test/seed-spec.test.ts` | Seed, offline | The test matrix is consistent with the app's stock and filter rules; the checker catches duplicates, bad values, wrong stock setups and wrong filter expectations; productSet inputs (tracking, quantities, options, list/single metafields, statuses); every seed GraphQL document validates against the 2026-07 schema |
| `test/api.test.ts` | Endpoint | Real route handlers: search + cursor + total, product types/tags in config and search by them, select all → preview (no writes) → start → results → revert, readable validation errors, staff permission refusal, cross-shop isolation, CSV with formula guard, decision locking and validation, settings sanitising |

Fixtures (`app/lib/core/memory-gateway.ts`): simple products, multi-variant products, products with options, metafields, tracked/untracked inventory, quantity-managed variants, duplicate and conflicting values.

## Development-store seed

`scripts/seed-dev-store.ts` creates the approved test matrix on **cartovum-bulk-dev.myshopify.com** only (the store is fixed in `scripts/seed/spec.ts`; there is no option to point it elsewhere). It runs through `shopify app execute`, with the installed app's own scopes and the Shopify CLI login, so it never handles an access token. It never runs the app's bulk operations and never deletes anything.

| Command | What it does | Talks to Shopify? |
|---|---|---|
| `npm run seed:dev` | Checks the matrix with the app's own stock and filter rules and prints it | No |
| `npm run seed:dev -- preflight` | Store identity, one active location, no products other than seed products, no conflicting definitions | Read-only |
| `npm run seed:dev -- apply --confirm cartovum-bulk-dev` | Preflight, then creates 4 shared attribute definitions, 2 collections and 41 products, then verify | **Writes** |
| `npm run seed:dev -- verify` | Reads every seeded product back through the app's gateway and compares it with the matrix; runs all 15 expected filters through the app's real search | Read-only |

What it creates: definitions `shared.colour`, `shared.rim_size`, `shared.centre_bore` (single value) and `shared.wheel_year`, each limited to preset choices; collections *Test Alloy Wheels* and *Test Winter Sale*; products S1–S5, A1–A10, F1–F3, B01–B12, C1–C10 and the control X1, all tagged `cbm-seed`. Untracked variants hold no stock.

**Not seeded — create by hand:** K1, a product in Shopify's standard *Wheels* category with its built-in Colour attribute set, tagged `control`, no product type, inventory not tracked. Category attributes are metaobject references; the app has no metaobject scopes, so the seed cannot set them.

**Rerunning apply** resets every seeded product to its seed state (`productSet` replaces variants, metafields and collections). Put Back is then unavailable for runs made before the reset.

Preflight refuses to continue if the store holds any product without the `cbm-seed` tag (K1 included — create K1 after seeding), more than one active location, or a `shared.*` definition with different choices.

## Functional tests on the development store

`npm run test:functional -- <suite> --confirm cartovum-bulk-dev` with the app running (`shopify app dev --store cartovum-bulk-dev`). Suites: `stock`, `attributes`, `batch`, `conversion`, `filters`, `k1`. Operations are created in the development database as the app's API creates them and run by the app's own worker; every product is read back independently, put back, and must match its before-state fingerprint exactly. The harness raises "runs kept" to 200 while it runs and restores the settings afterwards. Results: [FUNCTIONAL_TEST_REPORT.md](FUNCTIONAL_TEST_REPORT.md).

## Not yet run (external requirement)

- **K1 standard-category test** — K1 must be created by hand in cartovum-bulk-dev first.
- **Browser UI tests** of the embedded screens — they only render inside Shopify admin. The endpoint tests exercise the same requests the screens send.

Manual checklist for the dev store: search by name/SKU/collection/status/stock; add two attribute conditions; select across pages; select all matching; preview; run each stock status on an untracked product; confirm a tracked product with stock is skipped; add/remove/replace a value; remove an attribute; set a local value; stop a run mid-way; put back; edit one product by hand and put back again (it must be skipped); dry run; CSV; approve a mapping; hold a value; convert; put the conversion back; uninstall and reinstall.
