import type { Gateway } from "./gateway";
import { productStockStatus } from "./fingerprint";
import type { AttributeCondition, Filters, ProductState, ProductStatus, StockStatus } from "./types";
import { MAX_CONDITIONS, MAX_SKUS, MAX_TAGS, PRODUCT_STATUSES, STOCK_STATUSES } from "./types";

/**
 * Filters (v1.3.9 SWBM_Query). Input from the browser is never trusted: everything is parsed into a
 * closed shape here, and Shopify search strings are built only from escaped values.
 *
 * Semantics kept from v1.3.9:
 * - name search, SKU list (one per line or comma separated, up to 500), category (collection),
 *   stock status, product status;
 * - added for Shopify: product type (exact, ignoring case) and tags (the product must carry every one);
 * - up to 10 attribute conditions, combined with AND: a product must match every one;
 * - a condition with no value means "has this attribute"; a value is compared case-insensitively.
 */

const GID = /^gid:\/\/shopify\/[A-Za-z]+\/\d+$/;
export const isGid = (value: unknown, type?: string): value is string =>
  typeof value === "string" && GID.test(value) && (!type || value.startsWith(`gid://shopify/${type}/`));

const str = (v: unknown, max = 255) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function parseConditions(raw: unknown): AttributeCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: AttributeCondition[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const attribute = str((c as Record<string, unknown>).attribute, 200);
    if (!/^(option:.+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(attribute)) continue;
    out.push({ attribute, value: str((c as Record<string, unknown>).value) });
    if (out.length >= MAX_CONDITIONS) break;
  }
  return out;
}

export function parseFilters(raw: Record<string, unknown>): Filters {
  const skus = str(raw.skus, 20000)
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SKUS);
  const perPage = Number(raw.perPage);
  return {
    search: str(raw.search),
    skus,
    collectionId: isGid(raw.collectionId, "Collection") ? raw.collectionId : "",
    productType: str(raw.productType),
    tags: [...new Set(str(raw.tags, 2000).split(",").map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TAGS),
    stockStatus: STOCK_STATUSES.includes(raw.stockStatus as StockStatus) ? (raw.stockStatus as StockStatus) : "",
    status: PRODUCT_STATUSES.includes(raw.status as ProductStatus) ? (raw.status as ProductStatus) : "",
    conditions: parseConditions(raw.conditions),
    perPage: [25, 50, 100, 200].includes(perPage) ? perPage : 50,
  };
}

/**
 * A stored filter snapshot, completed with defaults for fields added later (product type, tags), so a
 * run saved before a field existed still resolves exactly as it did.
 */
export function normaliseFilters(f: Partial<Filters>): Filters {
  return { search: "", skus: [], collectionId: "", productType: "", tags: [], stockStatus: "", status: "", conditions: [], perPage: 50, ...f };
}

/** Quote a value for Shopify search syntax. Backslashes and quotes are escaped; nothing else is interpreted. */
export function quote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * The server-side narrowing query sent to Shopify. It may match more than the filters do (search is
 * fuzzy, stock is derived); matches() below is the exact, final test, as v1.3.9 confirmed LIKE matches
 * in PHP.
 */
export function shopifyQuery(f: Filters): string {
  const parts: string[] = [];
  if (f.search) parts.push(`title:*${f.search.replace(/[\\"():*]/g, " ").trim()}*`);
  if (f.skus.length) parts.push("(" + f.skus.map((s) => `sku:${quote(s)}`).join(" OR ") + ")");
  if (f.collectionId) parts.push(`collection_id:${f.collectionId.split("/").pop()}`);
  if (f.productType) parts.push(`product_type:${quote(f.productType)}`);
  for (const tag of f.tags) parts.push(`tag:${quote(tag)}`);
  if (f.status) parts.push(`status:${f.status.toLowerCase()}`);
  // Attribute conditions are not sent: metafield search only works for definitions with admin filtering
  // switched on, and would silently match nothing otherwise. They are applied exactly by matches().
  return parts.join(" AND ");
}

/** True when shopifyQuery() matches exactly what matches() does, so Shopify's own count is the total. */
export function queryIsExact(f: Filters): boolean {
  // Product type and tag are sent to Shopify but confirmed here too, so they are not counted as exact.
  return !f.search && !f.stockStatus && !f.productType && !f.tags.length && f.conditions.length === 0;
}

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function matchesCondition(p: ProductState, c: AttributeCondition): boolean {
  if (c.attribute.startsWith("option:")) {
    const option = p.options.find((o) => eq(o.name, c.attribute.slice(7)));
    return !!option && (!c.value || option.values.some((v) => eq(v, c.value)));
  }
  const attribute = p.attributes.find((a) => a.key === c.attribute);
  return !!attribute && attribute.values.length > 0 && (!c.value || attribute.values.some((v) => eq(v, c.value)));
}

export function matches(p: ProductState, f: Filters): boolean {
  if (f.search && !p.title.toLowerCase().includes(f.search.toLowerCase())) return false;
  if (f.skus.length && !p.variants.some((v) => f.skus.some((s) => v.sku === s))) return false;
  if (f.collectionId && !p.collectionIds.includes(f.collectionId)) return false;
  if (f.productType && !eq(p.productType, f.productType)) return false;
  if (f.tags.length && !f.tags.every((t) => p.tags.some((pt) => eq(pt, t)))) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.stockStatus && productStockStatus(p) !== f.stockStatus) return false;
  return f.conditions.every((c) => matchesCondition(p, c));
}

/* ------------------------------------------------------------------ paging */


const CURSOR = /^[\w=+/-]*\|\d{1,3}$/;

/**
 * One page of matching products. Shopify pages are cursor based, and some filters are confirmed here
 * rather than by Shopify, so the cursor records Shopify's cursor plus the position reached inside that
 * page. At most maxScan products are read per request; the page may then be short, with a next cursor.
 */
export async function searchPage(gw: Gateway, f: Filters, cursor: string | null, maxScan = 2000) {
  const valid = cursor && CURSOR.test(cursor) ? cursor : "|0";
  let after: string | null = valid.split("|")[0] || null;
  let skip = Number(valid.split("|")[1]);
  const query = shopifyQuery(f);
  const items: ProductState[] = [];
  let scanned = 0;
  for (;;) {
    const page = await gw.searchProducts(query, 25, after);
    for (let i = skip; i < page.products.length; i++) {
      if (items.length === f.perPage) return { items, next: `${after ?? ""}|${i}` };
      if (matches(page.products[i], f)) items.push(page.products[i]);
    }
    skip = 0;
    scanned += page.products.length;
    if (!page.hasNextPage || !page.endCursor) return { items, next: null };
    after = page.endCursor;
    if (items.length === f.perPage || scanned >= maxScan) return { items, next: `${after}|0` };
  }
}
