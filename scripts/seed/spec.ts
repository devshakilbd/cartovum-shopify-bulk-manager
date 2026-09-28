/**
 * The approved development-store test matrix, as data (audit-corrected, 2026-09-28).
 *
 * Everything the seed creates is described here, and nothing else. The same data builds synthetic
 * ProductStates, so the matrix's expected stock states and filter results are checked with the app's own
 * code (fingerprint.ts, filters.ts) before anything is sent to Shopify, and again after, on the real
 * products read back through the app's own gateway.
 *
 * K1 (a Shopify standard category attribute) is NOT seeded: its values are metaobject references and the
 * app has no metaobject scopes. Create it by hand in Shopify admin (see TESTING.md).
 */
import { productStockStatus } from "../../app/lib/core/fingerprint";
import { matches, parseFilters } from "../../app/lib/core/filters";
import type { AttributeValue, ProductState, ProductStatus, StockStatus } from "../../app/lib/core/types";

export const STORE = "cartovum-bulk-dev.myshopify.com";
export const API_VERSION = "2026-07";
/** Every seeded product carries this tag, so it can be found, counted and told apart from anything else. */
export const SEED_TAG = "cbm-seed";
export const LOCAL_NS = "cartovum_local";
export const SHARED_NS = "shared";

type TextType = AttributeValue["type"];
const LIST: TextType = "list.single_line_text_field";
const SINGLE: TextType = "single_line_text_field";

export interface DefinitionSpec {
  key: string;
  name: string;
  type: TextType;
  choices: string[];
}

export const DEFINITIONS: DefinitionSpec[] = [
  { key: "colour", name: "Colour", type: LIST, choices: ["Red", "Blue", "Green", "Crimson", "Black"] },
  { key: "rim_size", name: "Rim Size", type: LIST, choices: ['17"', '18"', '19"', '20"'] },
  // Single value on purpose (A10), and 66.1 / 66.1mm on purpose (C6: ambiguous).
  { key: "centre_bore", name: "Centre Bore", type: SINGLE, choices: ["57.1", "66.1", "66.1mm"] },
  { key: "wheel_year", name: "Wheel Year", type: LIST, choices: ["2023", "2024-Present"] },
];

export const COLLECTIONS = {
  alloy: { handle: "cbm-test-alloy-wheels", title: "Test Alloy Wheels" },
  winter: { handle: "cbm-test-winter-sale", title: "Test Winter Sale" },
} as const;
export type CollectionRef = keyof typeof COLLECTIONS;

/**
 * Shopify's default manual "Home page" collection, present in every new store. On 2026-09-28 Shopify put
 * the store's first product (S1) in it when the seed created it. The seed never writes to it; verify treats
 * membership in it as expected and lists it as a note, while every Test collection must still match exactly.
 */
export const SHOPIFY_HOME_COLLECTION = "frontpage";

/**
 * Compares a product's collections with the matrix. Only Shopify's Home page collection (homeId) is set aside;
 * any other extra or missing collection is a difference.
 */
export function compareCollections(actual: string[], expected: string[], homeId: string | null) {
  const inHome = !!homeId && actual.includes(homeId);
  const got = actual.filter((id) => id !== homeId).sort();
  const want = [...expected].sort();
  return { match: JSON.stringify(got) === JSON.stringify(want), got, want, inHome };
}

export const TYPES = ["Alloy Wheel", "Steel Wheel", "Tyre", "Wheel"] as const;
export const TAGS = [SEED_TAG, "stock-test", "attr-test", "filter-test", "sale", "winter", "batch", "convert-test", "control"] as const;

/** Inventory of one variant. Untracked variants always hold 0 (audit: a stocked untracked variant would fail S1). */
export type Inventory = { tracked: false } | { tracked: true; onHand: number; policy: "DENY" | "CONTINUE" };
const UNTRACKED: Inventory = { tracked: false };
const tracked = (onHand: number, policy: "DENY" | "CONTINUE" = "DENY"): Inventory => ({ tracked: true, onHand, policy });

export interface VariantSpec {
  sku: string;
  /** Option value, for products with variants; omitted for a product with only its default variant. */
  option?: string;
  inventory: Inventory;
}

export interface AttrSpec {
  ns: typeof SHARED_NS | typeof LOCAL_NS;
  key: string;
  type: TextType;
  values: string[];
}

