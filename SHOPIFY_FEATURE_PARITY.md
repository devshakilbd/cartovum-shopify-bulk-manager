# Feature parity matrix — Cartovum Bulk Product Manager v1.3.9 → Shopify

Source audited: `cartovum-bulk-product-manager/` v1.3.9 — every file was read: the main plugin file, `includes/class-swbm-{query,jobs,guard,stock,attributes,convert,ajax,admin}.php`, `includes/convert-decisions.php`, `assets/admin.js`, `assets/admin.css` and `readme.txt`.

"Exact?" means the user sees the same behaviour. **Mapped** means the same behaviour on a different data model; the Notes column explains how.

## Concept mapping used throughout

| WooCommerce | Shopify (this app) |
|---|---|
| Product (simple) | Product with only its default variant |
| Variable product / variation | Product with more than one variant / variant |
| SKU `_sku` | Variant SKU (matched on **every** variant) |
| Category `product_cat` | Collection |
| Post status publish/draft/pending/private | Product status ACTIVE/DRAFT/ARCHIVED/UNLISTED |
| Stock status (not quantity-managed) | Variant inventory `tracked` flag + inventory policy, with zero quantity (see [SHOPIFY_DATA_MAPPING.md](SHOPIFY_DATA_MAPPING.md)) |
| "Manage stock" on | Tracked inventory holding any quantity at any location |
| Global attribute `pa_*` and its terms | Product metafield definition (text or list of text) with a **choices** validation, and those choices |
| Local (custom) attribute | Free-text product metafield in the app's local namespaces (default `cartovum_local`) |
| Attribute "used for variations" | Product option (options define variants) |
| `wp_options` job log | `Operation` / `OperationTarget` tables (per shop) |
| `manage_woocommerce` + nonce | Embedded-app session token (staff member with access to the app) |

## Matrix

