import type { Gateway } from "./gateway";
import { GatewayError } from "./gateway";
import type { AttributeValue, GlobalAttributeDefinition, ProductState } from "./types";

/**
 * An in-memory Shopify. Mirrors the rules that matter to the engine (choices validation, metafield
 * type immutability) and lets tests inject failures: timeouts, rejected writes, writes that land but
 * report an error, concurrent edits, deletions, and stray side effects.
 */
export type Hook = (call: string, args: unknown[]) => void | Promise<void>;

export class MemoryGateway implements Gateway {
  products = new Map<string, ProductState>();
  globals: GlobalAttributeDefinition[] = [];
  collections: { id: string; title: string }[] = [];
  calls: string[] = [];
  /** Runs before each call; throw to fail it. */
  before: Hook | null = null;
  /** Runs after a write has been applied; throw to simulate "applied but reported as failed". */
  after: Hook | null = null;

  constructor(products: ProductState[] = [], globals: GlobalAttributeDefinition[] = []) {
    for (const p of products) this.products.set(p.id, structuredClone(p));
    this.globals = globals;
  }

  private async enter(call: string, args: unknown[]) {
    this.calls.push(call);
    await this.before?.(call, args);
  }

  async searchProducts(query: string, first: number, after: string | null) {
    await this.enter("searchProducts", [query, first, after]);
    const all = [...this.products.values()].filter((p) => this.shopifyWouldReturn(p, query)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const start = after ? Number(after) : 0;
    const products = all.slice(start, start + first).map((p) => structuredClone(p));
    const next = start + first;
    return { products, endCursor: next < all.length ? String(next) : null, hasNextPage: next < all.length };
  }
  /**
   * The parts of Shopify's product search the app relies on, as documented:
   * - with no status clause only ACTIVE products are returned ("Default: active");
   * - `title:word*` matches titles with a word starting with "word" (trailing wildcard);
   * - a leading wildcard is not documented, so `title:*…` is treated as matching nothing.
   * Other clauses are ignored, which returns more, never fewer, products: the app confirms every match.
   */
  private shopifyWouldReturn(p: ProductState, raw: string): boolean {
    // Quoted values are literal text in Shopify's syntax, so clauses are only looked for outside them.
    const query = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
    const statuses = [...query.matchAll(/status:([a-z]+)/g)].map((m) => m[1].toUpperCase());
    if (!(statuses.length ? statuses : ["ACTIVE"]).includes(p.status)) return false;
    const titleWords = p.title.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u);
    for (const m of query.matchAll(/title:(\S+)/g)) {
      if (m[1].startsWith("*")) return false;
      const prefix = m[1].replace(/\*$/, "");
      if (!titleWords.some((w) => (m[1].endsWith("*") ? w.startsWith(prefix) : w === prefix))) return false;
    }
    return true;
  }

  async getProducts(ids: string[]) {
    await this.enter("getProducts", [ids]);
    return ids.map((id) => this.products.get(id)).filter((p): p is ProductState => !!p).map((p) => structuredClone(p));
  }
  async getGlobalAttributes() {
    return structuredClone(this.globals);
  }
  async getLocalAttributeValues() {
    const out: Record<string, { value: string; count: number }[]> = {};
    for (const p of this.products.values())
      for (const a of p.attributes)
        if (a.kind === "local")
          for (const v of a.values) {
            const list = (out[a.key] ??= []);
            const hit = list.find((x) => x.value === v);
            if (hit) hit.count++;
            else list.push({ value: v, count: 1 });
          }
    return out;
  }
  async getCollections() {
    return this.collections;
  }
  async getProductTypes() {
    return [...new Set([...this.products.values()].map((p) => p.productType).filter(Boolean))].sort();
  }
  async getProductTags() {
    return [...new Set([...this.products.values()].flatMap((p) => p.tags))].sort();
  }