export interface ProductSpec {
  id: string;
  title: string;
  handle: string;
  status: ProductStatus;
  productType: (typeof TYPES)[number];
  tags: string[];
  collections: CollectionRef[];
  /** Name of the option that defines variants, for products with more than one variant. */
  optionName?: string;
  variants: VariantSpec[];
  attributes: AttrSpec[];
  /** What the app should show before any test (checked with the app's own rules). */
  expect: { stock: StockStatus; multiVariant: boolean };
  purpose: string;
  /** Controls must never be selected or changed by a test run. */
  mutationSafe: boolean;
}

const shared = (key: string, ...values: string[]): AttrSpec => ({ ns: SHARED_NS, key, type: DEFINITIONS.find((d) => d.key === key)!.type, values });
const local = (key: string, value: string): AttrSpec => ({ ns: LOCAL_NS, key, type: SINGLE, values: [value] });
const localList = (key: string, ...values: string[]): AttrSpec => ({ ns: LOCAL_NS, key, type: LIST, values });

function product(p: Omit<ProductSpec, "handle" | "title" | "tags" | "mutationSafe" | "expect"> & { tags: string[]; expect?: Partial<ProductSpec["expect"]>; mutationSafe?: boolean }): ProductSpec {
  return {
    ...p,
    title: `CBM Test ${p.id}`,
    handle: `cbm-test-${p.id.toLowerCase()}`,
    tags: [SEED_TAG, ...p.tags],
    mutationSafe: p.mutationSafe ?? true,
    expect: { stock: "instock", multiVariant: p.variants.length > 1, ...p.expect },
  };
}

const simple = (sku: string, inventory: Inventory = UNTRACKED): VariantSpec[] => [{ sku, inventory }];

const stock = (id: string, variants: VariantSpec[], stockState: StockStatus, purpose: string, optionName?: string) =>
  product({ id, status: "ACTIVE", productType: "Alloy Wheel", tags: ["stock-test"], collections: ["alloy"], variants, optionName, attributes: [], expect: { stock: stockState }, purpose });

const attr = (id: string, attributes: AttrSpec[], purpose: string, extra: Partial<Parameters<typeof product>[0]> = {}) =>
  product({ id, status: "ACTIVE", productType: "Alloy Wheel", tags: ["attr-test"], collections: ["alloy"], variants: simple(`CBM-${id}`), attributes, purpose, ...extra });

const convert = (id: string, attributes: AttrSpec[], purpose: string, extra: Partial<Parameters<typeof product>[0]> = {}) =>
  product({ id, status: "ACTIVE", productType: "Wheel", tags: ["convert-test"], collections: [], variants: simple(`CBM-${id}`), attributes, purpose, ...extra });

