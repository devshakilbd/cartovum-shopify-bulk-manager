# Migration map

The 42 features of Cartovum Bulk Product Manager v1.3.9 (WooCommerce), and where each stands in the Shopify app. For the full, row-by-row parity matrix see [SHOPIFY_FEATURE_PARITY.md](SHOPIFY_FEATURE_PARITY.md). Scopes are explained in [ACCESS_SCOPES.md](ACCESS_SCOPES.md).

**Status key**
- **Implemented**: built, covered by automated tests against the in-memory Shopify.
- **Live**: also verified on a development store. Nothing is live-verified yet; that is Stage 2.
- **Partial**: works, but with a documented gap.
- **Pending**: planned in a later stage.

| # | Feature | Current implementation | Shopify equivalent | API resource | Scope | Status |
|---|---|---|---|---|---|---|
| 1 | Product search | `filters.ts` `shopifyQuery` + `matches` | Product title | `products(query: "title:*…*")` | write_products | Implemented |
| 2 | SKU search | same | Variant SKU, any variant | `products(query: "sku:…")` | write_products | Implemented |
| 3 | Category / product-type filtering | collection, **product type**, **tags** | Collection, `productType`, `tags` | `collection_id:`, `product_type:`, `tag:`; `collections`, `productTypes`, `productTags` for suggestions | write_products | Implemented (type and tags added in Stage 1) |
| 4 | Stock status filtering | derived from variant inventory | InventoryItem.tracked + variant inventoryPolicy + InventoryLevel available | `inventoryItem`, `inventoryLevels` | write_products, write_inventory | Implemented |
| 5 | Product status filtering | ACTIVE / DRAFT / ARCHIVED / UNLISTED | Product.status | `status:` | write_products | Implemented |
| 6 | Multiple attribute conditions | up to 10, AND | — | — | — | Implemented |
| 7 | Global/shared attribute filtering | metafield definitions with a choices list | MetafieldDefinition + choices | `metafieldDefinitions`, `metafields` | write_products | **Partial**: Shopify standard category attributes (metaobject references, e.g. `shopify.color-pattern`) are not handled — Stage 4, decision pending |
| 8 | Local/custom attribute filtering | text metafields in local namespaces | Product metafields | `metafields` | write_products | Implemented |
| 9 | Pagination | cursor + position | Cursor pagination | `products(after:)` | write_products | Implemented |
| 10 | Individual selection | kept across pages | — | — | — | Implemented |
| 11 | Select all matching across pages | filter snapshot resolved server-side into frozen targets | Cursor scan | `products` | write_products | Implemented. Stage 3: Bulk Operations API for very large catalogs |
| 12 | Bulk stock status | tracked flag + policy on the single variant | Inventory tracking + "continue selling" | `inventoryItemUpdate`, `productVariantsBulkUpdate` | write_inventory, write_products | Implemented |
| 13 | Bulk attribute operations | `attributes.ts` | Metafields | `metafieldsSet`, `metafieldsDelete` | write_products | Implemented |
| 14 | Add attribute values | `add_terms` | add choices to list metafield | `metafieldsSet` | write_products | Implemented |
| 15 | Remove attribute values | `remove_terms` (last value removes attribute) | same | `metafieldsSet` / `metafieldsDelete` | write_products | Implemented |
| 16 | Replace attribute values | `set_terms` | same | `metafieldsSet` | write_products | Implemented |
| 17 | Remove an attribute | `remove_attribute` | delete metafield | `metafieldsDelete` | write_products | Implemented |
| 18 | Set local/custom value | `set_local_value` (`a\|b`) | text metafield | `metafieldsSet` | write_products | Implemented |
| 19 | Server-side batch processing | leased background worker | — | — | — | Implemented |
| 20 | Batch size / safe processing | 10 per step; >25 refused | — | — | — | Implemented |
| 21 | Per-product changed/skipped/failed + reason | `ResultRow` | — | — | — | Implemented |
| 22 | Recent runs | dashboard | — | — | — | Implemented |
| 23 | Run history | Run history page, per-product results | — | — | — | Implemented |
| 24 | Put Back / Revert | `createRevert` | — | same mutations | write_products, write_inventory | Implemented |
| 25 | Before-state fingerprint | `fingerprint.ts` | — | full product read | write_products, write_inventory | Implemented |
| 26 | Post-change verification | fresh read after every write | — | `nodes` | write_products | Implemented |
| 27 | Unexpected field change detection | `unexpectedChanges` | — | — | — | Implemented |
| 28 | Variable-product protection | multi-variant products skipped; product options never written | Variants / options | — | — | Implemented |
| 29 | Quantity-managed inventory protection | tracked variant holding any quantity is skipped | InventoryLevel quantities | `inventoryLevels` | write_inventory | Implemented |
| 30 | Global/local attribute conflict protection | name clash skip | — | — | — | Implemented |
| 31 | Conversion dry run | background scan, writes nothing | — | `products`, `metafields` | write_products | Implemented |
| 32 | Approved mapping | decisions | — | — | — | Implemented |
| 33 | Hold values | decisions | — | — | — | Implemented |
| 34 | Planned values | decisions; created by the merchant in Shopify | Definition choices | — | — | Implemented |
| 35 | Post-conversion verification | `verify` + fingerprint | — | `nodes` | write_products | Implemented |
| 36 | Conversion revert | attribute Put Back | — | `metafieldsSet`, `metafieldsDelete` | write_products | Implemented |
| 37 | Cache handling | no product caching; local-value cache cleared after changes | — | — | — | Implemented |
| 38 | Authentication/security | managed install, session tokens, expiring offline tokens | Shopify app auth | — | — | Implemented; **not yet live-verified** |
| 39 | CSRF/state protection | bearer session tokens; OAuth state handled by the Shopify library | — | — | — | Implemented; not yet live-verified |
| 40 | Permission/access-scope protection | minimum scopes + per-staff `associated_user_scope` check | — | — | — | Implemented; not yet live-verified |
| 41 | Error handling | readable messages; read retries; writes verified, never retried | — | — | — | Implemented |
| 42 | Audit/history | who/what/when + per-product before/after | — | — | — | Implemented |

## Where Shopify differs (documented, not deleted)

- **Stock status** has no field in Shopify; it is represented by inventory tracking and the "continue selling when out of stock" policy, with quantities never written. See [SHOPIFY_DATA_MAPPING.md](SHOPIFY_DATA_MAPPING.md).
- **Attribute position/visibility per product** does not exist for metafields, so there is nothing to preserve.
- **Category "include child categories"**: collections are flat.
- **LiteSpeed purge, term counting, WooCommerce notices**: WordPress-only, not applicable.

## Stages

| Stage | Scope | State |
|---|---|---|
| 1 | Minimum scopes, configurable app URL, product type and tag filters, documentation | Done |
| 2 | Link the Dev Dashboard app, install on a development store, live-verify every feature | Awaiting approval |
| 3 | Bulk Operations API for select-all and dry-run scans on large catalogs | Not started |
| 4 | Shopify standard category attributes (metaobjects) as shared attributes | Needs a decision |
| 5 | App Store technical review against the installed app | Not started |
