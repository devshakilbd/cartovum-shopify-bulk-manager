import type { Gateway } from "./gateway";
import { attributeSignature, fingerprint, hash, isMultiVariant, unexpectedChanges } from "./fingerprint";
import { normaliseName } from "./attributes";
import { row, type BeforeWrite } from "./stock";
import type { AttributeValue, GlobalAttributeDefinition, ProductState, ResultRow, ShopSettings } from "./types";

/**
 * Converting typed (local) attributes into the shared (global) attribute of the same name
 * (v1.3.9 SWBM_Convert). Nothing here guesses. A typed value moves to a shared value only when:
 *
 * - it matches exactly one shared value once units and quotes are set aside
 *   (18 matches 18", 112 matches 112mm, 57.1 matches 57.1 but never 57.10 or 57.2), or
 * - an approved mapping maps that specific value, or
 * - it matches a planned new value (shown as "to be created" until it exists in the definition's choices).
 *
 * A held value, a value with no match, or a value matching more than one shared value blocks the whole
 * product: it is left exactly as it is and reported.
 */

export interface Decisions {
  /** Approved non-exact mappings: [globalKey][typedValue] = shared value (must still be a choice). */
  overrides: Record<string, Record<string, string>>;
  /** Held values: [globalKey][typedValue] = reason. */
  holds: Record<string, Record<string, string>>;
  /** Planned new shared values approved for creation: [globalKey] = values. */
  planned: Record<string, string[]>;
  /** Shared values created for the migration, so reports can tell new values from existing ones. */
  newValues: Record<string, string[]>;
}

export const EMPTY_DECISIONS: Decisions = { overrides: {}, holds: {}, planned: {}, newValues: {} };

export interface Pair {
  local: string;
  global: GlobalAttributeDefinition;
}

export type Kind = "exact" | "override" | "held" | "ambiguous" | "unmapped" | "planned";

export interface Resolution {
  kind: Kind;
  ok: boolean;
  term: string;
  newTerm: boolean;
  note: string;
}

export interface PlanRow {
  attribute: string;
  globalKey: string;
  globalType: AttributeValue["type"];
  localKey: string;
  current: string;
  new: string;
  terms: string[];
  mapping: string;
  newTerm: boolean;
  needsNewTerm: boolean;
  action: "convert" | "drop-duplicate";
  state: "ready" | "blocked" | "needs-approval";
  note: string;
}

export interface ConvertPlan {
  state: "none" | "ready" | "blocked" | "needs-approval" | "skipped";
  rows: PlanRow[];
  note: string;
  signature: string;
}

