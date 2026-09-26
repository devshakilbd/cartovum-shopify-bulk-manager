import type { Gateway } from "./gateway";
import { attributeSignature, fingerprint, isMultiVariant, unexpectedChanges } from "./fingerprint";
import { row, type BeforeWrite } from "./stock";
import type { AttributeOp, AttributeValue, GlobalAttributeDefinition, ProductState, ResultRow, ShopSettings } from "./types";
import { ATTRIBUTE_OPS } from "./types";

/**
 * Bulk attribute edits (v1.3.9 SWBM_Attributes). Rules carried over unchanged:
 *
 * - Global attributes and their values are only ever selected, never created. A value that is not
 *   already one of the definition's choices is refused.
 * - A local attribute is never turned into a global one or the other way round. If a product already has
 *   a local attribute of the same name, adding the global one is skipped.
 * - Attributes the operation does not name are left exactly as they are.
 * - An attribute that drives variants (a product option of the same name), and multi-variant products
 *   as a whole, are left alone.
 * - Removing the last value removes the attribute: an attribute with no values means nothing.
 */

export class OpError extends Error {}

/** "Rim Size", "rim_size" and "rim-size" all name the same attribute. */
export const normaliseName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function parseOp(raw: Record<string, unknown>, globals: GlobalAttributeDefinition[], settings: ShopSettings): AttributeOp {
  const op = String(raw.op ?? "") as AttributeOp["op"];
  const attribute = typeof raw.attribute === "string" ? raw.attribute.trim() : "";
  if (!ATTRIBUTE_OPS.includes(op)) throw new OpError("Unknown attribute operation.");
  if (!attribute) throw new OpError("Choose an attribute first.");

  const namespace = attribute.split(".")[0];
  const global = globals.find((g) => g.key === attribute);
  const isLocal = !global;

  if (isLocal && (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(attribute) || !settings.localNamespaces.includes(namespace))) {
    throw new OpError("That global attribute does not exist. Attributes are never created by this tool.");
  }
  if (isLocal && !["remove_attribute", "set_local_value"].includes(op)) {
    throw new OpError("For a local attribute you can change its value or remove it. Value operations apply to global attributes only.");
  }
  if (!isLocal && op === "set_local_value") throw new OpError("A global attribute takes values from its list, not free text.");

  const terms: string[] = [];
  if (["add_terms", "remove_terms", "set_terms"].includes(op)) {
    const requested = Array.isArray(raw.terms) ? raw.terms : [];
    for (const term of requested) {
      if (typeof term !== "string" || !global!.choices.includes(term)) {
        throw new OpError(`Value "${String(term)}" does not exist for this attribute. Existing values only: this tool never creates new ones.`);
      }
      if (!terms.includes(term)) terms.push(term);
    }
    if (!terms.length && op !== "set_terms") throw new OpError("Choose at least one value.");
  }

  const value = typeof raw.value === "string" ? raw.value.trim().slice(0, 1000) : "";
  if (op === "set_local_value" && !value) throw new OpError('Enter a value. To clear the attribute instead, use "remove attribute".');

  return {
    op,
    attribute,
    isLocal,
    label: global ? global.label : attribute.split(".")[1],
    terms,
    value,
    type: global ? global.type : "list.single_line_text_field",
  };
}

type Plan = { set: AttributeValue[]; remove: string[] } | { skip: string } | null;

/** The change to make, a reason not to (skip), or null when already as requested. */
export function plan(product: ProductState, op: AttributeOp): Plan {
  const current = product.attributes.find((a) => a.key === op.attribute);

  switch (op.op) {
    case "remove_attribute":
      return current ? { set: [], remove: [op.attribute] } : null;

    case "set_local_value": {
      if (!current) return { skip: "This product does not have that local attribute, and this tool does not add local attributes." };
      const options = op.value.split("|").map((s) => s.trim()).filter(Boolean);
      if (JSON.stringify(options) === JSON.stringify(current.values)) return null;
      // A metafield keeps its type, so a single-value attribute cannot suddenly hold a list.
      if (current.type === "single_line_text_field" && options.length > 1) {
        return { skip: "This local attribute holds a single value on this product, so a list of values cannot be set." };
      }
      return { set: [{ ...current, values: options }], remove: [] };
    }
  }

  if (!current) {
    if (op.op === "remove_terms") return null;
    const clash = product.attributes.find((a) => a.kind === "local" && normaliseName(a.key.split(".")[1]) === normaliseName(op.label));
    if (clash) {
      return { skip: `This product already has "${clash.key.split(".")[1]}" as a local attribute. Adding the global one would leave two attributes of the same name, so it was skipped.` };
    }
    if (!op.terms.length) return null;
    if (op.type === "single_line_text_field" && op.terms.length > 1) return { skip: "This attribute holds a single value, so more than one cannot be set." };
    return { set: [{ key: op.attribute, kind: "global", type: op.type, values: op.terms }], remove: [] };
  }

  const have = current.values;
  let result: string[];
  if (op.op === "add_terms") result = [...new Set([...have, ...op.terms])];
  else if (op.op === "remove_terms") result = have.filter((v) => !op.terms.includes(v));
  else result = op.terms;

  if (JSON.stringify([...have].sort()) === JSON.stringify([...result].sort())) return null;
  if (!result.length) return { set: [], remove: [op.attribute] };
  if (current.type === "single_line_text_field" && result.length > 1) return { skip: "This attribute holds a single value on this product, so more than one cannot be set." };
  return { set: [{ ...current, values: result }], remove: [] };
}

