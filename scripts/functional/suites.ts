import { variantStockStatus } from "../../app/lib/core/fingerprint";
import type { ProductState } from "../../app/lib/core/types";
import type { Harness } from "./harness";

/** Every suite follows BEFORE → CHANGE → VERIFY AFTER → PUT BACK → VERIFY RESTORED, on seed products only. */

const inv = (p: ProductState) => {
  const v = p.variants[0];
  return { tracked: v.tracked, policy: v.inventoryPolicy, onHand: v.levels.reduce((n, l) => n + l.onHand, 0), stock: variantStockStatus(v) };
};
const attr = (p: ProductState, key: string) => p.attributes.find((a) => a.key === key)?.values ?? null;

/* ---------------------------------------------------------------------------------------- stock */

export async function stockSuite(h: Harness) {
  const phase = "3 Stock";

  // S1: untracked, In stock → Out of stock → Put Back
  h.begin(phase, "S1 untracked → Out of stock, then Put Back");
  let before = await h.read(["S1"]);
  h.eq("S1 before: untracked, In stock", inv(before.S1), { tracked: false, policy: "DENY", onHand: 0, stock: "instock" });
  let r = await h.run({ type: "stock", params: { stockStatus: "outofstock" }, selection: { mode: "IDS", ids: [h.id("S1")] } });
  h.eq("S1 result", [r.rows.S1?.status, r.rows.S1?.message], ["changed", "instock to outofstock"]);
  let after = await h.read(["S1"]);
  h.eq("S1 after: tracked, stop selling, quantity still 0, Out of stock", inv(after.S1), { tracked: true, policy: "DENY", onHand: 0, stock: "outofstock" });
  let back = await h.putBack(r.op.id);
  h.eq("Put Back result", [back.rows.S1?.status], ["changed"]);
  h.sameAsBefore(before, await h.read(["S1"]));

  // S2: tracked 0, stop selling → On backorder
  h.begin(phase, "S2 tracked 0, stop selling → On backorder, then Put Back");
  before = await h.read(["S2"]);
  h.eq("S2 before", inv(before.S2), { tracked: true, policy: "DENY", onHand: 0, stock: "outofstock" });
  r = await h.run({ type: "stock", params: { stockStatus: "onbackorder" }, selection: { mode: "IDS", ids: [h.id("S2")] } });
  h.eq("S2 result", [r.rows.S2?.status, r.rows.S2?.message], ["changed", "outofstock to onbackorder"]);
  after = await h.read(["S2"]);
  h.eq("S2 after: continue selling, still tracked at 0", inv(after.S2), { tracked: true, policy: "CONTINUE", onHand: 0, stock: "onbackorder" });
  back = await h.putBack(r.op.id);
  h.eq("Put Back result", [back.rows.S2?.status], ["changed"]);
  h.sameAsBefore(before, await h.read(["S2"]));

  // S3: tracked 0, continue selling → In stock
  h.begin(phase, "S3 tracked 0, continue selling → In stock, then Put Back");
  before = await h.read(["S3"]);
  h.eq("S3 before", inv(before.S3), { tracked: true, policy: "CONTINUE", onHand: 0, stock: "onbackorder" });
  r = await h.run({ type: "stock", params: { stockStatus: "instock" }, selection: { mode: "IDS", ids: [h.id("S3")] } });
  h.eq("S3 result", [r.rows.S3?.status, r.rows.S3?.message], ["changed", "onbackorder to instock"]);
  after = await h.read(["S3"]);
  h.eq("S3 after: tracking off, policy unchanged (CONTINUE), quantity untouched", inv(after.S3), { tracked: false, policy: "CONTINUE", onHand: 0, stock: "instock" });
  back = await h.putBack(r.op.id);
  h.eq("Put Back result", [back.rows.S3?.status], ["changed"]);
  h.sameAsBefore(before, await h.read(["S3"]));

  // S4, S5: protections
  h.begin(phase, "S4 quantity-managed and S5 multi-variant are protected");
  before = await h.read(["S4", "S5"]);
  r = await h.run({ type: "stock", params: { stockStatus: "outofstock" }, selection: { mode: "IDS", ids: [h.id("S4"), h.id("S5")] } });
  h.check(r.rows.S4?.status === "skipped" && /Quantity-managed/.test(r.rows.S4.message), "S4 skipped: quantity-managed", r.rows.S4?.message);
  h.check(r.rows.S5?.status === "skipped" && /variants/.test(r.rows.S5.message), "S5 skipped: product with variants", r.rows.S5?.message);
  h.sameAsBefore(before, await h.read(["S4", "S5"]), "S4 and S5 unchanged (quantity 5 kept)");
  let refused = "";
  try {
    await h.putBack(r.op.id);
  } catch (e) {
    refused = (e as Error).message;
  }
  h.check(/changed nothing/.test(refused), "Put Back refused for a run that changed nothing", refused);

  // Manual change after a run: Put Back must skip, not overwrite
  h.begin(phase, "S1 changed by hand after a run: Put Back skips it");
  before = await h.read(["S1"]);
  r = await h.run({ type: "stock", params: { stockStatus: "outofstock" }, selection: { mode: "IDS", ids: [h.id("S1")] } });
  h.eq("S1 result", [r.rows.S1?.status], ["changed"]);
  const v = (await h.read(["S1"])).S1.variants[0];
  h.log("    simulated merchant edit: S1 set to continue selling (On backorder) through the Admin API");
  await h.gw.setInventoryPolicy(h.id("S1"), v.id, "CONTINUE");
  const edited = await h.read(["S1"]);
  h.eq("S1 after the manual edit", inv(edited.S1).stock, "onbackorder");
  back = await h.putBack(r.op.id);
  h.check(back.rows.S1?.status === "skipped" && /Expected: outofstock\. Current: onbackorder/.test(back.rows.S1.message), "Put Back skipped S1 and names expected vs current", back.rows.S1?.message);
  h.sameAsBefore(edited, await h.read(["S1"]), "S1 left exactly as edited (not overwritten)");
  h.log("    restoring S1 to its seed state by hand (untracked, stop selling)");
  await h.gw.setInventoryPolicy(h.id("S1"), v.id, "DENY");
  await h.gw.setInventoryTracked(v.inventoryItemId, false);
  h.sameAsBefore(before, await h.read(["S1"]), "S1 back to its seed state");
}

