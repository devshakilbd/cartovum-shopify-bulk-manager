import type { AttributeValue, GlobalAttributeDefinition, ProductState } from "./types";

/**
 * Everything the engine needs from Shopify. The real implementation is GraphQL (gateway.server.ts);
 * tests use MemoryGateway. Writes return nothing useful on purpose: success is only ever decided by
 * reading the product back.
 */
export interface Gateway {
  /** One page of products matching a Shopify search string, fully loaded. */
  searchProducts(query: string, first: number, after: string | null): Promise<{ products: ProductState[]; endCursor: string | null; hasNextPage: boolean }>;
  /** Fresh reads, bypassing any cache. Missing products are simply absent from the result. */
  getProducts(ids: string[]): Promise<ProductState[]>;
  getGlobalAttributes(): Promise<GlobalAttributeDefinition[]>;
  /** Local attribute keys and their values in use, with product counts. */
  getLocalAttributeValues(): Promise<Record<string, { value: string; count: number }[]>>;
  getCollections(): Promise<{ id: string; title: string }[]>;

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