export const PRODUCTS: ProductSpec[] = [
  // 1. Stock
  stock("S1", simple("CBM-S1"), "instock", "Set Out of stock → tracked on, policy DENY, quantity 0"),
  stock("S2", simple("CBM-S2", tracked(0, "DENY")), "outofstock", "Set On backorder → policy CONTINUE"),
  stock("S3", simple("CBM-S3", tracked(0, "CONTINUE")), "onbackorder", "Set In stock → tracking off, policy stays CONTINUE"),
  stock("S4", simple("CBM-S4", tracked(5)), "instock", "Any stock status → skipped: quantity-managed; quantity stays 5"),
  stock(
    "S5",
    [
      { sku: "CBM-S5-S", option: "S", inventory: tracked(0, "DENY") },
      { sku: "CBM-S5-M", option: "M", inventory: UNTRACKED },
    ],
    "instock",
    "Any stock status → skipped: product with variants",
    "Size",
  ),

  // 2. Attributes
  attr("A1", [shared("colour", "Red")], "Add Blue → [Red, Blue]; Replace with Green → [Green]"),
  attr("A2", [shared("colour", "Red", "Blue")], "Remove Blue → [Red]; Remove Red → attribute removed"),
  attr("A3", [], "Remove Red FIRST → skipped (nothing to change); then Add Blue → [Blue]"),
  attr("A4", [local("colour", "red")], "Add shared Colour → skipped: local/shared clash. Also ready in the conversion dry run: never select it there"),
  attr("A5", [localList("finish", "Gloss")], "Set typed value Matt → [Matt]; then Matt|Satin → [Matt, Satin]"),
  attr("A6", [local("finish", "Gloss")], "Set Matt|Satin → skipped: single value cannot hold a list"),
  attr("A7", [], "Set typed value finish=Matt → skipped: this tool does not add local attributes"),
  attr("A8", [shared("colour", "Green"), local("material", "Aluminium")], "Remove attribute Colour; remove attribute material"),
  attr("A9", [shared("colour", "Red")], "Add Blue → skipped: product with variants", {
    optionName: "Colour",
    variants: [
      { sku: "CBM-A9-R", option: "Red", inventory: UNTRACKED },
      { sku: "CBM-A9-B", option: "Blue", inventory: UNTRACKED },
    ],
    expect: { multiVariant: true },
  }),
  attr("A10", [shared("centre_bore", "57.1")], "Add 66.1 → skipped: single value; Replace with 66.1 → changed"),

  // 3. Filters (read-only)
  product({ id: "F1", status: "ACTIVE", productType: "Steel Wheel", tags: ["filter-test", "sale", "winter"], collections: ["winter"], variants: simple("CBM-F1"), attributes: [shared("colour", "Red"), local("material", "Aluminium")], purpose: "Matches Colour=Red AND material=Aluminium" }),
  product({ id: "F2", status: "DRAFT", productType: "Steel Wheel", tags: ["filter-test", "sale"], collections: ["winter"], variants: simple("CBM-F2"), attributes: [shared("colour", "Red")], purpose: "Fails the 2nd condition; Draft" }),
  product({ id: "F3", status: "ARCHIVED", productType: "Steel Wheel", tags: ["filter-test", "winter"], collections: [], variants: simple("CBM-F3"), attributes: [local("material", "Aluminium")], purpose: "Fails the 1st condition; Archived" }),

  // 4. Batch: 12 products → batches of 10 + 2
  ...Array.from({ length: 12 }, (_, i) => {
    const id = `B${String(i + 1).padStart(2, "0")}`;
    return product({ id, status: "ACTIVE", productType: "Tyre", tags: ["batch"], collections: i < 5 ? ["winter"] : [], variants: simple(`CBM-${id}`), attributes: [shared("colour", "Red")], purpose: "Replace Colour with Crimson by select-all on tag batch; stop; Put Back" });
  }),

  // 5. Conversion
  convert("C1", [local("rim_size", "18")], "Ready: 18 → 18\" (exact)"),
  convert("C2", [local("rim_size", "18"), shared("rim_size", '18"')], "Ready: typed copy removed (already shared)"),
  convert("C3", [local("rim_size", "18"), shared("rim_size", '19"')], "Blocked: different shared value", { mutationSafe: true }),
  convert("C4", [local("wheel_year", "2024-ONWARDS")], "Blocked (no match) → after approving 2024-ONWARDS → 2024-Present: ready"),
  convert("C5", [local("colour", "Maroon")], "Blocked (no match) → after Hold: awaiting approval; never converted"),
  convert("C6", [local("centre_bore", "66.1")], "Blocked: ambiguous (66.1 and 66.1mm)"),
  convert("C7", [local("rim_size", "21")], "Blocked → after planning 21\": ready (new value to be created), skipped on convert; after adding 21\" to the choices: converts"),
  convert("C8", [local("rim_size", "18")], "Skipped: product with variants", {
    optionName: "Size",
    variants: [
      { sku: "CBM-C8-S", option: "S", inventory: UNTRACKED },
      { sku: "CBM-C8-M", option: "M", inventory: UNTRACKED },
    ],
    expect: { multiVariant: true },
  }),
  convert("C9", [localList("rim_size", "17", "18")], "Ready: [17, 18] → [17\", 18\"]; edit after the dry run → skipped"),
  convert("C10", [local("rim_size", "19")], "Ready; staged Draft-only conversion", { status: "DRAFT" }),

  // 6. Control: never selected, checked before and after every run
  product({
    id: "X1",
    status: "UNLISTED",
    productType: "Alloy Wheel",
    tags: ["control"],
    collections: [],
    variants: simple("CBM-X1", tracked(3)),
    attributes: [shared("colour", "Red"), local("finish", "Gloss")],
    purpose: "Control: never select. Matches Colour=Red, so never select all by Colour",
    mutationSafe: false,
  }),
];

