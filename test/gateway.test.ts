import { describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/log.server", () => ({ log: () => undefined }));
const { ShopifyGateway } = await import("../app/lib/gateway.server");
const { DEFAULT_SETTINGS } = await import("../app/lib/core/types");

const definitions = {
  metafieldDefinitions: {
    nodes: [
      { namespace: "shared", key: "colour", name: "Colour", type: { name: "list.single_line_text_field" }, validations: [{ name: "choices", value: '["Red","Blue"]' }] },
      { namespace: "custom", key: "notes", name: "Notes", type: { name: "multi_line_text_field" }, validations: [] },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};
const productNode = {
  id: "gid://shopify/Product/1",
  title: "Wheel",
  handle: "wheel",
  status: "ACTIVE",
  vendor: "V",
  productType: "T",
  tags: ["a"],
  descriptionHtml: "<p>x</p>",
  templateSuffix: null,
  hasOnlyDefaultVariant: true,
  category: null,
  featuredMedia: null,
  options: [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
  media: { nodes: [] },
  collections: { nodes: [{ id: "gid://shopify/Collection/9" }] },
  metafields: {
    nodes: [
      { namespace: "shared", key: "colour", type: "list.single_line_text_field", value: '["Red"]' },
      { namespace: "cartovum_local", key: "size", type: "single_line_text_field", value: "18" },
      { namespace: "other_app", key: "x", type: "single_line_text_field", value: "ignored" },
    ],
  },
  variants: {
    nodes: [
      {
        id: "gid://shopify/ProductVariant/1",
        title: "Default Title",
        sku: "S-1",
        price: "1.00",
        compareAtPrice: null,
        barcode: null,
        inventoryPolicy: "DENY",
        selectedOptions: [{ name: "Title", value: "Default Title" }],
        inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true, inventoryLevels: { nodes: [{ location: { id: "L1" }, quantities: [{ name: "on_hand", quantity: 0 }, { name: "available", quantity: 0 }] }] } },
      },
    ],
  },
};

function client(responses: ((q: string, v: unknown) => unknown)[]) {
  const calls: { query: string; variables: unknown }[] = [];
  return {
    calls,
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: opts?.variables });
      const next = responses.shift();
      if (!next) throw new Error("unexpected call");
      const body = next(query, opts?.variables);
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body));
    },
  };
}

describe("ShopifyGateway", () => {
  it("maps a product: global vs local attributes, other namespaces ignored, inventory levels read", async () => {
    const c = client([() => ({ data: { nodes: [productNode] } }), () => ({ data: definitions })]);
    const gw = new ShopifyGateway(c, DEFAULT_SETTINGS, "a");
    const [p] = await gw.getProducts(["gid://shopify/Product/1"]);
    expect(p.attributes).toEqual([
      { key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] },
      { key: "cartovum_local.size", kind: "local", type: "single_line_text_field", values: ["18"] },
    ]);
    expect(p.variants[0]).toMatchObject({ tracked: true, levels: [{ locationId: "L1", onHand: 0, available: 0 }] });
    expect(p.collectionIds).toEqual(["gid://shopify/Collection/9"]);
    // Only definitions with a fixed list of values are shared attributes.
    expect((await gw.getGlobalAttributes()).map((g) => g.key)).toEqual(["shared.colour"]);
    // IDs travel as variables, never inside the query text.
    expect(c.calls[0].query).not.toContain("Product/1");
  });

  it("retries a throttled read with backoff", async () => {
    vi.useFakeTimers();
    const c = client([() => ({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }), () => ({ data: { nodes: [] } })]);
    const gw = new ShopifyGateway(c, DEFAULT_SETTINGS, "a");
    const p = gw.getProducts(["gid://shopify/Product/1"]);
    await vi.runAllTimersAsync();
    expect(await p).toEqual([]);
    expect(c.calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("never retries a write; transport failure is marked uncertain; userErrors are surfaced", async () => {
    const c = client([() => new Error("fetch failed")]);
    const gw = new ShopifyGateway(c, DEFAULT_SETTINGS, "a");
    await expect(gw.setInventoryTracked("gid://shopify/InventoryItem/1", false)).rejects.toMatchObject({ uncertain: true });
    expect(c.calls).toHaveLength(1);

    const c2 = client([() => ({ data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["value"], message: "Value must be one of the choices." }] } } })]);
    const gw2 = new ShopifyGateway(c2, DEFAULT_SETTINGS, "a");
    await expect(gw2.writeAttributes("gid://shopify/Product/1", [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["X"] }], [])).rejects.toThrow("Value must be one of the choices.");
    expect(c2.calls[0].variables).toEqual({ metafields: [{ ownerId: "gid://shopify/Product/1", namespace: "shared", key: "colour", type: "list.single_line_text_field", value: '["X"]' }] });
  });
});
