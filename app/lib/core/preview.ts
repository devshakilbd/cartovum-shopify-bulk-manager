import { normaliseName, plan } from "./attributes";
import { isMultiVariant, isQuantityManaged, variantStockStatus } from "./fingerprint";
import { row } from "./stock";
import type { AttributeOp, ProductState, ResultRow, ShopSettings, StockStatus } from "./types";

/**
 * What a run would do to each product, worked out with exactly the rules the run uses, and without
 * writing anything. Shown on the confirmation screen before a destructive run.
 */

export function previewStock(p: ProductState, status: StockStatus, settings: ShopSettings): ResultRow {
  if (isMultiVariant(p) && settings.protectMultiVariantProducts) return row(p, p.id, "skipped", "Product with variants: left alone.");
  const v = p.variants[0];
  if (!v) return row(p, p.id, "failed", "Product has no variant to hold stock.");
  if (isQuantityManaged(v)) return row(p, p.id, "skipped", "Quantity-managed inventory: left alone.");
  const now = variantStockStatus(v);
  if (now === status) return row(p, p.id, "skipped", "Already set to this stock status.");
  return row(p, p.id, "changed", `Would change ${now} to ${status}`);
}

export function previewAttribute(p: ProductState, op: AttributeOp, settings: ShopSettings): ResultRow {
  if (isMultiVariant(p) && settings.protectMultiVariantProducts) return row(p, p.id, "skipped", "Product with variants: left alone.");
  if (p.options.some((o) => normaliseName(o.name) === normaliseName(op.label))) return row(p, p.id, "skipped", `"${op.label}" is a product option here: left alone.`);
  const result = plan(p, op);
  if (result === null) return row(p, p.id, "skipped", "Already as requested; nothing to change.");
  if ("skip" in result) return row(p, p.id, "skipped", result.skip);
  const was = p.attributes.find((a) => a.key === op.attribute)?.values ?? [];
  const now = result.remove.includes(op.attribute) ? [] : result.set.find((a) => a.key === op.attribute)?.values ?? was;
  return row(p, p.id, "changed", `Would change ${op.label}: ${was.join(", ") || "not set"} to ${now.join(", ") || "not set"}`);
}
