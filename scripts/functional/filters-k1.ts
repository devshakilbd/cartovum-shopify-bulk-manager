import { createDryRun } from "../../app/lib/core/engine";
import { matches, parseFilters, searchPage } from "../../app/lib/core/filters";
import { COLLECTIONS, FAKE_COLLECTION_IDS, PRODUCTS, syntheticState, type CollectionRef } from "../seed/spec";
import { execute } from "../seed/cli-admin";
import { LABEL, SHOP, type Harness } from "./harness";

/** Phase 5 (filter combinations, pagination) and Phase 8 (K1: Shopify standard category attributes stay outside Cartovum). */

const COMBOS: { name: string; filters: Record<string, unknown> & { collectionRef?: CollectionRef } }[] = [
  { name: "type Tyre + tag batch + collection Test Winter Sale", filters: { productType: "Tyre", tags: "batch", collectionRef: "winter" } },
  { name: "status Active + material has any value", filters: { status: "ACTIVE", conditions: [{ attribute: "cartovum_local.material", value: "" }] } },
  { name: "stock In stock + type Alloy Wheel + tag stock-test", filters: { stockStatus: "instock", productType: "Alloy Wheel", tags: "stock-test" } },
  { name: "variant SKU CBM-S5-M", filters: { skus: "CBM-S5-M" } },
  { name: "product option Size = M", filters: { conditions: [{ attribute: "option:Size", value: "M" }] } },
  { name: "local Rim Size = 18 (single and list values)", filters: { conditions: [{ attribute: "cartovum_local.rim_size", value: "18" }] } },
  { name: "shared Colour = Red + tag batch + collection Test Winter Sale", filters: { conditions: [{ attribute: "shared.colour", value: "Red" }], tags: "batch", collectionRef: "winter" } },
  { name: "name words 'test b1'", filters: { search: "test b1" } },
  { name: "status Draft + type Wheel", filters: { status: "DRAFT", productType: "Wheel" } },
];

const withCollection = (f: Record<string, unknown> & { collectionRef?: CollectionRef }, ids: Record<CollectionRef, string>) => {
  const { collectionRef, ...rest } = f;
  return { ...rest, ...(collectionRef ? { collectionId: ids[collectionRef] } : {}) };
};

async function collectionIds(h: Harness): Promise<Record<CollectionRef, string>> {
  const d = await execute<{ collections: { nodes: { id: string; handle: string }[] } }>(
    h.cli,
    `#graphql
    query CartovumFunctionalCollections($q: String!) { collections(first: 10, query: $q) { nodes { id handle } } }`,
    { q: Object.values(COLLECTIONS).map((c) => `handle:${c.handle}`).join(" OR ") },
  );
  const out = {} as Record<CollectionRef, string>;
  for (const [ref, c] of Object.entries(COLLECTIONS) as [CollectionRef, { handle: string }][]) out[ref] = d.collections.nodes.find((n) => n.handle === c.handle)!.id;
  return out;
}

export async function filterSuite(h: Harness) {
  const phase = "5 Filters";
  const cids = await collectionIds(h);
  const synthetic = PRODUCTS.map((p, i) => ({ id: p.id, state: syntheticState(p, i, FAKE_COLLECTION_IDS) }));
  const keyOf = new Map([...h.ids].map(([k, v]) => [v, k]));

  for (const combo of COMBOS) {
    h.begin(phase, combo.name);
    const expected = synthetic.filter((s) => matches(s.state, parseFilters({ ...withCollection(combo.filters, FAKE_COLLECTION_IDS), perPage: 200 }))).map((s) => s.id).sort();
    const f = parseFilters({ ...withCollection(combo.filters, cids), perPage: 200 });
    const got: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchPage(h.gw, f, cursor);
      got.push(...page.items.map((p) => keyOf.get(p.id) ?? `not seeded: ${p.title}`));
      cursor = page.next;
    } while (cursor);
    h.eq(`live search returns exactly [${expected.join(", ")}]`, got.sort(), expected);
  }

  h.begin(phase, "pagination: 41 'CBM Test' products at 25 per page");
  const f = parseFilters({ search: "CBM Test", perPage: 25 });
  const p1 = await searchPage(h.gw, f, null);
  const p2 = p1.next ? await searchPage(h.gw, f, p1.next) : { items: [], next: null };
  const ids = [...p1.items, ...p2.items].map((p) => p.id);
  h.eq("page sizes 25 then 16, then no further page", [p1.items.length, p2.items.length, p2.next], [25, 16, null]);
  h.eq("no product on both pages; 41 distinct", new Set(ids).size, 41);
}

