# Shopify data mapping

How each WooCommerce concept used by v1.3.9 is represented in Shopify, and why.

## Products and variants

- A WooCommerce **simple** product is a Shopify product with only its default variant (`hasOnlyDefaultVariant`).
- A **variable** product is a Shopify product with several variants. As in v1.3.9, these are **left alone** by stock, attribute and conversion operations (setting *Leave products with variants alone*, on by default). Product options define variants, so the app never writes them.
- **SKU** is a variant field. SKU filters match any variant's SKU exactly; the result row lists every variant SKU.

## Stock status

WooCommerce stores a stock status on products that do not manage stock. Shopify has no status field. Its sellability comes from each variant's inventory item being **tracked** or not, the **inventory policy** ("continue selling when out of stock"), and available quantity.

| WooCommerce status | Shopify state the app writes | Customer sees |
|---|---|---|
| In stock | inventory **not tracked** | always purchasable |
| Out of stock | **tracked**, policy **DENY**, zero quantity | sold out |
| On backorder | **tracked**, policy **CONTINUE**, zero quantity | purchasable with no stock |

Reading it back, a variant is `instock` if untracked or if it has available quantity, otherwise `onbackorder`/`outofstock` by policy. A multi-variant product is in stock if any variant is, then on backorder if any is, otherwise out of stock (WooCommerce's rule for a variable parent). This is used only for the filter.

**Quantity-managed protection.** WooCommerce skipped products with *manage stock* on. The equivalent here is a tracked variant that holds any quantity (on hand or available ≠ 0) at any location: its status is decided by the quantity, so it is **skipped** with "Change the quantity instead". A tracked variant at zero everywhere is only a status, so it can be switched **without any quantity being written**. The app never calls an inventory quantity mutation.

Writes: `productVariantsBulkUpdate` (policy), then `inventoryItemUpdate` (tracked). Put back restores both flags, and only if the variant is still exactly as the run left it.

## Attributes

| v1.3.9 | Shopify | Why |
|---|---|---|
| Global attribute (`pa_colour`) | Product metafield **definition** of type `single_line_text_field` or `list.single_line_text_field` that has a **choices** validation | A fixed, shared list of allowed values is what a WooCommerce taxonomy gives; Shopify enforces the choices itself. |
| Global attribute term | One of the definition's choices | "Never create terms" becomes "only existing choices". |
| Local (custom) attribute | Product metafield of the same text types in a **local namespace** (default `cartovum_local`, configurable) that is not a global definition | Free text, per product, like WooCommerce's custom attributes. Metafields owned by other apps (`app--…`) and other namespaces are never read or written. |
| Attribute label | Definition name (global); metafield key (local) | Names are compared ignoring case and punctuation: `Rim Size` = `rim_size`. |
| "Used for variations" | A product option of the same name | Blocks attribute edits and conversion for that product. |
| Position / visibility per product | — | Shopify metafields have no per-product order or visibility (storefront visibility is set on the definition). Nothing to preserve. |

A metafield keeps its type: a single-value metafield is never turned into a list (the change is skipped with the reason).

## Categories → collections

Category filtering uses `collection_id`. Collections are flat, so there is no "include child categories".

## Product status

`publish`/`draft`/`pending`/`private` become Shopify's `ACTIVE`/`DRAFT`/`ARCHIVED`/`UNLISTED`. The staged-conversion setting uses these.

## What the app stores

See [PRIVACY_DATA_MODEL.md](PRIVACY_DATA_MODEL.md). In short: per run, per product, the before/after state of only the fields the run touched (stock flags, or the attribute metafields), which is what Put back needs.
