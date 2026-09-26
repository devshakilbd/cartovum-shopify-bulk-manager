import { describe, expect, it } from "vitest";
import { EMPTY_DECISIONS, normalise, planProduct, resolve, verify } from "../app/lib/core/convert";
import { createDryRun, createOperation, createRevert, runToEnd } from "../app/lib/core/engine";
import { makeProduct, MemoryGateway, multiVariant } from "../app/lib/core/memory-gateway";
import { MemoryStore } from "../app/lib/core/memory-store";
import { DEFAULT_SETTINGS, type AttributeValue, type GlobalAttributeDefinition } from "../app/lib/core/types";

const SHOP = "a.myshopify.com";
const RIM: GlobalAttributeDefinition = { key: "shared.rim_size", label: "Rim Size", type: "list.single_line_text_field", choices: ['18"', '19"', "2024-Present", "54.1"] };
const BORE: GlobalAttributeDefinition = { key: "shared.centre_bore", label: "Centre Bore", type: "list.single_line_text_field", choices: ["57.1", "57.10", "54.1"] };
const local = (key: string, values: string[]): AttributeValue => ({ key: `cartovum_local.${key}`, kind: "local", type: "list.single_line_text_field", values });
const S = { ...DEFAULT_SETTINGS, convertWritesEnabled: true };

describe("value matching", () => {
  it("sets units and quotes aside only for plain numbers", () => {
    expect(normalise('18"')).toBe("18");
    expect(normalise("112mm")).toBe("112");
    expect(normalise("18 inch")).toBe("18");
    expect(normalise("57.10")).not.toBe(normalise("57.1"));
    expect(normalise("Big Wheel")).toBe("bigwheel");
  });

  it("resolves exact, ambiguous, held, override, planned and unmapped values", () => {
    const d = { ...EMPTY_DECISIONS, holds: { "shared.rim_size": { "20": "ask owner" } }, overrides: { "shared.rim_size": { "2024-ONWARDS": "2024-Present" } }, planned: { "shared.rim_size": ['21"'] } };
    expect(resolve(RIM, "18", d)).toMatchObject({ kind: "exact", term: '18"' });
    expect(resolve(RIM, "20", d)).toMatchObject({ kind: "held", ok: false });
    expect(resolve(RIM, "2024-ONWARDS", d)).toMatchObject({ kind: "override", term: "2024-Present" });
    expect(resolve(RIM, "21", d)).toMatchObject({ kind: "planned", newTerm: true });
    expect(resolve(RIM, "99", d)).toMatchObject({ kind: "unmapped" });
    expect(resolve({ ...BORE, choices: ["57.1", "57.1mm"] }, "57.1", d)).toMatchObject({ kind: "ambiguous" });
    // An override pointing at a value that no longer exists does not silently pass.
    expect(resolve({ ...RIM, choices: ['18"'] }, "2024-ONWARDS", d)).toMatchObject({ kind: "unmapped" });
  });
});

describe("planning", () => {
  it("blocks the whole product when any value cannot be resolved", () => {
    const p = makeProduct({ attributes: [local("rim_size", ["18"]), local("centre_bore", ["99.9"])] });
    const plan = planProduct(p, [RIM, BORE], EMPTY_DECISIONS, S);
    expect(plan.state).toBe("blocked");
    expect(plan.rows.map((r) => r.state)).toEqual(["ready", "blocked"]);
  });

  it("marks a held-only product as awaiting approval", () => {
    const p = makeProduct({ attributes: [local("rim_size", ["20"])] });
    const plan = planProduct(p, [RIM], { ...EMPTY_DECISIONS, holds: { "shared.rim_size": { "20": "x" } } }, S);
    expect(plan.state).toBe("needs-approval");
  });

  it("drops the typed copy when the shared value is already the same, blocks when different", () => {
    const same = makeProduct({ attributes: [local("rim_size", ["18"]), { key: RIM.key, kind: "global", type: RIM.type, values: ['18"'] }] });
    const diff = makeProduct({ attributes: [local("rim_size", ["18"]), { key: RIM.key, kind: "global", type: RIM.type, values: ['19"'] }] });
    expect(planProduct(same, [RIM], EMPTY_DECISIONS, S).rows[0].action).toBe("drop-duplicate");
    expect(planProduct(diff, [RIM], EMPTY_DECISIONS, S).state).toBe("blocked");
  });

  it("skips multi-variant products and variant options", () => {
    expect(planProduct(multiVariant({ attributes: [local("rim_size", ["18"])] }), [RIM], EMPTY_DECISIONS, S).state).toBe("skipped");
    const opt = makeProduct({ options: [{ name: "Rim Size", values: ["18"] }], attributes: [local("rim_size", ["18"])] });
    expect(planProduct(opt, [RIM], EMPTY_DECISIONS, S).state).toBe("blocked");
  });

  it("verification catches a stray attribute change", () => {
    const p = makeProduct({ attributes: [local("rim_size", ["18"]), local("other", ["a"])] });
    const plan = planProduct(p, [RIM], EMPTY_DECISIONS, S);
    const after = [{ key: RIM.key, kind: "global" as const, type: RIM.type, values: ['18"'] }, local("other", ["b"])];
    expect(verify(p.attributes, after, plan)).toEqual(["An attribute outside the conversion changed: cartovum_local.other."]);
  });
});

