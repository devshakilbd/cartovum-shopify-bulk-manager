# Access scopes

The app requests exactly two scopes:

```
write_products,write_inventory
```

Shopify: "Any scope that writes a resource also grants read access to it, so request the write scope only when your app needs both." The app needs both for products and for inventory, so the separate `read_products`, `read_inventory` and `read_locations` scopes are not requested. The app requests no customer, order, or other scopes.

| Scope | Why it is needed | Features that use it |
|---|---|---|
| `write_products` | **Read:** products, variants, collections, product types and tags, product metafields, product metafield definitions, product counts. **Write:** a variant's inventory policy (`productVariantsBulkUpdate`), and product metafields (`metafieldsSet`, `metafieldsDelete`). | Search, SKU, collection, product type, tag, status and attribute filters; select all matching; attribute add/remove/replace/remove attribute/set local value; stock status (the policy half); attribute conversion and its dry run; Put Back; before/after fingerprints |
| `write_inventory` | **Read:** inventory levels (on hand and available per location, including the location). **Write:** an inventory item's `tracked` flag (`inventoryItemUpdate`). | Stock status filter; stock status operations (the tracking half); quantity-managed inventory protection; stock Put Back; inventory part of the fingerprint |

## How each operation maps to a scope (Shopify docs, API 2026-07)

| Operation in `app/lib/gateway.server.ts` | Requirement from Shopify's docs | Covered by |
|---|---|---|
| `products`, `nodes`, `productsCount` (Product fields) | Product: "Requires `read_products` access scope." | `write_products` |
| `collections` | Collection: "Requires `read_products` access scope." | `write_products` |
| `productTypes`, `productTags` | Product data | `write_products` |
| `metafieldDefinitions(ownerType: PRODUCT)` | No scope printed on the reference page; metafield access follows the owner resource | `write_products` — **verified live** on cartovum-bulk-dev (2026-09-28, seed preflight) |
| `metafieldsSet` | "Requires the same access level needed to mutate the owner resource" | `write_products` |
| `metafieldsDelete` | "setting a metafield on a `PRODUCT` requires the same access as mutating a `PRODUCT`" | `write_products` |
| `productVariantsBulkUpdate` | "Requires `write_products`" | `write_products` |
| Variant `inventoryItem { tracked }` | InventoryItem: "Requires `read_inventory` access scope or `read_products` access scope." | either |
| `inventoryLevels`, `quantities` | InventoryLevel: "Requires `read_inventory` access scope." | `write_inventory` |
| `location { id }` on an inventory level | Location: "Requires `read_locations` access scope, `read_inventory` access scope or `read_markets_home` access scope." | `write_inventory` — **verified live** on cartovum-bulk-dev (2026-09-28): `id` is readable |
| `inventoryItemUpdate` | "Requires `write_inventory` access scope." | `write_inventory` |

## Field-level exception found live

On 2026-09-28, against cartovum-bulk-dev with only `write_products,write_inventory`, Shopify returned a location's `id` but refused two other Location fields:

| Field | Shopify's `requiredAccess` |
|---|---|
| `Location.isActive` | `read_locations` |
| `Location.name` | `read_locations` or `read_markets_home` |

The app reads only `location { id }`, so it is unaffected, and `read_locations` is not requested. The development-store seed reads only the id as well. Any future feature that needs a location's name must add `read_locations` and update this file.

## Staff permissions

Scopes limit what the app can do in the store. Separately, every write request checks the staff member's own permissions (their online token's `associated_user_scope`). Starting or putting back a run, stopping a run, and changing settings or conversion decisions need `write_products`. Stock runs and Put Back also need `write_inventory`. Shopify also requires the staff member to have permission to update products and inventory items (`requireStaffScopes` in `app/routes/app.api.$action.tsx`).

## Where the scopes are set

- `shopify.app.toml` and `shopify.app.production.toml`: `[access_scopes] scopes`. These are pushed to Shopify with `npm run deploy`.
- `SCOPES` environment variable (`.env.example`): must match.

When the scopes change, Shopify asks each store to approve the new set on their next visit, and the `app/scopes_update` webhook keeps stored sessions in step.