/* ----------------------------------------------------------------------------------- attributes */

type AttrRun = { key: string; params: Record<string, unknown>; expectRow: ["changed" | "skipped", RegExp]; expectAfter?: { attr: string; values: string[] | null } };

async function attrCase(h: Harness, label: string, runs: AttrRun[]) {
  h.begin("4 Attributes", label);
  for (const t of runs) {
    const before = await h.read([t.key]);
    const r = await h.run({ type: "attributes", params: t.params, selection: { mode: "IDS", ids: [h.id(t.key)] } });
    const row = r.rows[t.key];
    h.check(row?.status === t.expectRow[0] && t.expectRow[1].test(row.message), `${t.key} ${String(t.params.op)} → ${t.expectRow[0]}`, row?.message);
    const after = await h.read([t.key]);
    if (t.expectRow[0] === "skipped") {
      h.sameAsBefore(before, after, `${t.key} unchanged`);
      continue;
    }
    if (t.expectAfter) h.eq(`${t.key} ${t.expectAfter.attr} after`, attr(after[t.key], t.expectAfter.attr), t.expectAfter.values);
    const back = await h.putBack(r.op.id);
    h.eq(`${t.key} Put Back result`, back.rows[t.key]?.status, "changed");
    h.sameAsBefore(before, await h.read([t.key]));
  }
}