/** The audit-corrected filter table: filter → IDs the app must return (every status included). */
export const EXPECTED_FILTERS: { name: string; filters: Record<string, unknown>; ids: string[] }[] = [
  { name: "Name 'CBM Test' (pagination: 41 at 25 per page = 2 pages)", filters: { search: "CBM Test" }, ids: PRODUCTS.map((p) => p.id) },
  { name: "Name 'CBM Test B'", filters: { search: "CBM Test B" }, ids: ids("B", 12) },
  { name: "Colour = Red", filters: { conditions: [{ attribute: "shared.colour", value: "Red" }] }, ids: ["A1", "A2", "A9", ...ids("B", 12), "F1", "F2", "X1"] },
  { name: "Colour = Red AND material = Aluminium", filters: { conditions: [{ attribute: "shared.colour", value: "Red" }, { attribute: "cartovum_local.material", value: "Aluminium" }] }, ids: ["F1"] },
  { name: "material has any value", filters: { conditions: [{ attribute: "cartovum_local.material", value: "" }] }, ids: ["A8", "F1", "F3"] },
  { name: "Tags sale + winter", filters: { tags: "sale, winter" }, ids: ["F1"] },
  { name: "Tag winter", filters: { tags: "winter" }, ids: ["F1", "F3"] },
  { name: "Product type Steel Wheel", filters: { productType: "steel wheel" }, ids: ["F1", "F2", "F3"] },
  { name: "Status Draft", filters: { status: "DRAFT" }, ids: ["F2", "C10"] },
  { name: "Status Archived", filters: { status: "ARCHIVED" }, ids: ["F3"] },
  { name: "Status Unlisted", filters: { status: "UNLISTED" }, ids: ["X1"] },
  { name: "Collection Test Winter Sale", filters: { collectionRef: "winter" }, ids: ["F1", "F2", ...ids("B", 5)] },
  { name: "Stock Out of stock", filters: { stockStatus: "outofstock" }, ids: ["S2"] },
  { name: "SKUs CBM-S1, CBM-A9-B", filters: { skus: "CBM-S1, CBM-A9-B" }, ids: ["S1", "A9"] },
  { name: "Tag batch (select-all for the batch test)", filters: { tags: "batch" }, ids: ids("B", 12) },
];

function ids(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
}

/* ---------------------------------------------------------------------------------------- checks */

/** A ProductState as the app would read the seeded product, before it exists. */
export function syntheticState(p: ProductSpec, index: number, collectionIds: Record<CollectionRef, string>): ProductState {
  const n = 9_000_000 + index;
  return {
    id: `gid://shopify/Product/${n}`,
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: "",
    productType: p.productType,
    tags: p.tags,
    descriptionHash: "",
    templateSuffix: "",
    categoryId: "",
    collectionIds: p.collections.map((c) => collectionIds[c]),
    mediaIds: [],
    hasOnlyDefaultVariant: p.variants.length === 1,
    options: p.optionName ? [{ name: p.optionName, values: p.variants.map((v) => v.option!) }] : [{ name: "Title", values: ["Default Title"] }],
    attributes: p.attributes.map((a) => ({ key: `${a.ns}.${a.key}`, kind: a.ns === SHARED_NS ? "global" : "local", type: a.type, values: a.values })),
    variants: p.variants.map((v, i) => ({
      id: `gid://shopify/ProductVariant/${n}${i}`,
      title: v.option ?? "Default Title",
      sku: v.sku,
      price: "10.00",
      compareAtPrice: "",
      barcode: "",
      inventoryPolicy: v.inventory.tracked ? v.inventory.policy : "DENY",
      inventoryItemId: `gid://shopify/InventoryItem/${n}${i}`,
      tracked: v.inventory.tracked,
      levels: [{ locationId: "gid://shopify/Location/1", onHand: v.inventory.tracked ? v.inventory.onHand : 0, available: v.inventory.tracked ? v.inventory.onHand : 0 }],
      selectedOptions: p.optionName ? [{ name: p.optionName, value: v.option! }] : [{ name: "Title", value: "Default Title" }],
    })),
  };
}

export const FAKE_COLLECTION_IDS: Record<CollectionRef, string> = { alloy: "gid://shopify/Collection/1", winter: "gid://shopify/Collection/2" };

/** Resolves a filter row to the app's filter input (collection references become the real collection ID). */
export function filterInput(row: (typeof EXPECTED_FILTERS)[number], collectionIds: Record<CollectionRef, string>) {
  const { collectionRef, ...rest } = row.filters as Record<string, unknown> & { collectionRef?: CollectionRef };
  return parseFilters({ ...rest, ...(collectionRef ? { collectionId: collectionIds[collectionRef] } : {}), perPage: 200 });
}

