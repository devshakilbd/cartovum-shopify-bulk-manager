import { describe, expect, it } from "vitest";
import { createOperation, createRevert, runToEnd } from "../app/lib/core/engine";
import { GatewayError } from "../app/lib/core/gateway";
import { makeProduct, MemoryGateway } from "../app/lib/core/memory-gateway";
import { MemoryStore } from "../app/lib/core/memory-store";
import type { GlobalAttributeDefinition } from "../app/lib/core/types";

const SHOP = "a.myshopify.com";
const COLOUR: GlobalAttributeDefinition = { key: "shared.colour", label: "Colour", type: "list.single_line_text_field", choices: ["Red", "Crimson"] };

for (const size of [10, 100, 1000, 10000]) {
  describe(`${size} products`, () => {
    it("selects all matching, batches, reports, and reverts", async () => {
      const gw = new MemoryGateway([], [COLOUR]);
      for (let i = 0; i < size; i++) {
        const p = makeProduct({ attributes: [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }] });
        gw.products.set(p.id, p);
      }
      // Every 97th write is rejected by Shopify.
      gw.before = (call, args) => {
        if (call === "writeAttributes" && Number(String(args[0]).split("/").pop()) % 97 === 0) throw new GatewayError("Throttled");
      };
      const store = new MemoryStore();
      const heap = process.memoryUsage().heapUsed;
      const op = await createOperation(store, gw, SHOP, {
        type: "attributes",
        params: { op: "set_terms", attribute: "shared.colour", terms: ["Crimson"] },
        selection: { mode: "ALL_MATCHING", filters: { conditions: [{ attribute: "shared.colour", value: "Red" }] } },
        userLabel: "t",
      });
      await runToEnd(store, gw, SHOP, op.id);
      const done = (await store.getOperation(SHOP, op.id))!;
      const rejected = [...gw.products.keys()].filter((id) => Number(id.split("/").pop()) % 97 === 0).length;
      expect(done).toMatchObject({ status: "completed", total: size, processed: size, failed: rejected, changed: size - rejected });
      expect((await store.results(SHOP, op.id)).every((t) => t.result && t.result.message)).toBe(true);
      expect(process.memoryUsage().heapUsed - heap).toBeLessThan(1024 * 1024 * 1024);

      gw.before = null;
      const rv = await createRevert(store, SHOP, op.id, "t");
      await runToEnd(store, gw, SHOP, rv.id);
      expect([...gw.products.values()].every((p) => p.attributes[0].values[0] === "Red")).toBe(true);
    }, 120_000);
  });
}