/* ------------------------------------------------------------------------------------------- K1 */

const K1_READ = `#graphql
  query CartovumFunctionalK1($id: ID!) {
    product(id: $id) {
      title status productType tags hasOnlyDefaultVariant
      category { name fullName }
      collections(first: 5) { nodes { handle } }
      variants(first: 5) { nodes { sku price inventoryPolicy inventoryItem { tracked } } }
      metafields(first: 50) { nodes { namespace key type value } }
    }
  }`;

export type K1Raw = { title: string; status: string; productType: string; tags: string[]; hasOnlyDefaultVariant: boolean; category: { name: string; fullName: string } | null; collections: { nodes: { handle: string }[] }; variants: { nodes: { sku: string; price: string; inventoryPolicy: string; inventoryItem: { tracked: boolean } }[] }; metafields: { nodes: { namespace: string; key: string; type: string; value: string }[] } };

export async function readK1(h: Harness): Promise<K1Raw | null> {
  if (!h.k1) return null;
  return (await execute<{ product: K1Raw }>(h.cli, K1_READ, { id: h.k1 })).product;
}

export async function k1Suite(h: Harness) {
  const phase = "8 K1 standard category attributes";
  h.begin(phase, "K1 read back");
  const k1 = await readK1(h);
  const k1Id = h.k1;
  if (!k1 || !k1Id) {
    h.blocked("K1 exists in cartovum-bulk-dev", "no product with SKU CBM-K1 in the store; create it by hand (see TESTING.md)");
    return;
  }
  const v = k1.variants.nodes;
  h.eq("title, status, empty product type, tag control", [k1.title, k1.status, k1.productType, k1.tags], ["CBM Test K1", "ACTIVE", "", ["control"]]);
  h.check(/wheel/i.test(k1.category?.fullName ?? ""), "category is a standard Wheels category", k1.category?.fullName ?? "no category");
  h.eq("one default variant: SKU CBM-K1, 10.00, not tracked", [k1.hasOnlyDefaultVariant, v.length, v[0]?.sku, v[0]?.price, v[0]?.inventoryItem.tracked], [true, 1, "CBM-K1", "10.00", false]);
  h.eq("no collections", k1.collections.nodes.map((c) => c.handle), []);
  const standard = k1.metafields.nodes.filter((m) => m.namespace === "shopify");
  h.check(standard.some((m) => /colou?r/.test(m.key)), "standard Colour category metafield is set", standard.map((m) => `${m.namespace}.${m.key} (${m.type})`).join(", ") || "none");
  const cartovum = k1.metafields.nodes.filter((m) => m.namespace === "shared" || m.namespace === "cartovum_local");
  h.eq("no shared.* or cartovum_local.* attributes", cartovum.map((m) => `${m.namespace}.${m.key}`), []);

  h.begin(phase, "the app does not treat K1's category attributes as Cartovum attributes");
  const [state] = await h.gw.getProducts([k1Id]);
  h.eq("app reads K1 with no Cartovum attributes", state?.attributes ?? "unreadable", []);
  const dry = await createDryRun(h.store, SHOP, LABEL);
  await h.wait(dry.id);
  const { items } = await h.store.dryRunItems(SHOP);
  h.check(!items.some((i) => i.productId === k1Id), "conversion dry run does not list K1", `${items.length} products listed`);
}
