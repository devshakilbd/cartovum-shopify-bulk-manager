import { beforeEach, describe, expect, it, vi } from "vitest";
import { runToEnd } from "../app/lib/core/engine";
import { makeProduct, MemoryGateway } from "../app/lib/core/memory-gateway";
import { MemoryStore } from "../app/lib/core/memory-store";

/**
 * The real route handlers, with Shopify authentication and the GraphQL gateway replaced by the
 * in-memory store. Covers the request flow the screens use: search, select all, preview, confirm/start,
 * progress, results, revert, dry run, CSV, settings, and input hardening.
 */

const state = vi.hoisted(() => ({ scope: "write_products,write_inventory", shop: "a.myshopify.com", store: null as unknown as MemoryStore, gw: null as unknown as MemoryGateway }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: state.shop, onlineAccessInfo: { associated_user_scope: state.scope } }, admin: {} }) },
}));
vi.mock("../app/lib/services.server", () => ({
  get store() {
    return state.store;
  },
  gatewayFor: async () => Object.assign(state.gw, { countProducts: async () => state.gw.products.size }),
  localValues: async () => state.gw.getLocalAttributeValues(),
}));
vi.mock("../app/lib/log.server", () => ({ log: () => undefined }));

const route = await import("../app/routes/app.api.$action");
const COLOUR = { key: "shared.colour", label: "Colour", type: "list.single_line_text_field" as const, choices: ["Red", "Blue", "=HYPERLINK()"] };

async function post(action: string, body: unknown) {
  const res = await route.action({ request: new Request(`https://x/app/api/${action}`, { method: "POST", body: JSON.stringify(body) }), params: { action }, context: {} } as never);
  return { status: res.status, body: await res.json() };
}
async function get(action: string, query = "") {
  const res = (await route.loader({ request: new Request(`https://x/app/api/${action}${query}`), params: { action }, context: {} } as never)) as Response;
  return res.headers.get("Content-Type")?.includes("csv") ? { status: res.status, text: await res.text() } : { status: res.status, body: await res.json() };
}

beforeEach(() => {
  state.store = new MemoryStore();
  state.gw = new MemoryGateway(
    Array.from({ length: 30 }, (_, i) => makeProduct({ attributes: i < 12 ? [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }] : [] })),
    [COLOUR],
  );
});