describe("dry run -> convert -> revert", () => {
  async function prepared(settings = S) {
    const products = [
      makeProduct({ attributes: [local("rim_size", ["18"])] }),
      makeProduct({ attributes: [local("rim_size", ["2024-ONWARDS"])] }),
      makeProduct({ attributes: [local("rim_size", ["Maroon"])] }),
      makeProduct({ status: "DRAFT", attributes: [local("rim_size", ["19"])] }),
    ];
    const gw = new MemoryGateway(products, [RIM]);
    const store = new MemoryStore();
    await store.saveSettings(SHOP, settings);
    await store.saveDecisions(SHOP, { ...EMPTY_DECISIONS, overrides: { [RIM.key]: { "2024-ONWARDS": "2024-Present" } } });
    const dry = await createDryRun(store, SHOP, "t");
    const writesBefore = gw.calls.length;
    await runToEnd(store, gw, SHOP, dry.id);
    expect(gw.calls.slice(writesBefore).every((c) => c === "searchProducts")).toBe(true); // dry run writes nothing
    return { gw, store, products };
  }

  it("dry run reports every product with typed attributes and changes nothing", async () => {
    const { store } = await prepared();
    const { items } = await store.dryRunItems(SHOP);
    expect(items.map((i) => i.state)).toEqual(["ready", "ready", "blocked", "ready"]);
    expect(items[1].rows[0]).toMatchObject({ current: "2024-ONWARDS", new: "2024-Present", mapping: "approved mapping" });
  });

  it("converts only selected products that were ready, then puts them back", async () => {
    const { gw, store, products } = await prepared();
    const op = await createOperation(store, gw, SHOP, { type: "convert", params: {}, selection: { mode: "IDS", ids: products.map((p) => p.id) }, userLabel: "t" });
    expect(op.total).toBe(3);
    await runToEnd(store, gw, SHOP, op.id);
    expect(gw.products.get(products[0].id)!.attributes).toEqual([{ key: RIM.key, kind: "global", type: RIM.type, values: ['18"'] }]);
    expect(gw.products.get(products[2].id)!.attributes[0].key).toBe("cartovum_local.rim_size");

    const rv = await createRevert(store, SHOP, op.id, "t");
    await runToEnd(store, gw, SHOP, rv.id);
    expect(gw.products.get(products[0].id)!.attributes).toEqual([local("rim_size", ["18"])]);
  });

  it("skips a product edited after the dry run", async () => {
    const { gw, store, products } = await prepared();
    gw.products.get(products[0].id)!.attributes[0].values = ["19"];
    const op = await createOperation(store, gw, SHOP, { type: "convert", params: {}, selection: { mode: "IDS", ids: [products[0].id] }, userLabel: "t" });
    await runToEnd(store, gw, SHOP, op.id);
    expect((await store.results(SHOP, op.id))[0].result).toMatchObject({ status: "skipped", message: expect.stringMatching(/since the dry run/) });
  });

  it("honours staged statuses and individually approved products", async () => {
    const { gw, store, products } = await prepared({ ...S, convertAllowedStatuses: ["DRAFT"], convertAllowedIds: [] });
    await store.saveSettings(SHOP, { ...S, convertAllowedStatuses: ["DRAFT"], convertAllowedIds: [products[1].id] });
    const op = await createOperation(store, gw, SHOP, { type: "convert", params: {}, selection: { mode: "IDS", ids: products.map((p) => p.id) }, userLabel: "t" });
    await runToEnd(store, gw, SHOP, op.id);
    const rows = (await store.results(SHOP, op.id)).map((t) => t.result!.status);
    expect(rows).toEqual(["skipped", "changed", "changed"]);
  });

  it("stops at the first product that fails its check", async () => {
    const { gw, store, products } = await prepared();
    gw.after = (call, args) => {
      if (call === "writeAttributes" && args[0] === products[0].id) gw.products.get(products[0].id)!.title = "tampered";
    };
    const op = await createOperation(store, gw, SHOP, { type: "convert", params: {}, selection: { mode: "IDS", ids: products.map((p) => p.id) }, userLabel: "t" });
    await runToEnd(store, gw, SHOP, op.id);
    expect(await store.getOperation(SHOP, op.id)).toMatchObject({ status: "stopped", failed: 1 });
  });

  it("refuses to convert while the store is dry-run only", async () => {
    const { gw, store, products } = await prepared({ ...DEFAULT_SETTINGS });
    await expect(createOperation(store, gw, SHOP, { type: "convert", params: {}, selection: { mode: "IDS", ids: [products[0].id] }, userLabel: "t" })).rejects.toThrow(/dry run only/);
  });
});