export function normalise(value: string): string {
  let v = value.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
  v = v.trim().toLowerCase().replace(/["”“″]/g, "").replace(/\s+/gu, "");
  const m = /^(\d+(?:\.\d+)?)(mm|inches|inch|in)?$/.exec(v);
  return m ? m[1] : v;
}

/** Local attributes present on products that pair with a global attribute, by name. */
export function pairsFor(product: ProductState, globals: GlobalAttributeDefinition[]): Pair[] {
  const pairs: Pair[] = [];
  for (const global of globals) {
    const names = [normaliseName(global.label), normaliseName(global.key.split(".")[1])];
    const local = product.attributes.find((a) => a.kind === "local" && names.includes(normaliseName(a.key.split(".")[1])));
    if (local) pairs.push({ local: local.key, global });
  }
  return pairs;
}

export function resolve(global: GlobalAttributeDefinition, value: string, d: Decisions): Resolution {
  const key = global.key;
  const isNew = (term: string) => (d.newValues[key] ?? []).includes(term) || (d.planned[key] ?? []).includes(term);
  const res = (kind: Kind, term: string, note: string): Resolution => ({ kind, ok: kind === "exact" || kind === "override", term, newTerm: term ? isNew(term) : false, note });

  if (d.holds[key]?.[value] !== undefined) return res("held", "", d.holds[key][value] || "Held for a separate decision.");

  const override = d.overrides[key]?.[value];
  if (override !== undefined) {
    return global.choices.includes(override)
      ? res("override", override, "Approved mapping.")
      : res("unmapped", "", "The approved mapping points at a value that no longer exists.");
  }

  const wanted = normalise(value);
  const matches = global.choices.filter((c) => normalise(c) === wanted);
  if (matches.length === 1) return res("exact", matches[0], "");
  if (matches.length > 1) return res("ambiguous", "", `Matches more than one shared value: ${matches.join(", ")}`);

  const planned = (d.planned[key] ?? []).find((p) => normalise(p) === wanted);
  if (planned) return { kind: "planned", ok: true, term: planned, newTerm: true, note: "Approved new value; it has not been created yet." };

  return res("unmapped", "", "No shared value matches.");
}

function planRow(product: ProductState, pair: Pair, d: Decisions): PlanRow {
  const local = product.attributes.find((a) => a.key === pair.local)!;
  const values = local.values.map((v) => v.trim()).filter(Boolean);
  const r: PlanRow = {
    attribute: pair.global.label,
    globalKey: pair.global.key,
    globalType: pair.global.type,
    localKey: pair.local,
    current: values.join(" | "),
    new: "",
    terms: [],
    mapping: "",
    newTerm: false,
    needsNewTerm: false,
    action: "convert",
    state: "ready",
    note: "",
  };

  if (product.options.some((o) => normaliseName(o.name) === normaliseName(pair.global.label))) {
    return { ...r, state: "blocked", note: "Used for variants (a product option), so it is left alone." };
  }
  if (!values.length) return { ...r, state: "blocked", note: "The typed attribute has no value." };

  const resolutions = values.map((v) => ({ v, res: resolve(pair.global, v, d) }));
  const kinds = resolutions.map((x) => x.res.kind);
  const targets = resolutions.filter((x) => x.res.ok || x.res.kind === "planned").map((x) => x.res);
  const notes = resolutions.filter((x) => !x.res.ok && x.res.kind !== "planned").map((x) => `${x.v}: ${x.res.note}`);

  r.terms = targets.map((t) => t.term);
  r.new = r.terms.join(" | ");
  r.newTerm = targets.some((t) => t.newTerm);
  r.needsNewTerm = kinds.includes("planned");

  if (notes.length) {
    const onlyHeld = kinds.includes("held") && !kinds.includes("unmapped") && !kinds.includes("ambiguous");
    return {
      ...r,
      state: onlyHeld ? "needs-approval" : "blocked",
      mapping: kinds.includes("held") ? "awaiting approval" : kinds.includes("ambiguous") ? "ambiguous" : "no match",
      note: notes.join(" "),
    };
  }

  r.mapping = kinds.includes("override") ? "approved mapping" : r.needsNewTerm ? "new value (to be created on approval)" : r.newTerm ? "newly created value" : "exact";

  if (pair.global.type === "single_line_text_field" && r.terms.length > 1) {
    return { ...r, state: "blocked", note: "The shared attribute holds a single value, but the typed attribute has several." };
  }

  const shared = product.attributes.find((a) => a.key === pair.global.key);
  if (shared) {
    if (!r.needsNewTerm && JSON.stringify([...shared.values].sort()) === JSON.stringify([...r.terms].sort())) {
      return { ...r, action: "drop-duplicate", note: "Already shared with the same value, so only the typed copy is removed." };
    }
    return { ...r, state: "blocked", note: "Already has the shared attribute with a different value." };
  }
  return r;
}

export function planProduct(product: ProductState, globals: GlobalAttributeDefinition[], d: Decisions, settings: ShopSettings): ConvertPlan {
  const rows = pairsFor(product, globals).map((pair) => planRow(product, pair, d));
  const plan: ConvertPlan = { state: "none", rows, note: "", signature: hash(attributeSignature(product.attributes)) };
  if (!rows.length) return plan;
  if (isMultiVariant(product) && settings.protectMultiVariantProducts) {
    return { ...plan, state: "skipped", note: "Products with variants are left alone." };
  }
  const states = rows.map((r) => r.state);
  plan.state = states.includes("blocked") ? "blocked" : states.includes("needs-approval") ? "needs-approval" : "ready";
  return plan;
}

export function blockingNote(plan: ConvertPlan): string {
  if (plan.note) return plan.note;
  return plan.rows.filter((r) => r.state !== "ready").map((r) => `${r.attribute}: ${r.note}`).join(" ");
}

/** The attribute list after conversion. */
export function build(product: ProductState, plan: ConvertPlan): { set: AttributeValue[]; remove: string[]; expected: AttributeValue[] } {
  const set: AttributeValue[] = [];
  const remove: string[] = [];
  let expected = [...product.attributes];
  for (const r of plan.rows) {
    remove.push(r.localKey);
    expected = expected.filter((a) => a.key !== r.localKey);
    if (r.action === "drop-duplicate") continue;
    const global = { key: r.globalKey, kind: "global" as const, type: r.globalType, values: r.terms };
    set.push(global);
    expected.push(global);
  }
  return { set, remove, expected };
}

/**
 * Read-back checks for one converted product: the typed copies are gone, the shared attributes hold
 * exactly the planned values, a pre-existing shared attribute (drop-duplicate) is unaltered, and nothing
 * outside the conversion changed or appeared.
 */
export function verify(before: AttributeValue[], after: AttributeValue[], plan: ConvertPlan): string[] {
  const problems: string[] = [];
  const involved = new Set<string>();
  for (const r of plan.rows) {
    involved.add(r.localKey);
    involved.add(r.globalKey);
    if (after.some((a) => a.key === r.localKey)) problems.push(`The typed ${r.attribute} is still there.`);
    const shared = after.find((a) => a.key === r.globalKey);
    if (!shared) {
      problems.push(`The shared ${r.attribute} is missing.`);
      continue;
    }
    if (JSON.stringify([...shared.values].sort()) !== JSON.stringify([...r.terms].sort())) problems.push(`The shared ${r.attribute} holds different values than planned.`);
    if (r.action === "drop-duplicate") {
      const was = before.find((a) => a.key === r.globalKey);
      if (!was || attributeSignature([was]) !== attributeSignature([shared])) problems.push(`The existing shared ${r.attribute} was altered.`);
    }
  }
  for (const b of before) {
    if (involved.has(b.key)) continue;
    const now = after.find((a) => a.key === b.key);
    if (!now || attributeSignature([now]) !== attributeSignature([b])) problems.push(`An attribute outside the conversion changed: ${b.key}.`);
  }
  for (const a of after) {
    if (!involved.has(a.key) && !before.some((b) => b.key === a.key)) problems.push(`An unexpected attribute appeared: ${a.key}.`);
  }
  return problems;
}

export function describe(plan: ConvertPlan): string {
  return plan.rows.map((r) => (r.action === "drop-duplicate" ? `${r.attribute}: typed copy removed (already shared)` : `${r.attribute}: ${r.current} to ${r.new}`)).join("; ");
}

export async function convertOne(gw: Gateway, id: string, signature: string, globals: GlobalAttributeDefinition[], d: Decisions, settings: ShopSettings, beforeWrite?: BeforeWrite): Promise<ResultRow> {
  if (!settings.convertWritesEnabled) return row(null, id, "skipped", "Conversion is switched off for this store (dry run only). Nothing was changed.");
  const product = (await gw.getProducts([id]))[0];
  if (!product) return row(null, id, "failed", "Product not found.");

  const allowed = settings.convertAllowedStatuses;
  if (allowed.length && !allowed.includes(product.status) && !settings.convertAllowedIds.includes(id)) {
    return row(product, id, "skipped", `Only ${allowed.join(", ")} products, and products approved individually, may be converted at this stage; this one is ${product.status} and not on the list, so it was left unchanged.`);
  }

  const plan = planProduct(product, globals, d, settings);
  if (plan.state === "none") return row(product, id, "skipped", "No typed attributes to convert.");
  if (plan.state !== "ready") return row(product, id, "skipped", blockingNote(plan));
  if (plan.rows.some((r) => r.needsNewTerm)) return row(product, id, "skipped", "Needs an approved new value that has not been created yet.");
  if (!signature) return row(product, id, "skipped", "Not in the dry run. Run the dry run first.");
  if (signature !== plan.signature) return row(product, id, "skipped", "Attributes changed since the dry run, so this product was left alone. Run the dry run again.");

  const before = product.attributes;
  const fpBefore = fingerprint(product);
  const { set, remove } = build(product, plan);
  await beforeWrite?.(before);
  let error: Error | null = null;
  try {
    await gw.writeAttributes(id, set, remove);
  } catch (e) {
    error = e as Error;
  }
  const fresh = (await gw.getProducts([id]).catch(() => []))[0];
  if (!fresh) return row(product, id, "failed", error ? `Shopify rejected the change: ${error.message}` : "Saved, but the product could not be read back to confirm it.", before, before);
  const wrote = attributeSignature(fresh.attributes) !== attributeSignature(before);
  if (error && !wrote) return row(product, id, "failed", `Shopify rejected the change: ${error.message}`);

  const problems = [
    ...verify(before, fresh.attributes, plan),
    ...unexpectedChanges(fpBefore, fingerprint(fresh), ["attributes"]).map((f) => `${f} changed and should not have.`),
  ];
  if (problems.length) return row(product, id, "failed", problems.join(" ") + (error ? ` Shopify said: ${error.message}` : ""), before, fresh.attributes);
  return row(product, id, "changed", describe(plan), before, fresh.attributes);
}
