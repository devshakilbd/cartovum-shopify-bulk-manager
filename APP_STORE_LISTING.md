# App Store listing — draft for review

Everything here describes behaviour verified on the development store (see FUNCTIONAL_TEST_REPORT.md). Review and adjust before entering it in the Partner Dashboard listing.

## Basics

| Field | Draft |
|---|---|
| App name | Cartovum Bulk Product Manager |
| Tagline | Bulk-edit stock status and attributes safely — every change checked and reversible |
| Category | Store management → Product management (or: Inventory management) |
| Pricing | *decision* — no billing is implemented (free, or add a plan before submission) |
| App URL | https://app.cartovumagency.com |
| Privacy policy URL | https://app.cartovumagency.com/privacy |
| Terms of service URL | https://app.cartovumagency.com/terms |
| Support | https://app.cartovumagency.com/support → https://cartovumagency.com/contact/ |
| Support email | *needed* — the listing requires an email address |

## Description

Find the products you need, select them — page by page or every match — and change their stock status or one attribute across all of them, without losing control.

- **Find precisely.** Search by name and SKU, filter by collection, product type, tags, status and stock status, and combine up to ten attribute conditions.
- **Select at scale.** Select all matching products in one click; the selection is resolved on the server, across every page.
- **Stock status in bulk.** Set In stock, Out of stock or On backorder. Quantities are never written; products whose quantity decides their stock, and products with variants, are skipped and reported.
- **Attributes in bulk.** Add, remove or replace values of shared attributes (metafield definitions with preset choices), remove an attribute, or set a free-text value. Only existing choices can be used — typos never create new values.
- **Convert free-text attributes to shared ones.** A dry run shows current → planned values; approve mappings, hold values, and convert only what is ready. Download the dry run as CSV.
- **Safe by design.** Changes run in batches of 10 in the background. Every product is read back after its change and compared field by field; anything unexpected is reported as a failure. Every run can be put back — and a product edited since the run is left alone, never overwritten.
- **A full history.** Every run records who ran it, what it did, and the result and reason for every product.

## Screenshots needed (1600 × 900)

1. Products: filters with two attribute conditions and results
2. Review dialog before a run (preview of changes)
3. Run in progress / completed with changed · skipped · failed and reasons
4. Run history with Put Back
5. Attribute conversion: dry-run review (current → planned)

These are taken inside Shopify admin on the development store, after the production-style data is in place. *Needs a logged-in admin session* — the owner takes them, or signs in to the in-app browser for the assistant to capture them.

## Scopes justification (for the review form)

| Scope | Why |
|---|---|
| `write_products` | Read and filter products, variants, collections, types, tags and product metafields; write product metafields (attributes) and each variant's "continue selling when out of stock" setting (stock status). |
| `write_inventory` | Read inventory tracking and quantities (to derive stock status and protect quantity-managed products); switch inventory tracking on or off (stock status). Quantities are never changed. |

No customer, order or other scopes are requested.

## Data and privacy disclosure

Catalogue data only. Stored: sessions (access tokens, staff name/email from Shopify), run history (before/after of only the fields each run changed), settings. No customer personal data. Deleted: tokens on uninstall; all store data on `shop/redact` (48 h after uninstall). Mandatory compliance webhooks are implemented and were tested with signed deliveries.

## Review notes to include

- Test store / instructions: install, open the app, use *Products* to filter by a collection and select all, set stock status on an untracked product, open *Run history* and *Put Back*.
- The app changes product data only when the merchant confirms a run.