/** Every inconsistency in the spec, checked with the app's own stock and filter rules. Empty means consistent. */
export function checkSpec(): string[] {
  const problems: string[] = [];
  const seen = (label: string, values: string[]) => {
    const dup = values.filter((v, i) => values.indexOf(v) !== i);
    if (dup.length) problems.push(`Duplicate ${label}: ${[...new Set(dup)].join(", ")}`);
  };
  seen("product ID", PRODUCTS.map((p) => p.id));
  seen("handle", PRODUCTS.map((p) => p.handle));
  seen("SKU", PRODUCTS.flatMap((p) => p.variants.map((v) => v.sku)));

  for (const p of PRODUCTS) {
    const where = `${p.id}:`;
    if (!TYPES.includes(p.productType)) problems.push(`${where} unknown product type ${p.productType}`);
    for (const t of p.tags) if (!(TAGS as readonly string[]).includes(t)) problems.push(`${where} undeclared tag ${t}`);
    for (const c of p.collections) if (!(c in COLLECTIONS)) problems.push(`${where} unknown collection ${c}`);
    if (p.variants.length > 1 && !p.optionName) problems.push(`${where} several variants but no option name`);
    if (p.variants.length > 1 && p.variants.some((v) => !v.option)) problems.push(`${where} a variant has no option value`);
    for (const a of p.attributes) {
      if (a.type === SINGLE && a.values.length !== 1) problems.push(`${where} single-value ${a.key} has ${a.values.length} values`);
      if (a.ns === SHARED_NS) {
        const d = DEFINITIONS.find((x) => x.key === a.key);
        if (!d) problems.push(`${where} no definition for shared.${a.key}`);
        else {
          if (d.type !== a.type) problems.push(`${where} shared.${a.key} type differs from its definition`);
          for (const v of a.values) if (!d.choices.includes(v)) problems.push(`${where} "${v}" is not a choice of shared.${a.key}`);
        }
      }
    }
    const state = syntheticState(p, 0, FAKE_COLLECTION_IDS);
    const stockNow = productStockStatus(state);
    if (stockNow !== p.expect.stock) problems.push(`${where} inventory setup gives ${stockNow}, matrix says ${p.expect.stock}`);
    const multi = !state.hasOnlyDefaultVariant || state.variants.length > 1;
    if (multi !== p.expect.multiVariant) problems.push(`${where} variants give multiVariant=${multi}, matrix says ${p.expect.multiVariant}`);
  }
  for (const d of DEFINITIONS) if (d.choices.length > 128) problems.push(`shared.${d.key}: too many choices`);

  const states = PRODUCTS.map((p, i) => ({ id: p.id, state: syntheticState(p, i, FAKE_COLLECTION_IDS) }));
  for (const row of EXPECTED_FILTERS) {
    const f = filterInput(row, FAKE_COLLECTION_IDS);
    const got = states.filter((s) => matches(s.state, f)).map((s) => s.id).sort();
    const want = [...row.ids].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`Filter "${row.name}": app returns [${got.join(", ")}], matrix says [${want.join(", ")}]`);
  }
  return problems;
}

/* ------------------------------------------------------------------------------ Shopify inputs */

/** The productSet input for one product. Every list (variants, metafields, collections) is complete: a rerun resets the product. */
export function productSetInput(p: ProductSpec, locationId: string, collectionIds: Record<CollectionRef, string>) {
  const optionName = p.optionName ?? "Title";
  return {
    title: p.title,
    handle: p.handle,
    status: p.status,
    productType: p.productType,
    vendor: "Cartovum Test",
    tags: p.tags,
    collections: p.collections.map((c) => collectionIds[c]),
    productOptions: [{ name: optionName, values: p.variants.map((v) => ({ name: v.option ?? "Default Title" })) }],
    metafields: p.attributes.map((a) => ({ namespace: a.ns, key: a.key, type: a.type, value: a.type === LIST ? JSON.stringify(a.values) : a.values[0] })),
    variants: p.variants.map((v) => ({
      sku: v.sku,
      price: "10.00",
      optionValues: [{ optionName, name: v.option ?? "Default Title" }],
      inventoryPolicy: v.inventory.tracked ? v.inventory.policy : "DENY",
      inventoryItem: { tracked: v.inventory.tracked },
      // Untracked variants get no quantity at all; tracked ones are set explicitly, including 0.
      ...(v.inventory.tracked ? { inventoryQuantities: [{ locationId, name: "on_hand", quantity: v.inventory.onHand }] } : {}),
    })),
  };
}
