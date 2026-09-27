# Privacy and data model

The app works on catalogue data only. It requests no customer, order or staff-personal scopes.

## Shopify data accessed

| Data | Why | Scope |
|---|---|---|
| Products: title, handle, status, vendor, type, tags, description (hashed on read), template, category, collections, media IDs, options | Search, filters, and the before/after fingerprint that proves nothing else changed | `write_products` (read access included) |
| Variants: SKU, price, compare-at price, barcode, selected options, inventory policy | Search and fingerprint; policy is written for stock status | `write_products` |
| Inventory items and levels (tracked flag, on-hand and available per location) | Stock status and the quantity-managed protection; the tracked flag is written | `write_inventory` (read access, including locations, included) |
| Product metafields (text types) and metafield definitions | Attributes | `write_products` |
| Collections (ID, title) | Collection filter | `write_products` (read access included) |
| Staff member name/email from the online token | Recorded as "who started this run" | none extra |

## What is stored, why, and for how long

| Table | Contents | Why | Retention |
|---|---|---|---|
| `Session` | Access tokens (offline and per-staff online), shop, staff name/email | Required by Shopify authentication | Online: until expiry. All deleted on uninstall. |
| `Operation` | Run type, parameters, filter snapshot, counts, staff display name, timestamps | Run history | Newest N runs per shop (default 25, configurable); running runs never pruned |
| `OperationTarget` | Product ID, and per product: result, message, SKU, title, and the before/after state of **only the fields the run touched** (stock flags, or attribute metafields) | Per-product results and Put back | Deleted with its run |
| `DryRunItem` | Per product with typed attributes: ID, title, SKU, status, planned conversion | Conversion review and signatures | Replaced by the next dry run; pruned with its run |
| `ShopConfig` | Settings and conversion decisions | Configuration | Until shop redact |
| `LocalValueCache` | Local attribute values in use and counts | Filter dropdowns | 12 hours; cleared after any attribute change |
| `WebhookEvent` | Webhook ID, shop, topic | De-duplicating deliveries | 30 days |

Full product records are never stored; fingerprints are computed in memory and discarded.

## Deletion

- **App uninstalled**: sessions (tokens) deleted immediately; running jobs stopped.
- **`shop/redact`** (48 hours after uninstall): every row for the shop is deleted.
- **`customers/data_request`, `customers/redact`**: acknowledged; the app holds no customer data.

## Data retained after uninstall

Only until `shop/redact`, so that a store reinstalling within 48 hours keeps its run history and can still put runs back.
