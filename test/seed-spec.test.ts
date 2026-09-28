import { existsSync, readFileSync } from "node:fs";
import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { CREATE_COLLECTION, CREATE_DEFINITION, PREFLIGHT, productSetChunk } from "../scripts/seed/documents";
import { checkSpec, DEFINITIONS, EXPECTED_FILTERS, FAKE_COLLECTION_IDS, PRODUCTS, productSetInput, SEED_TAG, STORE, type ProductSpec } from "../scripts/seed/spec";

/** The development-store seed, checked offline. Nothing here talks to Shopify. */

const byId = (id: string) => PRODUCTS.find((p) => p.id === id)!;
const LOC = "gid://shopify/Location/1";

describe("seed matrix", () => {
  it("is consistent with the app's own stock and filter rules", () => {
    expect(checkSpec()).toEqual([]);
  });

  it("has the audit-corrected shape: 41 seeded products, K1 left for manual creation, X1 the only control", () => {
    expect(STORE).toBe("cartovum-bulk-dev.myshopify.com");
    expect(PRODUCTS).toHaveLength(41);
    expect(PRODUCTS.some((p) => p.id === "K1")).toBe(false);
    expect(PRODUCTS.filter((p) => !p.mutationSafe).map((p) => p.id)).toEqual(["X1"]);
    expect(PRODUCTS.filter((p) => p.variants.length > 1).map((p) => p.id)).toEqual(["S5", "A9", "C8"]);
    expect(PRODUCTS.every((p) => p.tags.includes(SEED_TAG) && p.title.startsWith("CBM Test "))).toBe(true);
    expect(byId("X1").tags).toContain("control");
    expect(EXPECTED_FILTERS.find((f) => f.name === "Colour = Red")!.ids).toHaveLength(18);
    expect(byId("A10").attributes).toEqual([{ ns: "shared", key: "centre_bore", type: "single_line_text_field", values: ["57.1"] }]);
    expect(byId("C9").attributes[0]).toMatchObject({ type: "list.single_line_text_field", values: ["17", "18"] });
  });

  it("catches a broken matrix (the checker is not vacuous)", () => {
    const bad: ProductSpec = {
      ...byId("A1"),
      id: "BAD",
      handle: "cbm-test-a1",
      attributes: [{ ns: "shared", key: "colour", type: "list.single_line_text_field", values: ["Purple"] }],
      variants: [{ sku: "CBM-S1", inventory: { tracked: true, onHand: 0, policy: "DENY" } }],
    };
    PRODUCTS.push(bad);
    try {
      const problems = checkSpec().join("\n");
      expect(problems).toMatch(/Duplicate handle: cbm-test-a1/);
      expect(problems).toMatch(/Duplicate SKU: CBM-S1/);
      expect(problems).toMatch(/"Purple" is not a choice of shared.colour/);
      expect(problems).toMatch(/BAD: inventory setup gives outofstock, matrix says instock/);
      expect(problems).toMatch(/Filter "Stock Out of stock": app returns \[BAD, S2\]/);
    } finally {
      PRODUCTS.pop();
    }
  });
});

describe("productSet input", () => {
  it("untracked variants get no quantity; tracked ones get an explicit on-hand quantity, including 0", () => {
    const s1 = productSetInput(byId("S1"), LOC, FAKE_COLLECTION_IDS).variants[0];
    expect(s1).toMatchObject({ sku: "CBM-S1", inventoryItem: { tracked: false }, inventoryPolicy: "DENY" });
    expect(s1).not.toHaveProperty("inventoryQuantities");
    expect(productSetInput(byId("S2"), LOC, FAKE_COLLECTION_IDS).variants[0]).toMatchObject({ inventoryItem: { tracked: true }, inventoryQuantities: [{ locationId: LOC, name: "on_hand", quantity: 0 }] });
    expect(productSetInput(byId("S3"), LOC, FAKE_COLLECTION_IDS).variants[0].inventoryPolicy).toBe("CONTINUE");
    expect(productSetInput(byId("S4"), LOC, FAKE_COLLECTION_IDS).variants[0].inventoryQuantities).toEqual([{ locationId: LOC, name: "on_hand", quantity: 5 }]);
  });

  it("a simple product has the Title / Default Title option; a product with variants has its own option", () => {
    const a1 = productSetInput(byId("A1"), LOC, FAKE_COLLECTION_IDS);
    expect(a1.productOptions).toEqual([{ name: "Title", values: [{ name: "Default Title" }] }]);
    expect(a1.variants[0].optionValues).toEqual([{ optionName: "Title", name: "Default Title" }]);
    const a9 = productSetInput(byId("A9"), LOC, FAKE_COLLECTION_IDS);
    expect(a9.productOptions).toEqual([{ name: "Colour", values: [{ name: "Red" }, { name: "Blue" }] }]);
    expect(a9.variants.map((v) => v.sku)).toEqual(["CBM-A9-R", "CBM-A9-B"]);
  });

  it("writes list metafields as JSON and single ones as plain text; collections by ID", () => {
    const f1 = productSetInput(byId("F1"), LOC, FAKE_COLLECTION_IDS);
    expect(f1.metafields).toEqual([
      { namespace: "shared", key: "colour", type: "list.single_line_text_field", value: '["Red"]' },
      { namespace: "cartovum_local", key: "material", type: "single_line_text_field", value: "Aluminium" },
    ]);
    expect(f1.collections).toEqual([FAKE_COLLECTION_IDS.winter]);
    expect(f1.status).toBe("ACTIVE");
    expect(productSetInput(byId("X1"), LOC, FAKE_COLLECTION_IDS).status).toBe("UNLISTED");
    expect(productSetInput(byId("C9"), LOC, FAKE_COLLECTION_IDS).metafields[0].value).toBe('["17","18"]');
  });

  it("definitions carry their choices as the choices validation", () => {
    const bore = DEFINITIONS.find((d) => d.key === "centre_bore")!;
    expect(bore).toMatchObject({ type: "single_line_text_field", choices: ["57.1", "66.1", "66.1mm"] });
  });
});

// Checked when the Admin API schema has been downloaded (npm run graphql-codegen); it is not committed.
const SCHEMA = "app/types/admin-2026-07.schema.json";
describe.skipIf(!existsSync(SCHEMA))("seed GraphQL documents against the 2026-07 schema", () => {
  it("every document is valid", () => {
    const json = JSON.parse(readFileSync(SCHEMA, "utf8"));
    const schema = buildClientSchema(json.data ?? json);
    for (const doc of [PREFLIGHT, CREATE_DEFINITION, CREATE_COLLECTION, productSetChunk(1), productSetChunk(5)]) {
      expect(validate(schema, parse(doc)).map((e) => e.message)).toEqual([]);
    }
  });
});