| # | Existing feature | WordPress implementation | Shopify equivalent | Implementation | Exact? | Notes |
|---|---|---|---|---|---|---|
| 1 | Search by product name | `WP_Query s` (each word matched anywhere in title or content) | Each word typed must **start** a word of the title (`title:word*` per word, confirmed by the app with the same rule) | `filters.ts` `words`, `shopifyQuery`, `matchesName` | Partial | Shopify documents only trailing wildcards, so text in the middle of a word ("heel" in "Wheel") is not found. Content is not searched; the screen was labelled "Search name". |
| 2 | SKU list filter (lines or commas, ≤500) | `_sku IN (…)` | `sku:"…" OR …`, confirmed on every variant | `parseFilters`, `matches` | Yes | Variant-level, so a multi-variant product matches on any variant's SKU. |
| 3 | Category filter | `product_cat` tax query incl. children | `collection_id:`, plus product type (`product_type:`) and tags (`tag:`, all required) | `shopifyQuery`, `matches` | Mapped | Collections are flat, so "include children" has no counterpart. Product type and tag filters added in Stage 1. |
| 4 | Stock status filter | `_stock_status` meta | Derived per variant (tracked/policy/available); multi-variant derived like a variable parent | `productStockStatus` | Mapped | Confirmed by the app, not Shopify, so pages are assembled server-side. |
| 5 | Published-state filter | `post_status` | `status:` ACTIVE/DRAFT/ARCHIVED/UNLISTED; "Any" names all four | `parseFilters`, `ANY_STATUS_QUERY` | Mapped | Shopify's four statuses replace WP's four. Shopify returns only Active products when no status is given, so "Any" (and select all, and the conversion dry run) sends every status explicitly. |
| 6 | Attribute conditions, up to 10, AND | tax query `AND` + local-ID intersection | Same semantics: every condition must hold; empty value = "has the attribute"; value compare case-insensitive | `parseConditions`, `matchesCondition` | Yes | Adds product options as a condition type (read-only). |
| 7 | Legacy single-attribute request fields | `attribute`/`attr_term`/`attr_value` fallback | — | — | N/A | Only existed for older copies of the plugin's own JS; no such clients exist here. |
| 8 | Per page 25/50/100/200 | `per_page` | Same | `parseFilters` | Yes | |
| 9 | Previous / Next, "Page X of Y" | `paged` | Cursor paging: Previous / Next, "Page X" | `searchPage` | Mapped | Shopify has no page numbers; the total page count is not known without a full scan when filters are confirmed app-side. |
| 10 | "N found" | `found_posts` | `productsCount` when the Shopify query is exact; otherwise "matches are confirmed page by page" | API `search` | Partial | An exact total for stock/attribute filters needs a full scan; "Select all matching" reports the exact count. |
| 11 | Paging keeps the last applied filters | `state.applied` | Same | Products screen | Yes | |
| 12 | Clear filters | JS reset | Same | Products screen | Yes | |
| 13 | Result row: name/edit link, SKU, state, stock, type, categories, attributes (global/local) | `SWBM_Query::rows` | Image, title → Shopify product page, SKU(s), status, stock, inventory, collections, options, attributes | Products screen | Yes | Adds image and inventory; "type" shown as variant count. |
| 14 | Select individual products, kept across pages | `Map` in JS | Same, kept in session storage | Products screen | Yes | |
| 15 | Select all on this page | JS | Same | Products screen | Yes | |
| 16 | Select all matching (cap 5,000, alert when capped) | `ids_for_filters` | Filter snapshot resolved **on the server** into a frozen target list; cap configurable (default 50,000) and reported | `engine.ts` `resolveStep` | Yes | Never loads IDs into the browser. |
| 17 | Clear selection, selected count | JS | Same; "All N matching products selected" | Products screen | Yes | |
| 18 | Bulk stock status: in stock / out of stock / on backorder | `set_stock_status` | Tracked flag + policy on the single variant | `stock.ts` | Mapped | Quantities never written. |
| 19 | Skip variable products (stock) | `is_type('variable')` | Skip multi-variant products | `applyStockOne` | Yes | Setting `protectMultiVariantProducts`, on by default. |
| 20 | Skip quantity-managed stock | `get_manage_stock()` | Skip tracked variants holding any quantity | `isQuantityManaged` | Mapped | Message tells the user to change the quantity instead. |
| 21 | "Already set to this stock status" skip | compare | Same | `applyStockOne` | Yes | |
| 22 | Add values to an attribute | `add_terms` | Add choices to the metafield list | `attributes.ts` `plan` | Yes | |
| 23 | Remove values | `remove_terms` | Same; removing the last value removes the attribute | `plan` | Yes | |
| 24 | Replace values | `set_terms` | Same | `plan` | Yes | |
| 25 | Remove the attribute | `remove_attribute` | Delete the metafield | `plan` | Yes | |
| 26 | Set a local attribute's value (`a|b`) | `set_local_value` | Same, only on products that already have it | `plan` | Yes | A single-value metafield cannot become a list; skipped with a reason. |
| 27 | Never create attributes or terms | term existence checks | Values must be existing definition **choices**; unknown attribute refused | `parseOp` | Yes | |
| 28 | Local/global name clash skip | `local_clash` | Same, names compared ignoring case/punctuation | `plan` | Yes | |
| 29 | Skip "used for variations" attributes and variable products | flags | Skip when a product option has the attribute's name; skip multi-variant products | `applyAttributeOne` | Yes | |
| 30 | Other attributes kept exactly, incl. position/visibility/variation flags | clone + `set_attributes` | Only the named metafield is written; every other metafield is untouched | `writeAttributes` | Mapped | Shopify metafields have no per-product position or visibility, so those flags do not exist to preserve. |
| 31 | Confirmation before a run (plain sentence) | `window.confirm` | Preview dialog: operation, filters, count, per-product preview of the first 50 | `preview.ts`, `Confirm` | Yes (improved) | |
| 32 | Batches of 10; >25 per request refused, not trimmed | `SWBM_BATCH_SIZE`, `MAX_PER_REQUEST` | Same constants in the engine | `engine.ts` `step` | Yes | |
| 33 | Progress bar, "x of y processed" | JS | Progress bar, "x / y", batch n / m, changed/skipped/failed | Run screen | Yes | |
| 34 | Stop after this batch | JS flag | Server-side cancel flag honoured before the next batch | `requestStop` | Yes | Works even if the browser is closed. |
| 35 | Per-product result: changed / skipped / failed + reason | row arrays | Same, filterable, paged | Run screen | Yes | |
| 36 | Warning when some products were not processed | JS | Same, from the target table | `finish` | Yes | |
| 37 | Fingerprint before/after, unexpected-change report | `SWBM_Guard` | Canonical fingerprint of title, handle, status, vendor, type, tags, description, template, category, collections, media, options, variants (SKU/price/barcode/options), inventory (tracked/policy/levels), stock status, attributes | `fingerprint.ts` | Yes | |
| 38 | Read back bypassing caches | `reread` | Every verification is a fresh GraphQL read; no product caching | `getProducts` | Yes | |
| 39 | Failed-but-written rows stay revertable | `changed_results` | Same | `createRevert` | Yes | |
| 40 | Run log: id, type, params, time, user, counts | options index + parts | `Operation` + `OperationTarget` (per shop) | `store.server.ts` | Yes | |
| 41 | Recent runs list with Refresh | `jobs` endpoint | Dashboard (10) and Run history (100) | Screens | Yes | |
| 42 | Keep last 25 runs | `prune` | Configurable (default 25); running runs and the latest dry run never pruned | `prune` | Yes | |
| 43 | Put back a run | `revert_start/batch` | Same, batched in the background | `createRevert` | Yes | |
| 44 | Put back skips products changed since | compare with `after` | Same; message names expected vs current value | `revertStockOne`, `revertAttributesOne` | Yes (improved) | |
| 45 | A revert cannot be reverted; a run is marked put back | checks | Same, plus "already put back" and "still running" refusals | `createRevert` | Yes | |
| 46 | Conversion pairs by label | `pairs()` | Local metafield key ↔ definition name or key, compared ignoring case/punctuation | `pairsFor` | Mapped | |
| 47 | Value normalisation (units, quotes) | `normalise` | Identical rules | `convert.ts` `normalise` | Yes | |
| 48 | Resolution: held, override, exact, ambiguous, planned, unmapped | `resolve` | Identical order and outcomes | `resolve` | Yes | Overrides stored by value; one pointing at a value no longer in the list becomes "unmapped", matching the name check. |
| 49 | Plan states ready / blocked / needs-approval / skipped; drop duplicate; different shared value blocks | `plan`, `plan_row` | Identical | `planProduct` | Yes | |
| 50 | Dry run over the whole catalogue, read-only, with progress | paged AJAX | Background scan, progress polled | `createDryRun` | Yes | Writes nothing (tested). |
| 51 | Dry-run summary table + "Needs attention" | JS | Same (current → planned) | Convert screen | Yes | |
| 52 | CSV report (BOM, formula-injection guard) | JS Blob | Server-generated, same columns and guard | API `csv` | Yes | |
| 53 | Convert only selected products that were ready | JS filter | Server filters by its own latest dry run | `createOperation` | Yes (hardened) | Signatures never come from the browser. |
| 54 | Skip products changed since the dry run | signature | Same (hash of attribute signature) | `convertOne` | Yes | |
| 55 | Stop at the first failed check | `stopOnFailure` | Same, server-side | `step` | Yes | |
| 56 | Verify conversion (typed gone, exact values, duplicate untouched, others untouched, nothing new) | `verify` | Identical checks, plus the full fingerprint | `verify` | Yes | Position/visibility check not applicable (see #30). |
| 57 | Dry-run-only switch | `SWBM_CONVERT_DRY_RUN_ONLY` | Per-store setting, **off by default** | Settings | Yes | Blocks conversion runs and decision changes, as before. |
| 58 | Staged conversion: allowed statuses + approved IDs, with banner | constants | Per-store settings | Settings, `convertOne` | Yes | |
| 59 | Decisions: approve mapping, withdraw, hold/release, record new values | `convert_set` + decisions file | Same actions, plus planned values, in the database | API `decision` | Yes | The code file of decisions became data; nothing is lost. |
| 60 | Planned values "to be created on approval" | decisions file | Same; created by the merchant in Shopify's definition editor | `resolve` | Yes | The original never created terms either. |
| 61 | "Run the dry run again" after converting | JS notice | Converted products no longer appear as ready on the next dry run; run page shows results | Convert screen | Partial | No explicit notice; the stale dry run is still used only through signature checks, which skip changed products. |
| 62 | Conversion put back | via attribute revert | Same | `revertAttributesOne` | Yes | |
| 63 | Local value dropdowns with counts (scan ≤10,000, ≤300 values, 12 h cache, cleared on change) | transient | Same limits; DB cache 12 h, cleared after every attribute/convert/revert batch | `localValues` | Yes | |
| 64 | Global value dropdowns with product counts | `get_terms` counts | Choices listed without counts | Products screen | Partial | Shopify does not count products per metafield choice. |
| 65 | LiteSpeed page-cache purge | `litespeed_purge_post` | — | — | N/A | Shopify's storefront cache is invalidated by Shopify on every product write. |
| 66 | Deferred term counting | `wp_defer_term_counting` | — | — | N/A | No term counts exist to recount. |
| 67 | Capability + nonce on every endpoint | `guard()` | Session-token authentication on every endpoint; shop taken from the token | `authenticate.admin` | Mapped | See SECURITY.md. |
| 68 | "Needs WooCommerce" notice, HPOS declaration | hooks | — | — | N/A | Platform-specific to WordPress. |
| 69 | Contact Support link | plugin row meta | Dashboard link | Dashboard | Yes | |
| 70 | View details: version, features, compatibility, readme | dialog | Dashboard "What this app does", version and API version | Dashboard | Partial | No WordPress/PHP compatibility table (not meaningful); guide is README.md. |
| 71 | Translatable strings | text domain | English strings | — | Partial | The plugin shipped no translations; i18n can be added without behaviour change. |

Totals: 71 rows — 61 implemented (Yes/Mapped), 6 partial, 4 not applicable, 0 blocked. See [FEATURE_PARITY_REPORT.md](FEATURE_PARITY_REPORT.md) for test evidence.
