# Functional test report — development store

Store: `cartovum-bulk-dev.myshopify.com` · App: Cartovum Bulk Product Manager (client `23cb8423…`) · Scopes: `write_products,write_inventory` · API 2026-07 · Dates: 2026-09-28/29

**Method.** `npm run test:functional -- <suite> --confirm cartovum-bulk-dev` (scripts/functional). Each operation is created in the development database as the app's API creates it and executed by **the running app's own background worker** with the app's offline session. Every product is then read back independently through `shopify app execute`; the expected after-state and the app's per-product result are checked; the run is put back; and the restored product's full fingerprint must equal its fingerprint before the test. Control product X1 is fingerprinted before and after every suite. Machine-readable results: `test-reports/functional-*.json` (not committed).

Only actual results are listed. RESULT is PASS, FAIL, FIXED (failed, fixed, retested PASS) or BLOCKED.

## Summary

| Suite | Checks | Result |
|---|---|---|
| Stock (Phase 3) | 25 | 25 PASS |
| Attributes (Phase 4) | 54 | 54 PASS |
| Filters (Phase 5) | 12 (+15 in seed verify) | 2 FAIL → FIXED → 12 PASS |
| Select all / batch (Phase 6) | 22 | 22 PASS |
| Conversion (Phase 7) | 38 | 38 PASS |
| K1 standard attributes (Phase 8) | — | **BLOCKED: K1 not in the store** |
| Security / auth / webhooks (Phase 9) | 11 live checks + automated | PASS |
| Run history / revert (Phase 10) | stored data checked | PASS (UI display not yet viewed in admin) |
| Seed verification after all suites | 41 products + 15 filters | **PASS** — store exactly as seeded |

## Details

| FEATURE | TEST | RESULT | NOTES |
|---|---|---|---|
| Stock: untracked → Out of stock | S1 | PASS | tracked on, policy DENY, quantity 0; Put Back restored exactly |
| Stock: → On backorder | S2 | PASS | policy DENY → CONTINUE, tracking unchanged; restored exactly |
| Stock: → In stock | S3 | PASS | tracking off, policy stays CONTINUE, quantity untouched; restored exactly |
| Quantity-managed protection | S4 | PASS | skipped "Quantity-managed inventory…"; quantity 5 unchanged |
| Variant protection (stock) | S5 | PASS | skipped "Product with variants…"; unchanged |
| Put Back refuses a run that changed nothing | S4/S5 run | PASS | "That run changed nothing…" |
| Put Back skips a product changed since | S1 edited by hand | PASS | "Expected: outofstock. Current: onbackorder."; left as edited |
| Add value / replace values | A1 | PASS | [Red] → [Red, Blue]; → [Green]; each restored exactly |
| Remove value / remove final values | A2 | PASS | → [Red]; → attribute removed; each restored |
| Remove absent value / add to empty | A3 | PASS | skipped "Already as requested"; → [Blue]; restored |
| Shared/local name clash | A4 | PASS | skipped with the clash message; unchanged |
| Local list attribute set | A5 | PASS | → [Matt]; → [Matt, Satin]; restored |
| Single-value local protection | A6 | PASS | skipped; unchanged |
| No local attribute created | A7 | PASS | skipped "does not add local attributes" |
| Remove shared / local attribute | A8 | PASS | each removed, each restored |
| Variant protection (attributes) | A9 | PASS | skipped; unchanged |
| Single-value shared attribute | A10 | PASS | add second value skipped; replace 57.1 → 66.1 changed; restored |
| Values outside the preset choices | "Purple" | PASS | refused before any run |
| Filters: name, SKU, collection, type, tags, status, stock, shared + local attributes, AND, pagination | seed verify (15) + filter suite (12) | PASS | incl. variant SKU, option condition, list value, 41 products at 25/page = 25 + 16, no duplicates |
| Filters: collection + name/SKU/tag | filter suite | **FIXED** | Shopify returns nothing for `collection_id` combined with title, sku or tag (measured); the app now leaves those to its own exact check; retested 12/12 PASS |
| Select all matching across pages | B01–B12 by tag | PASS | resolved on the server: 12 |
| Batches of 10 | B run | PASS | progress 10 → 12; 12 changed, 0 skipped, 0 failed |
| Stop after first batch | B run | PASS | stopped: 10 changed, B11–B12 untouched; Put Back 10 |
| Put Back skips a product edited since | B03 → Black | PASS | B03 skipped ("expected: Crimson; current: Black"); 11 restored |
| Conversion dry run writes nothing | C1–C10, A4 | PASS | all 11 unchanged; states as the matrix |
| Conversion refused while switched off | — | PASS | "Conversion is switched off…" |
| Approved mapping / hold / planned value | C4 / C5 / C7 | PASS | ready / awaiting approval / "new value (to be created)" |
| Ambiguous / different shared value blocked | C6 / C3 | PASS | |
| Variant protection (conversion) | C8 | PASS | |
| Staged Draft-only conversion | C1 + C10 | PASS | C1 (Active) skipped, C10 converted, restored |
| Conversion + verification + Put Back | C1 C2 C4 C9 C10 | PASS | 5 converted, C7 skipped (value not created), others unchanged; restored exactly |
| Changed-since-dry-run protection | C9 edited | PASS | skipped; C9 restored by hand |
| Planned value created, then converted | C7 + 21" | PASS | converted, put back; Rim Size choices restored |
| Control product never changed | X1, every suite | PASS | fingerprint identical before and after each suite |
| Standard category attributes untouched | K1 | **BLOCKED** | K1 not in cartovum-bulk-dev (checked 2026-09-29) |
| No access without a Shopify session | 4 requests | PASS | 410 with no token, a garbage token, a JWT signed with the wrong key; a forged write created no run |
| Webhooks: unsigned / wrong signature | 3 requests | PASS | 400 / 401 / 401; nothing processed, sessions intact |
| Webhooks: signed deliveries | customers/data_request, app/uninstalled, shop/redact, customers/redact | PASS | accepted, recorded once, logged; for the sample shop only |
| Cross-shop isolation (live) | uninstall + shop/redact for another shop | PASS | cartovum-bulk-dev sessions and runs untouched |
| Sessions and scopes | database | PASS | offline + online sessions for cartovum-bulk-dev, both `write_inventory,write_products` |
| Run history stored | database | PASS | 53 runs; 20 put-back runs linked both ways; 44/44 changed rows with before+after; 6/6 skipped rows with reasons; stopped run keeps its 2 unreached products unprocessed |
| Run history displayed in admin | — | NOT RUN | needs an admin session: open Run history once and check |
| Performance | measured | see PERFORMANCE.md | 1.8–2.9 s per product through the worker |

## Store integrity after all suites

`npm run seed:dev -- verify` (read-only) after every mutation suite had run: **41/41 products match the matrix field by field; 15/15 filters return exactly the expected products**; nothing was left changed. Note (expected): S1 is also in Shopify's default Home page collection, which Shopify added when the store's first product was created.
