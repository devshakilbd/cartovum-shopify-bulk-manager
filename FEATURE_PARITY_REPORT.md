# Feature parity report

Row numbers refer to [SHOPIFY_FEATURE_PARITY.md](SHOPIFY_FEATURE_PARITY.md). "Live" testing on a real store is still to do (see TESTING.md); every status below is backed by automated tests against the mock Shopify unless it says otherwise.

| # | Feature | Original behaviour | Shopify behaviour | Status | Test | Notes |
|---|---|---|---|---|---|---|
| 1 | Name search | WP search | Title contains, confirmed exactly | PASS | core: filters | |
| 2 | SKU list | `_sku IN` | Any variant SKU, ≤500 | PASS | core: filters, paging | |
| 3 | Category filter | incl. children | Collection | PASS | core: filters (escaping) | Collections have no children. |
| 4 | Stock status filter | meta | Derived | PASS | core: paging, fingerprint | |
| 5 | Published state | 4 WP statuses | 4 Shopify statuses | PASS | core: filters | |
| 6 | Attribute conditions (AND, ≤10) | tax/local | Same | PASS | core: filters | |
| 7 | Legacy request fields | fallback | — | NOT APPLICABLE | — | Only served older copies of the plugin's own script. |
| 8 | Per page | 25–200 | Same | PASS | core: filters | |
| 9 | Paging | page numbers | Cursors, Previous/Next | PASS | core: paging | |
| 10 | "N found" | always | Exact when Shopify can count; otherwise "confirmed page by page" | PARTIAL | api: search | Select all reports the exact number. |
| 11–12 | Applied filters / clear | JS | Same | PASS | UI code review | |
| 13 | Result rows | table | Table with image, inventory, collections, options, attributes | PASS | api: search | |
| 14–17 | Selection, page, all matching, clear | JS + 5,000 cap | Session-kept selection; server-resolved select all, configurable cap | PASS | safety: select all; scale; api | |
| 18–21 | Stock operations + protections | WC CRUD | Tracked flag + policy | PASS | core: stock; safety | |
| 22–29 | Attribute operations + rules | WC attributes | Metafields/choices | PASS | core: attribute operations; api | |
| 30 | Other attributes preserved | clone | Untouched metafields | PASS | safety: unexpected change | Position/visibility flags do not exist in Shopify. |
| 31 | Confirmation | `confirm()` | Preview dialog | PASS | api: preview writes nothing | |
| 32 | Batches of 10, >25 refused | constants | Same | PASS | safety: jobs | |
| 33–36 | Progress, stop, per-product results, warning | JS | Server-side, polled | PASS | safety: jobs; scale | |
| 37–39 | Fingerprint, read back, failed-but-written revertable | Guard | Same | PASS | safety: verification | |
| 40–42 | Log, recent runs, keep 25 | options | Tables, configurable | PASS | safety: pruning | |
| 43–45 | Put back with conflict protection | revert | Same, with expected/current | PASS | safety: revert | |
| 46–49 | Pairing, normalisation, resolution, plans | Convert | Same | PASS | convert: value matching, planning | |
| 50–52 | Dry run, summary, CSV | AJAX + JS | Background + server CSV | PASS | convert: dry run; api: CSV | |
| 53–56 | Convert ready only, signature, stop on failure, verify | Convert | Same, signatures server-held | PASS | convert: flow | |
| 57–60 | Dry-run-only, staged, decisions, planned values | constants + options + file | Settings + DB | PASS | convert: flow; api: decisions | |
| 61 | "Run the dry run again" notice | JS | Not shown; signature check still protects | PARTIAL | convert: signature skip | Cosmetic. |
| 62 | Conversion put back | attribute revert | Same | PASS | convert: flow | |
| 63 | Local value dropdowns | transient | DB cache, same limits | PASS | gateway: mapping | Cache logic reviewed, not unit tested. |
| 64 | Term counts in dropdowns | term counts | No counts | PARTIAL | — | Shopify keeps no per-choice counts. |
| 65 | LiteSpeed purge | hook | — | NOT APPLICABLE | — | Shopify invalidates its own storefront cache. |
| 66 | Term count deferral | WP | — | NOT APPLICABLE | — | No term counts. |
| 67 | Capability + nonce | WP | Session token + staff scopes | PASS | api: permission, isolation | |
| 68 | WooCommerce notice, HPOS | WP | — | NOT APPLICABLE | — | WordPress-only. |
| 69 | Contact support | row link | Dashboard | PASS | — | |
| 70 | View details | dialog | Dashboard section | PARTIAL | — | No WP/PHP compatibility table. |
| 71 | Translations | text domain | English | PARTIAL | — | Plugin shipped none. |

**Totals (71 rows):** PASS 62 · PARTIAL 5 · BLOCKED 0 · NOT APPLICABLE 4.
