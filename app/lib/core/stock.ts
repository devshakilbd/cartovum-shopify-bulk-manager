import type { Gateway } from "./gateway";
import { GatewayError } from "./gateway";
import { fingerprint, isMultiVariant, isQuantityManaged, primarySku, unexpectedChanges, variantStockStatus } from "./fingerprint";
import type { ProductState, ResultRow, ShopSettings, StockStatus, VariantState } from "./types";
import { STOCK_STATUSES } from "./types";

/**
 * Bulk stock status (v1.3.9 SWBM_Stock).
 *
 * WooCommerce stock status -> Shopify inventory, on a product's single variant:
 *   In stock      inventory not tracked (always sellable)
 *   Out of stock  tracked, zero quantity, "continue selling when out of stock" off (DENY)
 *   On backorder  tracked, zero quantity, "continue selling" on (CONTINUE)
 * Quantities are never written. A variant that holds quantity is quantity-managed and skipped, exactly as
 * v1.3.9 skipped products with "manage stock" on. Multi-variant products are skipped like variable products.
 */

export interface StockSnapshot {
  variantId: string;
  inventoryItemId: string;
  tracked: boolean;
  policy: "DENY" | "CONTINUE";
  stock_status: StockStatus;
}

/** Called with the recorded before-state just before a write, so an interrupted write can be reconciled. */
export type BeforeWrite = (before: unknown) => Promise<void>;

export const snap = (v: VariantState): StockSnapshot => ({
  variantId: v.id,
  inventoryItemId: v.inventoryItemId,
  tracked: v.tracked,
  policy: v.inventoryPolicy,
  stock_status: variantStockStatus(v),
});

const target = (status: StockStatus): { tracked: boolean; policy?: "DENY" | "CONTINUE" } =>
  status === "instock" ? { tracked: false } : { tracked: true, policy: status === "onbackorder" ? "CONTINUE" : "DENY" };

export const row = (p: ProductState | null, id: string, status: ResultRow["status"], message: string, before?: unknown, after?: unknown): ResultRow => ({
  id,
  sku: p ? primarySku(p) : "",
  name: p ? p.title : "",
  status,
  message,
  ...(before !== undefined ? { before } : {}),
  ...(after !== undefined ? { after } : {}),
});

async function readOne(gw: Gateway, id: string) {
  return (await gw.getProducts([id]))[0] ?? null;
}

/** Writes the tracked flag and policy needed, then verifies by reading back. */
async function write(gw: Gateway, product: ProductState, variant: VariantState, wanted: { tracked: boolean; policy?: "DENY" | "CONTINUE" }, restorePolicy?: "DENY" | "CONTINUE") {
  let error: GatewayError | Error | null = null;
  try {
    if (wanted.tracked && wanted.policy && variant.inventoryPolicy !== wanted.policy) {
      await gw.setInventoryPolicy(product.id, variant.id, wanted.policy);
    }
    if (variant.tracked !== wanted.tracked) await gw.setInventoryTracked(variant.inventoryItemId, wanted.tracked);
    if (restorePolicy && variant.inventoryPolicy !== restorePolicy) await gw.setInventoryPolicy(product.id, variant.id, restorePolicy);
  } catch (e) {
    error = e as Error;
  }
  return error;
}

