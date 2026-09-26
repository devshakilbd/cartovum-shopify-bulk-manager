import { describe, expect, it } from "vitest";
import { applyAttributeOne, parseOp } from "../app/lib/core/attributes";
import { createOperation, createRevert, EngineError, requestStop, runToEnd, step } from "../app/lib/core/engine";
import { GatewayError } from "../app/lib/core/gateway";
import { makeProduct, MemoryGateway } from "../app/lib/core/memory-gateway";
import { MemoryStore } from "../app/lib/core/memory-store";
import { applyStockOne } from "../app/lib/core/stock";
import { DEFAULT_SETTINGS, type GlobalAttributeDefinition } from "../app/lib/core/types";

const SHOP = "a.myshopify.com";
const COLOUR: GlobalAttributeDefinition = { key: "shared.colour", label: "Colour", type: "list.single_line_text_field", choices: ["Red", "Blue", "Green", "Crimson"] };
const red = () => [{ key: "shared.colour", kind: "global" as const, type: "list.single_line_text_field" as const, values: ["Red"] }];

function setup(count = 3) {
  const products = Array.from({ length: count }, () => makeProduct({ attributes: red() }));
  const gw = new MemoryGateway(products, [COLOUR]);
  const store = new MemoryStore();
  return { gw, store, products };
}

const replace = (store: MemoryStore, gw: MemoryGateway, ids: string[]) =>
  createOperation(store, gw, SHOP, { type: "attributes", params: { op: "set_terms", attribute: "shared.colour", terms: ["Blue"] }, selection: { mode: "IDS", ids }, userLabel: "t" });

describe("verification never trusts a successful write", () => {
  it("fails a product when an unrelated field changed alongside the write", async () => {
    const { gw, products } = setup(1);
    gw.after = (call, args) => {
      if (call === "writeAttributes") gw.products.get(args[0] as string)!.variants[0].price = "99.00";
    };
    const op = parseOp({ op: "set_terms", attribute: "shared.colour", terms: ["Blue"] }, [COLOUR], DEFAULT_SETTINGS);
    const r = await applyAttributeOne(gw, products[0].id, op, DEFAULT_SETTINGS);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/variants/);
    expect(r.after).toBeDefined(); // still revertable
  });

  it("fails when the write reports success but did not stick", async () => {
    const { gw, products } = setup(1);
    gw.after = (call, args) => {
      if (call === "setInventoryTracked") gw.products.get(products[0].id)!.variants[0].tracked = !(args[1] as boolean);
    };
    const r = await applyStockOne(gw, products[0].id, "outofstock", DEFAULT_SETTINGS);
    expect(r).toMatchObject({ status: "failed", message: expect.stringMatching(/did not stick/) });
  });

  it("a write rejected by Shopify is failed with no after-state", async () => {
    const { gw, products } = setup(1);
    gw.before = (call) => {
      if (call === "writeAttributes") throw new GatewayError("The option combination already exists.");
    };
    const op = parseOp({ op: "set_terms", attribute: "shared.colour", terms: ["Blue"] }, [COLOUR], DEFAULT_SETTINGS);
    const r = await applyAttributeOne(gw, products[0].id, op, DEFAULT_SETTINGS);
    expect(r).toMatchObject({ status: "failed", message: expect.stringMatching(/option combination/) });
    expect(r.after).toBeUndefined();
  });

  it("a timeout that actually applied is verified by reading back, not retried", async () => {
    const { gw, products } = setup(1);
    gw.after = (call) => {
      if (call === "writeAttributes") throw new GatewayError("timeout", true);
    };
    const op = parseOp({ op: "set_terms", attribute: "shared.colour", terms: ["Blue"] }, [COLOUR], DEFAULT_SETTINGS);
    const r = await applyAttributeOne(gw, products[0].id, op, DEFAULT_SETTINGS);
    expect(r.status).toBe("changed");
    expect(gw.calls.filter((c) => c === "writeAttributes")).toHaveLength(1);
  });

  it("a product deleted mid-run fails cleanly and the run continues", async () => {
    const { gw, store, products } = setup(3);
    gw.products.delete(products[1].id);
    const o = await replace(store, gw, products.map((p) => p.id));
    await runToEnd(store, gw, SHOP, o.id);
    const done = await store.getOperation(SHOP, o.id);
    expect(done).toMatchObject({ status: "completed", changed: 2, failed: 1 });
  });
});