describe("api", () => {
  it("search returns a page, a cursor and the total", async () => {
    const r = await post("search", { filters: { perPage: 25 } });
    expect(r.body.items).toHaveLength(25);
    expect(r.body.total).toBe(30);
    const next = await post("search", { filters: { perPage: 25 }, cursor: r.body.next });
    expect(next.body.items).toHaveLength(5);
  });

  it("select all matching -> preview -> start -> progress -> results -> revert", async () => {
    const filters = { conditions: [{ attribute: "shared.colour", value: "Red" }] };
    const params = { op: "set_terms", attribute: "shared.colour", terms: ["Blue"] };
    const preview = await post("preview", { type: "attributes", params, filters });
    expect(preview.body.rows.every((r: { status: string }) => r.status === "changed")).toBe(true);
    expect(state.gw.calls).not.toContain("writeAttributes");

    const started = await post("start", { type: "attributes", params, selectionMode: "ALL_MATCHING", filters });
    await runToEnd(state.store, state.gw, state.shop, started.body.operation.id);
    const run = await get("operation", `?id=${started.body.operation.id}`);
    expect(run.body.operation).toMatchObject({ total: 12, changed: 12, status: "completed" });
    expect(run.body.results[0]).not.toHaveProperty("before"); // full states stay server-side

    const rv = await post("revert", { id: started.body.operation.id });
    await runToEnd(state.store, state.gw, state.shop, rv.body.operation.id);
    expect((await get("operation", `?id=${rv.body.operation.id}`)).body.operation.changed).toBe(12);
  });

  it("config lists product types and tags, and search filters by them", async () => {
    const [a, b] = [...state.gw.products.values()];
    Object.assign(a, { productType: "Wheel", tags: ["sale"] });
    Object.assign(b, { productType: "Tyre", tags: ["sale", "winter"] });
    const config = await get("config");
    expect(config.body).toMatchObject({ productTypes: ["Tyre", "Wheel"], productTags: ["sale", "winter"] });
    const r = await post("search", { filters: { tags: "sale", productType: "tyre" } });
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([b.id]);
    expect(r.body.items[0]).toMatchObject({ productType: "Tyre", tags: ["sale", "winter"] });
    expect(r.body.total).toBeNull();
  });

  it("refuses bad input with a readable message", async () => {
    expect((await post("start", { type: "attributes", params: { op: "add_terms", attribute: "shared.colour", terms: ["Purple"] }, selectionMode: "IDS", ids: [state.gw.products.keys().next().value] })).body.error).toMatch(/does not exist/);
    expect((await post("start", { type: "stock", params: { stockStatus: "x" }, selectionMode: "IDS", ids: [] })).body.error).toBe("Choose a stock status.");
    expect((await post("start", { type: "stock", params: { stockStatus: "instock" }, selectionMode: "IDS", ids: ["1 OR 1", "gid://shopify/Order/1"] })).body.error).toBe("Select some products first.");
    expect((await post("nope", {})).status).toBe(404);
  });

  it("refuses writes from a staff member without write permission", async () => {
    state.scope = "write_products";
    const ids = [state.gw.products.keys().next().value];
    const r = await post("start", { type: "stock", params: { stockStatus: "outofstock" }, selectionMode: "IDS", ids });
    expect(r.body.error).toMatch(/permission to change products or inventory/);
    state.scope = "";
    expect((await post("settings", {})).body.error).toMatch(/permission/);
    state.scope = "write_products,write_inventory";
    expect((await post("start", { type: "stock", params: { stockStatus: "outofstock" }, selectionMode: "IDS", ids })).status).toBe(200);
  });

  it("never exposes another shop's runs", async () => {
    const started = await post("start", { type: "stock", params: { stockStatus: "outofstock" }, selectionMode: "IDS", ids: [state.gw.products.keys().next().value] });
    state.shop = "b.myshopify.com";
    expect((await get("operation", `?id=${started.body.operation.id}`)).status).toBe(404);
    expect((await post("revert", { id: started.body.operation.id })).body.error).toMatch(/not in the log/);
    expect((await get("operations")).body.operations).toEqual([]);
    state.shop = "a.myshopify.com";
  });

  it("dry run is readable as CSV with formula cells neutralised", async () => {
    await state.store.saveSettings(state.shop, { ...(await state.store.getSettings(state.shop)), convertWritesEnabled: true });
    const p = makeProduct({ attributes: [{ key: "cartovum_local.colour", kind: "local", type: "single_line_text_field", values: ["=HYPERLINK()"] }] });
    state.gw.products.set(p.id, p);
    const dry = await post("dryrun", {});
    await runToEnd(state.store, state.gw, state.shop, dry.body.operation.id);
    const csv = await get("csv");
    expect(csv.text).toContain(`"'=HYPERLINK()"`);
  });

  it("decisions are locked while conversion is dry-run only, and validated when on", async () => {
    expect((await post("decision", { what: "override", key: "shared.colour", value: "rouge", target: "Red" })).status).toBe(403);
    await post("settings", { convertWritesEnabled: true, localNamespaces: "cartovum_local, app--evil" });
    expect((await state.store.getSettings(state.shop)).localNamespaces).toEqual(["cartovum_local"]);
    expect((await post("decision", { what: "override", key: "shared.colour", value: "rouge", target: "Crimson" })).body.error).toMatch(/does not exist/);
    expect((await post("decision", { what: "override", key: "shared.colour", value: "rouge", target: "Red" })).body.decisions.overrides).toEqual({ "shared.colour": { rouge: "Red" } });
  });
});
