import { describe, expect, it } from "vitest";
import { OpError, parseOp, plan, applyAttributeOne } from "../app/lib/core/attributes";
import { canonical, fingerprint, hash, isQuantityManaged, productStockStatus, unexpectedChanges, variantStockStatus } from "../app/lib/core/fingerprint";
import { matches, parseFilters, quote, shopifyQuery } from "../app/lib/core/filters";
import { makeProduct, MemoryGateway, multiVariant } from "../app/lib/core/memory-gateway";
import { applyStockOne } from "../app/lib/core/stock";
import { DEFAULT_SETTINGS, type GlobalAttributeDefinition } from "../app/lib/core/types";

const COLOUR: GlobalAttributeDefinition = { key: "shared.colour", label: "Colour", type: "list.single_line_text_field", choices: ["Red", "Blue", "Green"] };
const S = DEFAULT_SETTINGS;

describe("filters", () => {
  it("parses SKUs one per line or comma separated, capped at 500", () => {
    const f = parseFilters({ skus: "A-1, B-2\nC-3\r\n\n" + Array.from({ length: 600 }, (_, i) => `X${i}`).join(",") });
    expect(f.skus.slice(0, 3)).toEqual(["A-1", "B-2", "C-3"]);
    expect(f.skus).toHaveLength(500);
  });

  it("rejects values outside the closed sets", () => {
    const f = parseFilters({ stockStatus: "hacked", status: "publish", collectionId: "1 OR 1", perPage: 9999, conditions: [{ attribute: "bad key; drop" }] });
    expect(f).toMatchObject({ stockStatus: "", status: "", collectionId: "", perPage: 50, conditions: [] });
  });

  it("keeps at most 10 attribute conditions", () => {
    const f = parseFilters({ conditions: Array.from({ length: 15 }, () => ({ attribute: "shared.colour", value: "Red" })) });
    expect(f.conditions).toHaveLength(10);
  });

  it("escapes values in the Shopify search string", () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    const q = shopifyQuery(parseFilters({ skus: 'X" OR status:draft', status: "DRAFT" }));
    expect(q).toBe('(sku:"X\\" OR status:draft") AND status:draft');
  });

  it("matches every attribute condition (AND), value case-insensitive, empty value means has-attribute", () => {
    const p = makeProduct({ attributes: [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }, { key: "cartovum_local.size", kind: "local", type: "single_line_text_field", values: ["XL"] }] });
    const f = (conditions: unknown) => parseFilters({ conditions });
    expect(matches(p, f([{ attribute: "shared.colour", value: "red" }, { attribute: "cartovum_local.size", value: "xl" }]))).toBe(true);
    expect(matches(p, f([{ attribute: "shared.colour", value: "Red" }, { attribute: "cartovum_local.size", value: "L" }]))).toBe(false);
    expect(matches(p, f([{ attribute: "cartovum_local.size", value: "" }]))).toBe(true);
    expect(matches(p, f([{ attribute: "cartovum_local.other", value: "" }]))).toBe(false);
  });

  it("matches SKUs on any variant and product options as conditions", () => {
    const p = multiVariant();
    expect(matches(p, parseFilters({ skus: p.variants[1].sku }))).toBe(true);
    expect(matches(p, parseFilters({ conditions: [{ attribute: "option:Size", value: "m" }] }))).toBe(true);
  });
});

describe("fingerprint", () => {
  it("is deterministic regardless of key order", () => {
    expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonical({ a: [{ c: 2, d: 1 }], b: 1 }));
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  });

  it("reports fields that changed but were not allowed to", () => {
    const a = makeProduct();
    const b = structuredClone(a);
    b.variants[0].price = "11.00";
    b.attributes = [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }];
    expect(unexpectedChanges(fingerprint(a), fingerprint(b), ["attributes"])).toEqual(["variants"]);
  });

  it("derives stock status like WooCommerce", () => {
    const v = makeProduct().variants[0];
    expect(variantStockStatus({ ...v, tracked: false })).toBe("instock");
    expect(variantStockStatus({ ...v, tracked: true, inventoryPolicy: "DENY" })).toBe("outofstock");
    expect(variantStockStatus({ ...v, tracked: true, inventoryPolicy: "CONTINUE" })).toBe("onbackorder");
    expect(isQuantityManaged({ ...v, tracked: true, levels: [{ locationId: "l", onHand: 3, available: 3 }] })).toBe(true);
    const mv = multiVariant();
    mv.variants[0].tracked = true;
    expect(productStockStatus(mv)).toBe("instock");
  });
});