  private variant(inventoryItemId: string) {
    for (const p of this.products.values()) for (const v of p.variants) if (v.inventoryItemId === inventoryItemId) return v;
    throw new GatewayError("Inventory item not found.");
  }

  async setInventoryTracked(inventoryItemId: string, tracked: boolean) {
    await this.enter("setInventoryTracked", [inventoryItemId, tracked]);
    this.variant(inventoryItemId).tracked = tracked;
    await this.after?.("setInventoryTracked", [inventoryItemId, tracked]);
  }
  async setInventoryPolicy(productId: string, variantId: string, policy: "DENY" | "CONTINUE") {
    await this.enter("setInventoryPolicy", [productId, variantId, policy]);
    const v = this.products.get(productId)?.variants.find((x) => x.id === variantId);
    if (!v) throw new GatewayError("Variant not found.");
    v.inventoryPolicy = policy;
    await this.after?.("setInventoryPolicy", [productId, variantId, policy]);
  }
  async writeAttributes(productId: string, set: AttributeValue[], remove: string[]) {
    await this.enter("writeAttributes", [productId, set, remove]);
    const p = this.products.get(productId);
    if (!p) throw new GatewayError("Product not found.");
    for (const a of set) {
      const g = this.globals.find((x) => x.key === a.key);
      if (g && a.values.some((v) => !g.choices.includes(v))) throw new GatewayError(`Value is not one of the allowed choices for ${a.key}.`);
      const existing = p.attributes.find((x) => x.key === a.key);
      if (existing && existing.type !== a.type) throw new GatewayError("The metafield type can't be changed.");
    }
    p.attributes = p.attributes.filter((a) => !remove.includes(a.key) && !set.some((s) => s.key === a.key)).concat(set.map((a) => structuredClone(a)));
    await this.after?.("writeAttributes", [productId, set, remove]);
  }
}

/* -------------------------------------------------------------------- fixtures */

let n = 0;
export function makeProduct(over: Partial<ProductState> & { sku?: string; tracked?: boolean; onHand?: number; policy?: "DENY" | "CONTINUE" } = {}): ProductState {
  const id = over.id ?? `gid://shopify/Product/${++n}`;
  const num = id.split("/").pop();
  const { sku, tracked, onHand, policy, ...rest } = over;
  return {
    id,
    title: `Product ${num}`,
    handle: `product-${num}`,
    status: "ACTIVE",
    vendor: "Cartovum",
    productType: "Wheel",
    tags: [],
    descriptionHash: "d",
    templateSuffix: "",
    categoryId: "",
    collectionIds: [],
    mediaIds: [],
    options: [{ name: "Title", values: ["Default Title"] }],
    hasOnlyDefaultVariant: true,
    attributes: [],
    variants: [
      {
        id: `gid://shopify/ProductVariant/${num}`,
        title: "Default Title",
        sku: sku ?? `SKU-${num}`,
        price: "10.00",
        compareAtPrice: "",
        barcode: "",
        inventoryPolicy: policy ?? "DENY",
        inventoryItemId: `gid://shopify/InventoryItem/${num}`,
        tracked: tracked ?? false,
        levels: [{ locationId: "gid://shopify/Location/1", onHand: onHand ?? 0, available: onHand ?? 0 }],
        selectedOptions: [{ name: "Title", value: "Default Title" }],
      },
    ],
    ...rest,
  };
}

export function multiVariant(over: Partial<ProductState> = {}): ProductState {
  const p = makeProduct(over);
  const num = p.id.split("/").pop();
  p.hasOnlyDefaultVariant = false;
  p.options = [{ name: "Size", values: ["S", "M"] }];
  p.variants = ["S", "M"].map((size, i) => ({
    ...p.variants[0],
    id: `gid://shopify/ProductVariant/${num}${i}`,
    inventoryItemId: `gid://shopify/InventoryItem/${num}${i}`,
    sku: `SKU-${num}-${size}`,
    title: size,
    selectedOptions: [{ name: "Size", value: size }],
  }));
  return p;
}
