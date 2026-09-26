import { createHash } from "node:crypto";
import type { AttributeValue, ProductState, StockStatus, VariantState } from "./types";

/**
 * The safety net (v1.3.9 SWBM_Guard).
 *
 * Before each write the product is fingerprinted; after the write it is read again and fingerprinted
 * again. Anything that changed but was not meant to change is reported as a failure instead of passing
 * silently. Volatile fields (updatedAt, cursor positions) are deliberately left out.
 */

export type Fingerprint = Record<string, string>;

/** Stable JSON: object keys sorted at every level, so equal data always serialises identically. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

const sorted = (list: string[]) => [...list].sort();

function variantFields(v: VariantState) {
  return {
    id: v.id,
    sku: v.sku,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    barcode: v.barcode,
    options: v.selectedOptions.map((o) => `${o.name}=${o.value}`),
  };
}

function inventoryFields(v: VariantState) {
  return {
    id: v.id,
    tracked: v.tracked,
    policy: v.inventoryPolicy,
    levels: [...v.levels].sort((a, b) => a.locationId.localeCompare(b.locationId)).map((l) => `${l.locationId}:${l.onHand}:${l.available}`),
  };
}

/** Comparable signature of a product's attribute metafields (v1.3.9 SWBM_Attributes::signature). */
export function attributeSignature(attributes: AttributeValue[]): string {
  return canonical(
    [...attributes]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((a) => ({ key: a.key, kind: a.kind, type: a.type, values: sorted(a.values) })),
  );
}

export function fingerprint(p: ProductState): Fingerprint {
  return {
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    productType: p.productType,
    tags: sorted(p.tags).join(","),
    description: p.descriptionHash,
    templateSuffix: p.templateSuffix,
    category: p.categoryId,
    collections: sorted(p.collectionIds).join(","),
    media: p.mediaIds.join(","),
    options: canonical(p.options.map((o) => ({ name: o.name, values: o.values }))),
    variants: canonical(p.variants.map(variantFields)),
    inventory: canonical(p.variants.map(inventoryFields)),
    stock_status: productStockStatus(p),
    attributes: attributeSignature(p.attributes),
  };
}

/** Keys that changed, ignoring those this operation was allowed to change. */
export function unexpectedChanges(before: Fingerprint, after: Fingerprint, allowed: string[]): string[] {
  return Object.keys(before).filter((k) => !allowed.includes(k) && before[k] !== after[k]);
}

/* ------------------------------------------------------------------ stock model */

const onHandZero = (v: VariantState) => v.levels.every((l) => l.onHand === 0 && l.available <= 0);

/**
 * WooCommerce "manage stock" equivalent. A tracked variant holding any quantity has its sellability
 * decided by that quantity, so a status written by this app would not mean anything and is refused.
 * A tracked variant at zero everywhere is only a status, so it can be changed without touching quantity.
 */
export function isQuantityManaged(v: VariantState): boolean {
  return v.tracked && !onHandZero(v);
}

export function variantStockStatus(v: VariantState): StockStatus {
  if (!v.tracked) return "instock";
  const available = v.levels.reduce((sum, l) => sum + l.available, 0);
  if (available > 0) return "instock";
  return v.inventoryPolicy === "CONTINUE" ? "onbackorder" : "outofstock";
}

/** Product-level status, derived for multi-variant products the way WooCommerce derives a variable parent's. */
export function productStockStatus(p: ProductState): StockStatus {
  const states = p.variants.map(variantStockStatus);
  if (states.includes("instock")) return "instock";
  if (states.includes("onbackorder")) return "onbackorder";
  return "outofstock";
}

export function isMultiVariant(p: ProductState): boolean {
  return !p.hasOnlyDefaultVariant || p.variants.length > 1;
}

export function primarySku(p: ProductState): string {
  return p.variants.map((v) => v.sku).filter(Boolean).join(", ");
}