const describeValues = (a?: AttributeValue) => (!a ? "not set" : a.values.length ? a.values.join(", ") : "empty");

export async function applyAttributeOne(gw: Gateway, id: string, op: AttributeOp, settings: ShopSettings, beforeWrite?: BeforeWrite): Promise<ResultRow> {
  const product = (await gw.getProducts([id]))[0];
  if (!product) return row(null, id, "failed", "Product not found.");

  if (isMultiVariant(product) && settings.protectMultiVariantProducts) {
    return row(product, id, "skipped", "Product with variants: its options drive its variants, so this tool leaves its attributes alone.");
  }
  if (product.options.some((o) => normaliseName(o.name) === normaliseName(op.label))) {
    return row(product, id, "skipped", `"${op.label}" is a product option on this product (it defines variants), so it was left alone.`);
  }

  const p = plan(product, op);
  if (p === null) return row(product, id, "skipped", "Already as requested; nothing to change.");
  if ("skip" in p) return row(product, id, "skipped", p.skip);

  const before = product.attributes;
  const fpBefore = fingerprint(product);
  await beforeWrite?.(before);
  let error: Error | null = null;
  try {
    await gw.writeAttributes(id, p.set, p.remove);
  } catch (e) {
    error = e as Error;
  }

  const fresh = (await gw.getProducts([id]).catch(() => []))[0];
  if (!fresh) return row(product, id, "failed", error ? `Shopify rejected the change: ${error.message}` : "Saved, but the product could not be read back to confirm it.", before, error ? undefined : before);

  const after = fresh.attributes;
  const wrote = attributeSignature(after) !== attributeSignature(before);
  if (error && !wrote) return row(product, id, "failed", `Shopify rejected the change: ${error.message}`);

  const expected = [...before.filter((a) => a.key !== op.attribute && !p.remove.includes(a.key)), ...p.set];
  if (attributeSignature(after.map((a) => ({ ...a, type: a.type }))) !== attributeSignature(expected)) {
    return row(product, id, "failed", `The attributes do not read back as planned.${error ? ` Shopify said: ${error.message}` : ""}`, before, wrote ? after : undefined);
  }
  const unexpected = unexpectedChanges(fpBefore, fingerprint(fresh), ["attributes"]);
  if (unexpected.length) {
    return row(product, id, "failed", `Attributes changed, but these fields changed too and should not have: ${unexpected.join(", ")}`, before, after);
  }
  const was = before.find((a) => a.key === op.attribute);
  const now = after.find((a) => a.key === op.attribute);
  return row(product, id, "changed", `${op.label}: ${describeValues(was)} to ${describeValues(now)}`, before, after);
}

/**
 * Put attributes back as they were before a run (also used for conversions), only where the product's
 * attributes are still exactly as the run left them.
 */
export async function revertAttributesOne(gw: Gateway, recorded: ResultRow, beforeWrite?: BeforeWrite): Promise<ResultRow> {
  const before = recorded.before as AttributeValue[] | undefined;
  const after = recorded.after as AttributeValue[] | undefined;
  const product = (await gw.getProducts([recorded.id]))[0];
  if (!product || !after || !before) return row(product ?? null, recorded.id, "failed", "Nothing to put back for this product.");

  if (attributeSignature(product.attributes) !== attributeSignature(after)) {
    const diff = describeDiff(after, product.attributes);
    return row(product, recorded.id, "skipped", `Attributes changed since that run, so they were left as they are.${diff ? ` ${diff}` : ""}`);
  }

  const fpBefore = fingerprint(product);
  const remove = product.attributes.filter((a) => !before.some((b) => b.key === a.key)).map((a) => a.key);
  const set = before.filter((b) => {
    const now = product.attributes.find((a) => a.key === b.key);
    return !now || attributeSignature([now]) !== attributeSignature([b]);
  });
  await beforeWrite?.(product.attributes);
  let error: Error | null = null;
  try {
    await gw.writeAttributes(recorded.id, set, remove);
  } catch (e) {
    error = e as Error;
  }
  const fresh = (await gw.getProducts([recorded.id]).catch(() => []))[0];
  if (!fresh) return row(product, recorded.id, "failed", error ? `Shopify rejected the change: ${error.message}` : "Saved, but the product could not be read back to confirm it.");
  if (attributeSignature(fresh.attributes) !== attributeSignature(before)) {
    return row(product, recorded.id, "failed", `Could not put the attributes back exactly.${error ? ` Shopify said: ${error.message}` : ""}`, after, fresh.attributes);
  }
  const unexpected = unexpectedChanges(fpBefore, fingerprint(fresh), ["attributes"]);
  if (unexpected.length) return row(product, recorded.id, "failed", `Put back, but these fields changed too: ${unexpected.join(", ")}`, after, fresh.attributes);
  return row(product, recorded.id, "changed", "Attributes put back as they were.", after, fresh.attributes);
}

/** "Colour — expected: Blue, current: Green" for the first attribute that moved. */
export function describeDiff(expected: AttributeValue[], current: AttributeValue[]): string {
  const keys = new Set([...expected, ...current].map((a) => a.key));
  for (const key of keys) {
    const e = expected.find((a) => a.key === key);
    const c = current.find((a) => a.key === key);
    if (attributeSignature(e ? [e] : []) !== attributeSignature(c ? [c] : [])) {
      return `${key.split(".")[1]} — expected: ${describeValues(e)}; current: ${describeValues(c)}.`;
    }
  }
  return "";
}