describe("attribute operations", () => {
  const p = () => makeProduct({ attributes: [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }] });
  const op = (raw: Record<string, unknown>) => parseOp(raw, [COLOUR], S);

  it("never accepts a value that is not an existing choice", () => {
    expect(() => op({ op: "add_terms", attribute: "shared.colour", terms: ["Purple"] })).toThrow(OpError);
    expect(() => op({ op: "add_terms", attribute: "shared.size", terms: ["x"] })).toThrow(/never created/);
  });

  it("restricts local attributes to set value / remove", () => {
    expect(() => op({ op: "add_terms", attribute: "cartovum_local.size", terms: [] })).toThrow(/local attribute/);
    expect(() => op({ op: "set_local_value", attribute: "shared.colour", value: "x" })).toThrow(/global/);
    expect(() => op({ op: "set_local_value", attribute: "cartovum_local.size", value: " " })).toThrow(/Enter a value/);
  });

  it("add / remove / replace / remove attribute", () => {
    expect(plan(p(), op({ op: "add_terms", attribute: "shared.colour", terms: ["Blue"] }))).toMatchObject({ set: [{ values: ["Red", "Blue"] }] });
    expect(plan(p(), op({ op: "add_terms", attribute: "shared.colour", terms: ["Red"] }))).toBeNull();
    expect(plan(p(), op({ op: "remove_terms", attribute: "shared.colour", terms: ["Red"] }))).toMatchObject({ set: [], remove: ["shared.colour"] });
    expect(plan(p(), op({ op: "set_terms", attribute: "shared.colour", terms: ["Green"] }))).toMatchObject({ set: [{ values: ["Green"] }] });
    expect(plan(p(), op({ op: "remove_attribute", attribute: "shared.colour" }))).toMatchObject({ remove: ["shared.colour"] });
    expect(plan(makeProduct(), op({ op: "remove_terms", attribute: "shared.colour", terms: ["Red"] }))).toBeNull();
  });

  it("skips adding a global attribute when a local one of the same name exists", () => {
    const clash = makeProduct({ attributes: [{ key: "cartovum_local.colour", kind: "local", type: "single_line_text_field", values: ["red"] }] });
    expect(plan(clash, op({ op: "add_terms", attribute: "shared.colour", terms: ["Red"] }))).toMatchObject({ skip: expect.stringContaining("local attribute") });
  });

  it("set_local_value only changes an existing local attribute and keeps its type", () => {
    const local = makeProduct({ attributes: [{ key: "cartovum_local.size", kind: "local", type: "single_line_text_field", values: ["18"] }] });
    expect(plan(local, op({ op: "set_local_value", attribute: "cartovum_local.size", value: "19" }))).toMatchObject({ set: [{ values: ["19"] }] });
    expect(plan(local, op({ op: "set_local_value", attribute: "cartovum_local.size", value: "19|20" }))).toMatchObject({ skip: expect.any(String) });
    expect(plan(makeProduct(), op({ op: "set_local_value", attribute: "cartovum_local.size", value: "19" }))).toMatchObject({ skip: expect.stringContaining("does not add") });
  });

  it("leaves multi-variant products and variant-defining options alone", async () => {
    const mv = multiVariant();
    const colourOption = makeProduct({ options: [{ name: "Colour", values: ["Red"] }] });
    const gw = new MemoryGateway([mv, colourOption], [COLOUR]);
    const o = op({ op: "add_terms", attribute: "shared.colour", terms: ["Blue"] });
    expect((await applyAttributeOne(gw, mv.id, o, S)).status).toBe("skipped");
    expect((await applyAttributeOne(gw, colourOption.id, o, S)).message).toMatch(/product option/);
    expect(gw.calls).not.toContain("writeAttributes");
  });
});

describe("stock operations", () => {
  it("maps statuses to tracking and policy without touching quantity", async () => {
    const p = makeProduct();
    const gw = new MemoryGateway([p]);
    const r1 = await applyStockOne(gw, p.id, "onbackorder", S);
    expect(r1).toMatchObject({ status: "changed", message: "instock to onbackorder" });
    expect(gw.products.get(p.id)!.variants[0]).toMatchObject({ tracked: true, inventoryPolicy: "CONTINUE" });
    const r2 = await applyStockOne(gw, p.id, "outofstock", S);
    expect(r2.status).toBe("changed");
    expect((await applyStockOne(gw, p.id, "outofstock", S)).message).toMatch(/Already/);
    expect(gw.products.get(p.id)!.variants[0].levels[0].onHand).toBe(0);
  });

  it("skips quantity-managed inventory and multi-variant products", async () => {
    const q = makeProduct({ tracked: true, onHand: 5 });
    const mv = multiVariant();
    const gw = new MemoryGateway([q, mv]);
    expect((await applyStockOne(gw, q.id, "outofstock", S)).message).toMatch(/Quantity-managed/);
    expect((await applyStockOne(gw, mv.id, "outofstock", S)).status).toBe("skipped");
    expect(gw.calls.filter((c) => c.startsWith("set"))).toHaveLength(0);
  });
});

describe("paging", () => {
  it("walks every matching product exactly once across cursor pages", async () => {
    const { searchPage } = await import("../app/lib/core/filters");
    const gw = new MemoryGateway();
    for (let i = 0; i < 180; i++) {
      const p = makeProduct({ status: i % 4 === 0 ? "DRAFT" : "ACTIVE" });
      gw.products.set(p.id, p);
    }
    // Stock status is confirmed by the app, not Shopify, so pages are assembled across Shopify pages.
    const f = parseFilters({ status: "DRAFT", stockStatus: "instock", perPage: 25 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await searchPage(gw, f, cursor);
      seen.push(...page.items.map((p) => p.id));
      cursor = page.next;
      pages++;
    } while (cursor && pages < 50);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect(pages).toBe(2);
  });

  it("ignores a forged cursor", async () => {
    const { searchPage } = await import("../app/lib/core/filters");
    const gw = new MemoryGateway([makeProduct()]);
    const page = await searchPage(gw, parseFilters({}), 'x" OR 1|999999');
    expect(page.items).toHaveLength(1);
  });
});

describe("preview", () => {
  it("predicts the run without writing", async () => {
    const { previewStock, previewAttribute } = await import("../app/lib/core/preview");
    const p = makeProduct({ attributes: [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }] });
    expect(previewStock(p, "outofstock", S)).toMatchObject({ status: "changed", message: "Would change instock to outofstock" });
    expect(previewStock(makeProduct({ tracked: true, onHand: 2 }), "outofstock", S).status).toBe("skipped");
    const op = parseOp({ op: "set_terms", attribute: "shared.colour", terms: ["Blue"] }, [COLOUR], S);
    expect(previewAttribute(p, op, S).message).toBe("Would change Colour: Red to Blue");
  });
});
