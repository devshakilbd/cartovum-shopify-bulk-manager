# Testing

```bash
npm test                  # 61 automated tests (vitest)
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
| `test/api.test.ts` | Endpoint | Real route handlers: search + cursor + total, select all → preview (no writes) → start → results → revert, readable validation errors, staff permission refusal, cross-shop isolation, CSV with formula guard, decision locking and validation, settings sanitising |

Fixtures (`app/lib/core/memory-gateway.ts`): simple products, multi-variant products, products with options, metafields, tracked/untracked inventory, quantity-managed variants, duplicate and conflicting values.

## Not yet run (external requirement)

- **Live Shopify integration** against a development store — needs Partner credentials and a dev store (see APP_STORE_READINESS.md).
- **Browser UI tests** of the embedded screens — they only render inside Shopify admin. The endpoint tests exercise the same requests the screens send.

Manual checklist for the dev store: search by name/SKU/collection/status/stock; add two attribute conditions; select across pages; select all matching; preview; run each stock status on an untracked product; confirm a tracked product with stock is skipped; add/remove/replace a value; remove an attribute; set a local value; stop a run mid-way; put back; edit one product by hand and put back again (it must be skipped); dry run; CSV; approve a mapping; hold a value; convert; put the conversion back; uninstall and reinstall.