export async function applyStockOne(gw: Gateway, id: string, status: StockStatus, settings: ShopSettings, beforeWrite?: BeforeWrite): Promise<ResultRow> {
  const product = await readOne(gw, id);
  if (!product) return row(null, id, "failed", "Product not found.");

  if (isMultiVariant(product) && settings.protectMultiVariantProducts) {
    return row(product, id, "skipped", "Product with variants: its stock status comes from each variant, so it was left alone.");
  }
  const variant = product.variants[0];
  if (!variant) return row(product, id, "failed", "Product has no variant to hold stock.");

  if (isQuantityManaged(variant)) {
    return row(product, id, "skipped", "Quantity-managed inventory: this variant tracks a stock quantity, so Shopify decides the status from the quantity. Change the quantity instead.");
  }

  const beforeState = variantStockStatus(variant);
  if (beforeState === status) return row(product, id, "skipped", "Already set to this stock status.");

  const before = snap(variant);
  const fpBefore = fingerprint(product);
  await beforeWrite?.(before);
  const error = await write(gw, product, variant, target(status));

  const fresh = await readOne(gw, id).catch(() => null);
  if (!fresh) {
    return row(product, id, "failed", error ? `Shopify rejected the change: ${error.message}` : "Saved, but the product could not be read back to confirm it.", before, error ? undefined : before);
  }
  const freshVariant = fresh.variants.find((v) => v.id === variant.id);
  if (!freshVariant) return row(product, id, "failed", "The variant disappeared during the change.", before, before);
  const after = snap(freshVariant);
  const wrote = after.tracked !== before.tracked || after.policy !== before.policy;

  if (error && !wrote) return row(product, id, "failed", `Shopify rejected the change: ${error.message}`);
  if (after.stock_status !== status) {
    return row(product, id, "failed", `The change did not stick: the product still reads as ${after.stock_status}.${error ? ` Shopify said: ${error.message}` : ""}`, before, wrote ? after : undefined);
  }
  const unexpected = unexpectedChanges(fpBefore, fingerprint(fresh), ["stock_status", "inventory"]);
  // The inventory key may only differ in the tracked flag and policy of this one variant.
  const otherInventory = fresh.variants.some((v) => {
    const old = product.variants.find((o) => o.id === v.id);
    return !old || JSON.stringify(v.levels) !== JSON.stringify(old.levels);
  });
  if (otherInventory) unexpected.push("inventory quantities");
  if (unexpected.length) {
    return row(product, id, "failed", `Stock status changed, but these fields changed too and should not have: ${unexpected.join(", ")}`, before, after);
  }
  return row(product, id, "changed", `${before.stock_status} to ${after.stock_status}`, before, after);
}

export async function applyStock(gw: Gateway, ids: string[], status: StockStatus, settings: ShopSettings) {
  if (!STOCK_STATUSES.includes(status)) return [];
  const out: ResultRow[] = [];
  for (const id of ids) out.push(await applyStockOne(gw, id, status, settings));
  return out;
}

/** Put back (v1.3.9 SWBM_Stock::revert): only where the product is still exactly as the run left it. */
export async function revertStockOne(gw: Gateway, recorded: ResultRow, beforeWrite?: BeforeWrite): Promise<ResultRow> {
  const before = recorded.before as StockSnapshot | undefined;
  const after = recorded.after as StockSnapshot | undefined;
  const product = await readOne(gw, recorded.id);
  if (!product || !before || !after) return row(product, recorded.id, "failed", "Nothing to put back for this product.");

  const variant = product.variants.find((v) => v.id === before.variantId);
  if (!variant) return row(product, recorded.id, "failed", "The variant this run changed no longer exists.");
  const now = snap(variant);
  if (now.tracked !== after.tracked || now.policy !== after.policy || now.stock_status !== after.stock_status) {
    return row(product, recorded.id, "skipped", `Changed since that run, so it was left as it is. Expected: ${after.stock_status}. Current: ${now.stock_status}.`);
  }
  if (isQuantityManaged(variant)) return row(product, recorded.id, "skipped", "Quantity has been added since that run, so it was left as it is.");

  const fpBefore = fingerprint(product);
  await beforeWrite?.(now);
  const error = await write(gw, product, variant, { tracked: before.tracked, policy: before.tracked ? before.policy : undefined }, before.tracked ? undefined : before.policy);
  const fresh = await readOne(gw, recorded.id).catch(() => null);
  const freshVariant = fresh?.variants.find((v) => v.id === variant.id);
  if (!fresh || !freshVariant) return row(product, recorded.id, "failed", error ? `Shopify rejected the change: ${error.message}` : "Saved, but the product could not be read back to confirm it.");
  const restored = snap(freshVariant);
  if (restored.tracked !== before.tracked || restored.policy !== before.policy) {
    return row(product, recorded.id, "failed", `Could not put it back.${error ? ` Shopify said: ${error.message}` : ""}`, now, restored);
  }
  const unexpected = unexpectedChanges(fpBefore, fingerprint(fresh), ["stock_status", "inventory"]);
  if (unexpected.length) return row(product, recorded.id, "failed", `Put back, but these fields changed too: ${unexpected.join(", ")}`, now, restored);
  return row(product, recorded.id, "changed", `Put back: ${now.stock_status} to ${restored.stock_status}`, now, restored);
}
