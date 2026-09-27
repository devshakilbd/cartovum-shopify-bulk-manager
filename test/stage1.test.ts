import { describe, expect, it } from "vitest";
import { appUrl, authCallbackUrl } from "../app/lib/config.server";
import { createOperation, runToEnd } from "../app/lib/core/engine";
import { matches, normaliseFilters, parseFilters, queryIsExact, searchPage, shopifyQuery } from "../app/lib/core/filters";
import { makeProduct, MemoryGateway } from "../app/lib/core/memory-gateway";
import { MemoryStore } from "../app/lib/core/memory-store";

const SHOP = "a.myshopify.com";

describe("product type and tag filters", () => {
  it("parses tags: comma separated, trimmed, de-duplicated, at most 10", () => {
    const f = parseFilters({ productType: "  Alloy Wheel ", tags: " sale, winter ,sale,," + Array.from({ length: 20 }, (_, i) => `t${i}`).join(",") });
    expect(f.productType).toBe("Alloy Wheel");
    expect(f.tags.slice(0, 2)).toEqual(["sale", "winter"]);
    expect(f.tags).toHaveLength(10);
  });

  it("sends both to Shopify escaped, and does not treat them as an exact count", () => {
    const f = parseFilters({ productType: 'Wheel" OR status:draft', tags: "a\\b" });
    // One backslash in the tag becomes two in the search string; the quote is escaped too.
    expect(shopifyQuery(f)).toBe('product_type:"Wheel\\" OR status:draft" AND tag:"a\\\\b"');
    expect(queryIsExact(f)).toBe(false);
    expect(queryIsExact(parseFilters({ status: "DRAFT" }))).toBe(true);
  });

  it("matches product type exactly (ignoring case) and requires every tag", () => {
    const p = makeProduct({ productType: "Alloy Wheel", tags: ["Sale", "Winter"] });
    expect(matches(p, parseFilters({ productType: "alloy wheel" }))).toBe(true);
    expect(matches(p, parseFilters({ productType: "Alloy" }))).toBe(false);
    expect(matches(p, parseFilters({ tags: "sale, WINTER" }))).toBe(true);
    expect(matches(p, parseFilters({ tags: "sale, summer" }))).toBe(false);
  });

  it("combines with every existing filter", () => {
    const p = makeProduct({ productType: "Wheel", tags: ["sale"], status: "DRAFT", sku: "W-1", collectionIds: ["gid://shopify/Collection/5"], attributes: [{ key: "cartovum_local.size", kind: "local", type: "single_line_text_field", values: ["18"] }] });
    const all = { search: "product", skus: "W-1", collectionId: "gid://shopify/Collection/5", productType: "wheel", tags: "SALE", stockStatus: "instock", status: "DRAFT", conditions: [{ attribute: "cartovum_local.size", value: "18" }] };
    expect(matches(p, parseFilters(all))).toBe(true);
    expect(matches(p, parseFilters({ ...all, status: "ACTIVE" }))).toBe(false);
    expect(matches(p, parseFilters({ ...all, conditions: [{ attribute: "cartovum_local.size", value: "19" }] }))).toBe(false);
  });

  it("pages through tag matches exactly once", async () => {
    const gw = new MemoryGateway();
    for (let i = 0; i < 90; i++) {
      const p = makeProduct({ tags: i % 3 ? [] : ["sale"] });
      gw.products.set(p.id, p);
    }
    const f = parseFilters({ tags: "sale", perPage: 25 });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchPage(gw, f, cursor);
      seen.push(...page.items.map((p) => p.id));
      cursor = page.next;
    } while (cursor);
    expect(new Set(seen).size).toBe(30);
  });

  it("select all matching by product type + tag resolves on the server", async () => {
    const gw = new MemoryGateway([], [{ key: "shared.colour", label: "Colour", type: "list.single_line_text_field", choices: ["Red"] }]);
    for (let i = 0; i < 60; i++) {
      const p = makeProduct({ productType: i % 2 ? "Wheel" : "Tyre", tags: i % 4 === 1 ? ["sale"] : [] });
      gw.products.set(p.id, p);
    }
    const store = new MemoryStore();
    const op = await createOperation(store, gw, SHOP, { type: "stock", params: { stockStatus: "outofstock" }, selection: { mode: "ALL_MATCHING", filters: { productType: "wheel", tags: "sale" } }, userLabel: "t" });
    await runToEnd(store, gw, SHOP, op.id);
    expect(await store.getOperation(SHOP, op.id)).toMatchObject({ total: 15, changed: 15 });
  });

  it("a filter snapshot saved before these fields existed still resolves", async () => {
    const gw = new MemoryGateway([makeProduct(), makeProduct()]);
    const store = new MemoryStore();
    const op = await createOperation(store, gw, SHOP, { type: "stock", params: { stockStatus: "outofstock" }, selection: { mode: "ALL_MATCHING", filters: {} }, userLabel: "t" });
    const legacy = { search: "", skus: [], collectionId: "", stockStatus: "" as const, status: "" as const, conditions: [], perPage: 50 };
    await store.updateOperation(SHOP, op.id, { filters: legacy as never });
    expect(normaliseFilters(legacy)).toMatchObject({ productType: "", tags: [] });
    await runToEnd(store, gw, SHOP, op.id);
    expect(await store.getOperation(SHOP, op.id)).toMatchObject({ total: 2, changed: 2 });
  });
});

describe("app URL configuration", () => {
  it("uses SHOPIFY_APP_URL, trimmed to its origin, with the redirect URL derived from it", () => {
    expect(appUrl({ SHOPIFY_APP_URL: "https://app.cartovumagency.com/", NODE_ENV: "production" })).toBe("https://app.cartovumagency.com");
    expect(authCallbackUrl({ SHOPIFY_APP_URL: "https://app.cartovumagency.com", NODE_ENV: "production" })).toBe("https://app.cartovumagency.com/auth/callback");
  });

  it("keeps local development working", () => {
    expect(appUrl({ NODE_ENV: "development" })).toBe("");
    expect(appUrl({ SHOPIFY_APP_URL: "http://localhost:3000", NODE_ENV: "production" })).toBe("http://localhost:3000");
    expect(appUrl({ SHOPIFY_APP_URL: "https://abc.trycloudflare.com", NODE_ENV: "development" })).toBe("https://abc.trycloudflare.com");
  });

  it("refuses a production URL that is missing, not https, not a URL, or has a path", () => {
    expect(() => appUrl({ NODE_ENV: "production" })).toThrow(/not set/);
    expect(() => appUrl({ SHOPIFY_APP_URL: "http://app.cartovumagency.com", NODE_ENV: "production" })).toThrow(/https/);
    expect(() => appUrl({ SHOPIFY_APP_URL: "app.cartovumagency.com", NODE_ENV: "production" })).toThrow(/valid URL/);
    expect(() => appUrl({ SHOPIFY_APP_URL: "https://app.cartovumagency.com/app", NODE_ENV: "production" })).toThrow(/origin/);
  });
});