export async function attributeSuite(h: Harness) {
  const C = "shared.colour";
  await attrCase(h, "A1 add a value; replace the values", [
    { key: "A1", params: { op: "add_terms", attribute: C, terms: ["Blue"] }, expectRow: ["changed", /Colour: Red to Red, Blue/], expectAfter: { attr: C, values: ["Red", "Blue"] } },
    { key: "A1", params: { op: "set_terms", attribute: C, terms: ["Green"] }, expectRow: ["changed", /Colour: Red to Green/], expectAfter: { attr: C, values: ["Green"] } },
  ]);
  await attrCase(h, "A2 remove a value; remove the final values (attribute goes)", [
    { key: "A2", params: { op: "remove_terms", attribute: C, terms: ["Blue"] }, expectRow: ["changed", /Colour: Red, Blue to Red/], expectAfter: { attr: C, values: ["Red"] } },
    { key: "A2", params: { op: "remove_terms", attribute: C, terms: ["Red", "Blue"] }, expectRow: ["changed", /Colour: Red, Blue to not set/], expectAfter: { attr: C, values: null } },
  ]);
  await attrCase(h, "A3 remove a value it does not have; add to an empty state", [
    { key: "A3", params: { op: "remove_terms", attribute: C, terms: ["Red"] }, expectRow: ["skipped", /Already as requested/] },
    { key: "A3", params: { op: "add_terms", attribute: C, terms: ["Blue"] }, expectRow: ["changed", /Colour: not set to Blue/], expectAfter: { attr: C, values: ["Blue"] } },
  ]);
  await attrCase(h, "A4 shared/local name clash", [{ key: "A4", params: { op: "add_terms", attribute: C, terms: ["Red"] }, expectRow: ["skipped", /already has "colour" as a local attribute/] }]);
  await attrCase(h, "A5 local list attribute: set, then set a list", [
    { key: "A5", params: { op: "set_local_value", attribute: "cartovum_local.finish", value: "Matt" }, expectRow: ["changed", /finish: Gloss to Matt/], expectAfter: { attr: "cartovum_local.finish", values: ["Matt"] } },
    { key: "A5", params: { op: "set_local_value", attribute: "cartovum_local.finish", value: "Matt|Satin" }, expectRow: ["changed", /finish: Gloss to Matt, Satin/], expectAfter: { attr: "cartovum_local.finish", values: ["Matt", "Satin"] } },
  ]);
  await attrCase(h, "A6 single-value local attribute cannot hold a list", [{ key: "A6", params: { op: "set_local_value", attribute: "cartovum_local.finish", value: "Matt|Satin" }, expectRow: ["skipped", /single value/] }]);
  await attrCase(h, "A7 setting a local attribute the product does not have", [{ key: "A7", params: { op: "set_local_value", attribute: "cartovum_local.finish", value: "Matt" }, expectRow: ["skipped", /does not add local attributes/] }]);
  await attrCase(h, "A8 remove a shared attribute; remove a local attribute", [
    { key: "A8", params: { op: "remove_attribute", attribute: C }, expectRow: ["changed", /Colour: Green to not set/], expectAfter: { attr: C, values: null } },
    { key: "A8", params: { op: "remove_attribute", attribute: "cartovum_local.material" }, expectRow: ["changed", /material: Aluminium to not set/], expectAfter: { attr: "cartovum_local.material", values: null } },
  ]);
  await attrCase(h, "A9 product with variants is protected", [{ key: "A9", params: { op: "add_terms", attribute: C, terms: ["Blue"] }, expectRow: ["skipped", /variants/] }]);
  await attrCase(h, "A10 single-value shared attribute", [
    { key: "A10", params: { op: "add_terms", attribute: "shared.centre_bore", terms: ["66.1"] }, expectRow: ["skipped", /single value/] },
    { key: "A10", params: { op: "set_terms", attribute: "shared.centre_bore", terms: ["66.1"] }, expectRow: ["changed", /Centre Bore: 57\.1 to 66\.1/], expectAfter: { attr: "shared.centre_bore", values: ["66.1"] } },
  ]);

  // A value that is not one of the definition's choices is refused before any run starts.
  h.begin("4 Attributes", "values outside the definition's choices are refused");
  let refused = "";
  try {
    await h.run({ type: "attributes", params: { op: "add_terms", attribute: C, terms: ["Purple"] }, selection: { mode: "IDS", ids: [h.id("A1")] } });
  } catch (e) {
    refused = (e as Error).message;
  }
  h.check(/does not exist for this attribute/.test(refused), "Purple refused, no run created", refused);
}
