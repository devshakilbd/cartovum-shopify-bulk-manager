import type { AttributeValue, GlobalAttributeDefinition, ProductState } from "./types";

/**
 * Everything the engine needs from Shopify. The real implementation is GraphQL (gateway.server.ts);
 * tests use MemoryGateway. Writes return nothing useful on purpose: success is only ever decided by
 * reading the product back.
 */
/**
 * Most fully-loaded products one request may ask for. Shopify refuses any query costing over 1,000 points.
 * Measured on cartovum-bulk-dev, API 2026-07, with the unchanged product read (variants 100 × inventory
 * levels 20, metafields 100, media 50, collections 50): a search page of 5 costs ≈656, 10 ≈874, 15 and 20
 * cost 1092, 25 costs 1310; by ID, 25 products cost at most 500. Page sizes are cut rather than the read,
 * so the before/after fingerprint keeps covering every field it covers.
 */
export const SEARCH_PAGE_MAX = 10;
export const IDS_PAGE_MAX = 25;

export interface Gateway {
  /** One page of products matching a Shopify search string, fully loaded. Returns at most SEARCH_PAGE_MAX, whatever `first` asks for. */
  searchProducts(query: string, first: number, after: string | null): Promise<{ products: ProductState[]; endCursor: string | null; hasNextPage: boolean }>;
  /** Fresh reads, bypassing any cache. Missing products are simply absent from the result. */
  getProducts(ids: string[]): Promise<ProductState[]>;
  getGlobalAttributes(): Promise<GlobalAttributeDefinition[]>;
  /** Local attribute keys and their values in use, with product counts. */
  getLocalAttributeValues(): Promise<Record<string, { value: string; count: number }[]>>;
  getCollections(): Promise<{ id: string; title: string }[]>;
  /** Product types and tags in use, for the filter suggestions. */
  getProductTypes(): Promise<string[]>;
  getProductTags(): Promise<string[]>;

  setInventoryTracked(inventoryItemId: string, tracked: boolean): Promise<void>;
  setInventoryPolicy(productId: string, variantId: string, policy: "DENY" | "CONTINUE"): Promise<void>;
  /** Sets (creates or replaces) and deletes attribute metafields on one product in as few calls as possible. */
  writeAttributes(productId: string, set: AttributeValue[], remove: string[]): Promise<void>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    /** True when the request may have reached Shopify, so the outcome must be verified by reading back. */
    readonly uncertain = false,
  ) {
    super(message);
  }
}
