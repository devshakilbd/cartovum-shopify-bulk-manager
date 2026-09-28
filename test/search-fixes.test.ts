import { describe, expect, it } from "vitest";
import { createDryRun, createOperation, runToEnd } from "../app/lib/core/engine";
import { ANY_STATUS_QUERY, matches, matchesName, parseFilters, queryIsExact, searchPage, shopifyQuery, words } from "../app/lib/core/filters";
import { makeProduct, MemoryGateway } from "../app/lib/core/memory-gateway";
import { MemoryStore } from "../app/lib/core/memory-store";
import { DEFAULT_SETTINGS, type AttributeValue, type ProductState } from "../app/lib/core/types";

/**
 * Audit fixes #1 and #2. The in-memory Shopify follows the documented search rules: only Active products
 * when no status is named, and title words matched by trailing wildcard only.
 */

const SHOP = "a.myshopify.com";
const red: AttributeValue[] = [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }];

/** Every product Shopify would return for a raw search string, following its cursor (10 per page). */
async function shopifyAll(gw: MemoryGateway, query: string) {
  const out: ProductState[] = [];
  let after: string | null = null;
  do {
    const page = await gw.searchProducts(query, 250, after);
    expect(page.products.length).toBeLessThanOrEqual(10);
    out.push(...page.products);
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return out;
}

async function allPages(gw: MemoryGateway, raw: Record<string, unknown>) {
  const f = parseFilters({ perPage: 25, ...raw });
  const seen: ProductState[] = [];
  let cursor: string | null = null;
  do {
    const page = await searchPage(gw, f, cursor);
    seen.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return seen.map((p) => p.title);
}

function store() {
  const gw = new MemoryGateway([], [{ key: "shared.colour", label: "Colour", type: "list.single_line_text_field", choices: ["Red", "Crimson"] }]);
  const add = (p: ProductState) => gw.products.set(p.id, p);
  add(makeProduct({ title: "CBM Test F1", status: "ACTIVE", attributes: red }));
  add(makeProduct({ title: "CBM Test F2", status: "DRAFT", attributes: red }));
  add(makeProduct({ title: "CBM Test F3", status: "ARCHIVED" }));
  add(makeProduct({ title: "CBM Test X1", status: "UNLISTED", attributes: red }));
  for (let i = 1; i <= 12; i++) add(makeProduct({ title: `CBM Test B${String(i).padStart(2, "0")}`, attributes: red }));
  add(makeProduct({ title: "Alloy Wheel 18\" Black", status: "DRAFT" }));
  return gw;
}

describe("#1 any status means every status", () => {
  it("the search string names every status when none is chosen, and only the chosen one otherwise", () => {
    expect(ANY_STATUS_QUERY).toBe("(status:active OR status:draft OR status:archived OR status:unlisted)");
    expect(shopifyQuery(parseFilters({}))).toBe(ANY_STATUS_QUERY);
    expect(shopifyQuery(parseFilters({ status: "DRAFT" }))).toBe("status:draft");
  });

  it("the test double really does return only Active products for an empty query", async () => {
    const gw = store();
    const products = await shopifyAll(gw, "");
    expect(products.every((p) => p.status === "ACTIVE")).toBe(true);
    expect(products).toHaveLength(13);
  });

  it("finds Draft, Archived and Unlisted products when status is Any", async () => {
    const titles = await allPages(store(), { search: "CBM Test" });
    expect(titles).toEqual(expect.arrayContaining(["CBM Test F2", "CBM Test F3", "CBM Test X1"]));
    expect(titles).toHaveLength(16);
  });

  it("a status filter still limits to that status", async () => {
    expect(await allPages(store(), { status: "DRAFT" })).toEqual(["CBM Test F2", 'Alloy Wheel 18" Black']);
    expect(await allPages(store(), { status: "UNLISTED" })).toEqual(["CBM Test X1"]);
  });

  it("select all matching includes every status (Colour = Red: Active, Draft and Unlisted)", async () => {
    const gw = store();
    const s = new MemoryStore();
    const op = await createOperation(s, gw, SHOP, {
      type: "attributes",
      params: { op: "set_terms", attribute: "shared.colour", terms: ["Crimson"] },
      selection: { mode: "ALL_MATCHING", filters: { conditions: [{ attribute: "shared.colour", value: "Red" }] } },
      userLabel: "t",
    });
    await runToEnd(s, gw, SHOP, op.id);
    // F1, F2 (Draft), X1 (Unlisted) and B01–B12.
    expect(await s.getOperation(SHOP, op.id)).toMatchObject({ total: 15, changed: 15 });
  });

  it("the conversion dry run sees Draft products, so staged Draft-only conversion is testable", async () => {
    const gw = new MemoryGateway([], [{ key: "shared.rim_size", label: "Rim Size", type: "list.single_line_text_field", choices: ['18"', '19"'] }]);
    const local = (v: string): AttributeValue[] => [{ key: "cartovum_local.rim_size", kind: "local", type: "single_line_text_field", values: [v] }];
    const c1 = makeProduct({ status: "ACTIVE", attributes: local("18") });
    const c10 = makeProduct({ status: "DRAFT", attributes: local("19") });
    gw.products.set(c1.id, c1);
    gw.products.set(c10.id, c10);
    const s = new MemoryStore();
    await s.saveSettings(SHOP, { ...DEFAULT_SETTINGS, convertWritesEnabled: true, convertAllowedStatuses: ["DRAFT"] });
    const dry = await createDryRun(s, SHOP, "t");
    await runToEnd(s, gw, SHOP, dry.id);
    expect((await s.dryRunItems(SHOP)).items.map((i) => i.productId)).toEqual([c1.id, c10.id]);

    const op = await createOperation(s, gw, SHOP, { type: "convert", params: {}, selection: { mode: "IDS", ids: [c1.id, c10.id] }, userLabel: "t" });
    await runToEnd(s, gw, SHOP, op.id);
    expect((await s.results(SHOP, op.id)).map((t) => t.result!.status)).toEqual(["skipped", "changed"]);
  });
});

describe("#2 name search uses documented syntax only", () => {
  it("sends one trailing-wildcard title clause per word, never a leading wildcard", () => {
    const q = shopifyQuery(parseFilters({ search: "CBM Test B" }));
    expect(q).toBe(`title:cbm* AND title:test* AND title:b* AND ${ANY_STATUS_QUERY}`);
    expect(q).not.toMatch(/title:\*/);
  });

  it("drops every character with a meaning in Shopify's syntax", () => {
    expect(words('Wheel" OR status:draft (x) *-y \\z')).toEqual(["wheel", "or", "status", "draft", "x", "y", "z"]);
    const q = shopifyQuery(parseFilters({ search: '18" (alloy)' }));
    expect(q.startsWith("title:18* AND title:alloy* AND ")).toBe(true);
  });

  it("keeps letters with accents and non-Latin scripts", () => {
    expect(words("Café Jantes শাকিল")).toEqual(["café", "jantes", "শাকিল"]);
  });

  it("finds 'CBM Test B' → B01–B12 (the old leading-wildcard query found nothing)", async () => {
    const gw = store();
    const titles = await allPages(gw, { search: "CBM Test B" });
    expect(titles).toHaveLength(12);
    expect(titles.every((t) => t.startsWith("CBM Test B"))).toBe(true);
    expect(await shopifyAll(gw, 'title:*CBM Test B* AND ' + ANY_STATUS_QUERY)).toHaveLength(0);
  });

  it("matches the start of words in any order, ignoring case and punctuation", () => {
    expect(matchesName('Alloy Wheel 18" Black', "whe")).toBe(true);
    expect(matchesName('Alloy Wheel 18" Black', "black 18")).toBe(true);
    expect(matchesName('Alloy Wheel 18" Black', "WHEEL alloy")).toBe(true);
    expect(matchesName('Alloy Wheel 18" Black', "heel")).toBe(false); // middle of a word
    expect(matchesName('Alloy Wheel 18" Black', "wheel red")).toBe(false); // every word must match
    expect(matchesName("anything", '"*()')).toBe(true); // no words: no name constraint
  });

  it("the app's check and Shopify's narrowing agree, so pages, counts and select-all match", async () => {
    const gw = store();
    for (const search of ["CBM", "test b0", "b1", "wheel 18", "black", "heel", "x1 test"]) {
      const f = parseFilters({ search });
      const byShopify = (await shopifyAll(gw, shopifyQuery(f))).map((p) => p.title).sort();
      const byApp = [...gw.products.values()].filter((p) => matches(p, f)).map((p) => p.title).sort();
      expect(byShopify, search).toEqual(byApp);
    }
  });

  it("finds all 16 'CBM Test' products, of every status, on one page of 25", async () => {
    const gw = store();
    const f = parseFilters({ search: "CBM Test", perPage: 25 });
    const first = await searchPage(gw, f, null);
    expect(first.items).toHaveLength(16);
    expect(first.next).toBeNull();
  });
});

describe("#3 collection combined with name, SKU or tag (found live on cartovum-bulk-dev)", () => {
  const winter = "gid://shopify/Collection/77";
  function catalogue() {
    const gw = new MemoryGateway();
    for (let i = 1; i <= 12; i++) {
      const p = makeProduct({ title: `CBM Test B${String(i).padStart(2, "0")}`, sku: `CBM-B${String(i).padStart(2, "0")}`, tags: ["batch"], productType: "Tyre", collectionIds: i <= 5 ? [winter] : [] });
      gw.products.set(p.id, p);
    }
    const f1 = makeProduct({ title: "CBM Test F1", tags: ["sale"], productType: "Steel Wheel", collectionIds: [winter] });
    gw.products.set(f1.id, f1);
    return gw;
  }

  it("never sends title, sku or tag clauses together with collection_id", () => {
    const q = shopifyQuery(parseFilters({ collectionId: winter, search: "CBM Test", skus: "CBM-B01", tags: "batch", productType: "Tyre" }));
    expect(q).toBe(`collection_id:77 AND product_type:"Tyre" AND ${ANY_STATUS_QUERY}`);
    expect(shopifyQuery(parseFilters({ search: "CBM", tags: "batch", skus: "CBM-B01" }))).toBe(`title:cbm* AND (sku:"CBM-B01") AND tag:"batch" AND ${ANY_STATUS_QUERY}`);
  });

  it("the test Shopify reproduces the live behaviour, so the old query finds nothing", async () => {
    const gw = catalogue();
    expect(await shopifyAll(gw, `collection_id:77 AND tag:"batch" AND ${ANY_STATUS_QUERY}`)).toHaveLength(0);
    expect(await shopifyAll(gw, `collection_id:77 AND ${ANY_STATUS_QUERY}`)).toHaveLength(13);
  });

  it("collection + tag, + name, + SKU, + type + tag all return the right products", async () => {
    const gw = catalogue();
    const ids = (titles: string[]) => titles.sort();
    expect(ids(await allPages(gw, { collectionId: winter, tags: "batch" }))).toEqual(["CBM Test B01", "CBM Test B02", "CBM Test B03", "CBM Test B04", "CBM Test B05"]);
    expect(ids(await allPages(gw, { collectionId: winter, search: "test f" }))).toEqual(["CBM Test F1"]);
    expect(ids(await allPages(gw, { collectionId: winter, skus: "CBM-B03, CBM-B09" }))).toEqual(["CBM Test B03"]);
    expect(ids(await allPages(gw, { collectionId: winter, productType: "Tyre", tags: "batch" }))).toHaveLength(5);
  });

  it("a count is not treated as exact when the sku clause had to be left out", () => {
    expect(queryIsExact(parseFilters({ collectionId: winter }))).toBe(true);
    expect(queryIsExact(parseFilters({ collectionId: winter, skus: "CBM-B01" }))).toBe(false);
    expect(queryIsExact(parseFilters({ skus: "CBM-B01" }))).toBe(true);
  });
});