describe("revert", () => {
  it("puts a run back and refuses to revert a revert or revert twice", async () => {
    const { gw, store, products } = setup(2);
    const o = await replace(store, gw, products.map((p) => p.id));
    await runToEnd(store, gw, SHOP, o.id);
    const rv = await createRevert(store, SHOP, o.id, "t");
    await runToEnd(store, gw, SHOP, rv.id);
    expect(await store.getOperation(SHOP, rv.id)).toMatchObject({ changed: 2, status: "completed" });
    expect([...gw.products.values()].every((p) => p.attributes[0].values[0] === "Red")).toBe(true);
    expect((await store.getOperation(SHOP, o.id))!.revertedBy).toBe(rv.id);
    await expect(createRevert(store, SHOP, rv.id, "t")).rejects.toThrow(/cannot itself be reverted/);
    await expect(createRevert(store, SHOP, o.id, "t")).rejects.toThrow(/already been put back/);
  });

  it("blocks a revert where the product changed manually since (Blue -> Green is never overwritten)", async () => {
    const { gw, store, products } = setup(2);
    const o = await replace(store, gw, products.map((p) => p.id));
    await runToEnd(store, gw, SHOP, o.id);
    gw.products.get(products[0].id)!.attributes[0].values = ["Green"];
    const rv = await createRevert(store, SHOP, o.id, "t");
    await runToEnd(store, gw, SHOP, rv.id);
    const rows = (await store.results(SHOP, rv.id)).map((t) => t.result!);
    expect(rows[0]).toMatchObject({ status: "skipped", message: expect.stringContaining("expected: Blue; current: Green") });
    expect(gw.products.get(products[0].id)!.attributes[0].values).toEqual(["Green"]);
    expect(rows[1].status).toBe("changed");
  });

  it("reverts stock only where the stock state is still what the run left", async () => {
    const products = [makeProduct(), makeProduct()];
    const gw = new MemoryGateway(products);
    const store = new MemoryStore();
    const o = await createOperation(store, gw, SHOP, { type: "stock", params: { stockStatus: "outofstock" }, selection: { mode: "IDS", ids: products.map((p) => p.id) }, userLabel: "t" });
    await runToEnd(store, gw, SHOP, o.id);
    gw.products.get(products[1].id)!.variants[0].inventoryPolicy = "CONTINUE";
    const rv = await createRevert(store, SHOP, o.id, "t");
    await runToEnd(store, gw, SHOP, rv.id);
    expect(gw.products.get(products[0].id)!.variants[0].tracked).toBe(false);
    expect(gw.products.get(products[1].id)!.variants[0]).toMatchObject({ tracked: true, inventoryPolicy: "CONTINUE" });
  });
});

describe("jobs", () => {
  it("processes in batches of 10 and stops after the current batch", async () => {
    const { gw, store, products } = setup(35);
    const o = await replace(store, gw, products.map((p) => p.id));
    await step(store, gw, SHOP, o.id);
    expect(await store.getOperation(SHOP, o.id)).toMatchObject({ processed: 10, status: "running" });
    await requestStop(store, SHOP, o.id);
    await runToEnd(store, gw, SHOP, o.id);
    expect(await store.getOperation(SHOP, o.id)).toMatchObject({ processed: 10, status: "stopped" });
  });

  it("refuses an oversized batch rather than trimming it", async () => {
    const { gw, store, products } = setup(1);
    const o = await replace(store, gw, [products[0].id]);
    await expect(step(store, gw, SHOP, o.id, 26)).rejects.toThrow(EngineError);
  });

  it("does not apply twice after an interruption mid-write", async () => {
    const { gw, store, products } = setup(1);
    const o = await replace(store, gw, [products[0].id]);
    // Crash after the write lands but before the result is saved.
    const save = store.saveResult.bind(store);
    store.saveResult = async () => {
      throw new Error("process killed");
    };
    await expect(step(store, gw, SHOP, o.id)).rejects.toThrow();
    store.saveResult = save;
    await runToEnd(store, gw, SHOP, o.id);
    const [t] = await store.results(SHOP, o.id);
    expect(t.result).toMatchObject({ status: "failed", message: expect.stringMatching(/interrupted/) });
    expect(gw.calls.filter((c) => c === "writeAttributes")).toHaveLength(1);
    // Still revertable.
    const rv = await createRevert(store, SHOP, o.id, "t");
    await runToEnd(store, gw, SHOP, rv.id);
    expect(gw.products.get(products[0].id)!.attributes[0].values).toEqual(["Red"]);
  });

  it("resolves select-all-matching on the server and snapshots the targets", async () => {
    const { gw, store } = setup(0);
    for (let i = 0; i < 600; i++) {
      const p = makeProduct({ attributes: i % 3 === 0 ? red() : [] });
      gw.products.set(p.id, p);
    }
    const o = await createOperation(store, gw, SHOP, {
      type: "attributes",
      params: { op: "set_terms", attribute: "shared.colour", terms: ["Crimson"] },
      selection: { mode: "ALL_MATCHING", filters: { conditions: [{ attribute: "shared.colour", value: "Red" }] } },
      userLabel: "t",
    });
    await runToEnd(store, gw, SHOP, o.id);
    expect(await store.getOperation(SHOP, o.id)).toMatchObject({ total: 200, changed: 200, status: "completed" });
  });

  it("isolates shops: another shop cannot read, step, or revert an operation", async () => {
    const { gw, store, products } = setup(1);
    const o = await replace(store, gw, [products[0].id]);
    expect(await store.getOperation("b.myshopify.com", o.id)).toBeNull();
    expect(await step(store, gw, "b.myshopify.com", o.id)).toBe(false);
    await expect(createRevert(store, "b.myshopify.com", o.id, "t")).rejects.toThrow(/not in the log/);
    expect(await store.results("b.myshopify.com", o.id)).toEqual([]);
  });

  it("keeps the newest runs only, never pruning one still running", async () => {
    const { gw, store, products } = setup(1);
    await store.saveSettings(SHOP, { ...DEFAULT_SETTINGS, keepJobs: 2 });
    const running = await replace(store, gw, [products[0].id]);
    for (let i = 0; i < 3; i++) await runToEnd(store, gw, SHOP, (await replace(store, gw, [products[0].id])).id);
    const list = await store.listOperations(SHOP, 50);
    expect(list.map((o) => o.id)).toContain(running.id);
    expect(list.length).toBe(3);
  });
});
