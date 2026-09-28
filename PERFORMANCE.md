# Performance and large catalogues (Phase 11 review)

All numbers below were measured on the development store `cartovum-bulk-dev` (Admin API 2026-07) on 2026-09-28/29, through the app's own background worker.

## Where the time goes

| Measured | Result |
|---|---|
| Product search / select-all page | **10 fully-loaded products per request**, cost ≈874 of Shopify's 1,000-point limit (25 per page cost 1,310 and was refused) |
| Select all matching, 12 products (resolve on the server) | 3–8 s |
| Changing products (read → write → read back → verify), per product | **1.8–2.9 s** (12-product runs: 34.3 s and 22.0 s; Put Back of 10–12: 18–22 s; 34 single-product runs: 2.57 s average) |

The run time is dominated by the per-product safety sequence (fresh read, write, verification read, fingerprint comparison), done one product at a time — not by the 10-per-page search. At the measured rate a run changes roughly **1,200–2,000 products per hour**.

| Catalogue / selection | Select all (resolve) | Change run |
|---|---|---|
| 100 products | seconds | ~3–5 min |
| 1,000 products | ~1 min | ~30–50 min |
| 10,000 products | ~10 min | ~5–8 hours |

Runs work in the background: the merchant can leave the page, stop after the current batch, and Put Back, whatever the size. Nothing times out; progress is saved after every batch of 10.

## Decision for the initial launch

**Acceptable as is.** Correctness and the safety model are unchanged, every run is resumable and stoppable, and the limits are Shopify's (query cost and write rate), not the app's. The App Store has no requirement that bulk edits be faster. Performance is **not** traded for safety.

## Next-stage improvements (not required for launch)

1. **Parallel products within a batch.** Processing the 10 products of a batch concurrently (still read → write → verify each) would cut run time several-fold, within Shopify's rate limits (the actual cost of a product read is far below its requested cost). Largest win; keeps the safety model.
2. **Bulk Operations API for reads.** For select-all and the conversion dry run on catalogues of tens of thousands of products, `bulkOperationRunQuery` would replace the 10-per-page scan. Writes stay per product, because each must be verified.
3. **Lighter search query for listing only.** The Products screen could load fewer nested fields; every write already re-reads the full product before changing it.

## Limitation found while testing

Shopify's product search returns nothing when `collection_id` is combined with a title, SKU or tag clause (measured). The app therefore sends only the collection (plus product type and status) and checks name, SKU and tags itself, which is correct but scans the whole collection. For very large collections combined with those filters, a search page can take longer.
