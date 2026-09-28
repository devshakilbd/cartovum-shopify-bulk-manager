import { createOperation, requestStop, step } from "../../app/lib/core/engine";
import type { Operation } from "../../app/lib/core/store";
import { BATCH_SIZE, type ProductState } from "../../app/lib/core/types";
import { LABEL, SHOP, type Harness } from "./harness";

/** Phase 6: select all matching B01–B12 across pages, batches of 10, stop after a batch, Put Back, protection after a manual edit. */

const B = Array.from({ length: 12 }, (_, i) => `B${String(i + 1).padStart(2, "0")}`);
const colour = (p: ProductState) => p.attributes.find((a) => a.key === "shared.colour")?.values ?? null;
const crimson = { op: "set_terms", attribute: "shared.colour", terms: ["Crimson"] };

function allColour(h: Harness, label: string, products: Record<string, ProductState>, keys: string[], want: string[]) {
  const wrong = keys.filter((k) => JSON.stringify(colour(products[k])) !== JSON.stringify(want));
  return h.check(wrong.length === 0, label, wrong.map((k) => `${k}=${JSON.stringify(colour(products[k]))}`).join(", "));
}

export async function batchSuite(h: Harness) {
  const phase = "6 Select all / batch";
  h.check(BATCH_SIZE === 10, "engine batch size is 10", `BATCH_SIZE=${BATCH_SIZE}`);
  const original = await h.read(B);
  allColour(h, "B01–B12 start as Colour [Red]", original, B, ["Red"]);

  // 1–5, 8–9: select all matching (tag batch) → Crimson → verify → Put Back → verify
  h.begin(phase, "select all matching (tag batch), Red → Crimson, batches of 10, Put Back");
  const progress: number[] = [];
  const r = await h.run({ type: "attributes", params: crimson, selection: { mode: "ALL_MATCHING", filters: { tags: "batch" } } }, (op: Operation) => {
    if (op.processed && progress[progress.length - 1] !== op.processed) progress.push(op.processed);
  });
  h.eq("selection resolved on the server from the filter", [r.op.selectionMode, r.op.total], ["ALL_MATCHING", 12]);
  h.eq("12 changed, 0 skipped, 0 failed", [r.op.changed, r.op.skipped, r.op.failed, r.op.status], [12, 0, 0, "completed"]);
  h.check(progress.includes(10) && progress[progress.length - 1] === 12, "progress seen in batches of 10 then 2", `processed values seen: ${progress.join(" → ")}`);
  h.check(Object.values(r.rows).every((row) => row.status === "changed" && /Colour: Red to Crimson/.test(row.message)), "every product has its own result and reason", `${Object.keys(r.rows).length} rows`);
  allColour(h, "all 12 read back as Crimson", await h.read(B), B, ["Crimson"]);
  const back = await h.putBack(r.op.id);
  h.eq("Put Back: 12 changed", [back.op.changed, back.op.skipped, back.op.failed], [12, 0, 0]);
  h.sameAsBefore(original, await h.read(B), "all 12 restored exactly");

  // 6–7: stop after the first batch
  h.begin(phase, "stop after the first batch");
  const op = await createOperation(h.leased, h.gw, SHOP, { type: "attributes", params: crimson, selection: { mode: "IDS", ids: B.map((k) => h.id(k)) }, userLabel: LABEL });
  h.log(`    run ${op.id}: stepping one batch with the app's engine (the worker is kept off this run by a lease)`);
  await step(h.store, h.gw, SHOP, op.id);
  const afterOne = await h.store.getOperation(SHOP, op.id);
  h.eq("after one step: 10 processed", afterOne?.processed, 10);
  await requestStop(h.store, SHOP, op.id);
  await step(h.store, h.gw, SHOP, op.id);
  const stopped = (await h.store.getOperation(SHOP, op.id))!;
  await h.store.updateOperation(SHOP, op.id, { leaseUntil: null });
  h.eq("run stopped with 10 changed", [stopped.status, stopped.processed, stopped.changed], ["stopped", 10, 10]);
  const mid = await h.read(B);
  allColour(h, "B01–B10 changed", mid, B.slice(0, 10), ["Crimson"]);
  allColour(h, "B11–B12 untouched", mid, B.slice(10), ["Red"]);
  const back2 = await h.putBack(op.id);
  h.eq("Put Back of the stopped run: 10 changed", [back2.op.changed, back2.op.skipped, back2.op.failed], [10, 0, 0]);
  h.sameAsBefore(original, await h.read(B), "all 12 restored exactly");

  // 10–12: a product changed by hand after the run is skipped by Put Back
  h.begin(phase, "B03 changed by hand after the run: Put Back skips it, restores the other 11");
  const r3 = await h.run({ type: "attributes", params: crimson, selection: { mode: "ALL_MATCHING", filters: { tags: "batch" } } });
  h.eq("12 changed", r3.op.changed, 12);
  h.log("    simulated merchant edit: B03 Colour set to Black through the Admin API");
  await h.gw.writeAttributes(h.id("B03"), [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Black"] }], []);
  const back3 = await h.putBack(r3.op.id);
  h.check(back3.rows.B03?.status === "skipped" && /expected: Crimson; current: Black/.test(back3.rows.B03.message), "B03 skipped, message names expected and current", back3.rows.B03?.message);
  h.eq("Put Back: 11 changed, 1 skipped, 0 failed", [back3.op.changed, back3.op.skipped, back3.op.failed], [11, 1, 0]);
  const now = await h.read(B);
  allColour(h, "the other 11 restored to Red", now, B.filter((k) => k !== "B03"), ["Red"]);
  h.eq("B03 left as edited (Black), not overwritten", colour(now.B03), ["Black"]);
  h.log("    restoring B03 to its seed value by hand");
  await h.gw.writeAttributes(h.id("B03"), [{ key: "shared.colour", kind: "global", type: "list.single_line_text_field", values: ["Red"] }], []);
  h.sameAsBefore(original, await h.read(B), "all 12 back to their seed state");
}
