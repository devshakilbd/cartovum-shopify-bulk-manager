import { EMPTY_DECISIONS } from "../../app/lib/core/convert";
import { createDryRun } from "../../app/lib/core/engine";
import type { DryRunItem } from "../../app/lib/core/store";
import { DEFAULT_SETTINGS, type ProductState } from "../../app/lib/core/types";
import { execute } from "../seed/cli-admin";
import { LABEL, SHOP, type Harness } from "./harness";

/** Phase 7: attribute conversion on C1–C10, with dry run, mappings, holds, planned values, staging, verification and Put Back. */

const C = Array.from({ length: 10 }, (_, i) => `C${i + 1}`);
const ALL_CONVERT = [...C, "A4"]; // A4's local colour pairs with the shared Colour too
const val = (p: ProductState, key: string) => p.attributes.find((a) => a.key === key)?.values ?? null;

async function dryRun(h: Harness) {
  const op = await createDryRun(h.store, SHOP, LABEL);
  const done = await h.wait(op.id);
  h.log(`    dry run ${op.id}: ${done.message}`);
  const { items } = await h.store.dryRunItems(SHOP);
  const byKey: Record<string, DryRunItem> = {};
  const keyOf = new Map([...h.ids].map(([k, v]) => [v, k]));
  for (const i of items) byKey[keyOf.get(i.productId) ?? i.productId] = i;
  return byKey;
}

const DEFINITION = `#graphql
  query CartovumFunctionalRimSize {
    metafieldDefinitions(ownerType: PRODUCT, namespace: "shared", key: "rim_size", first: 1) {
      nodes { id validations { name value } }
    }
  }`;
const UPDATE_DEFINITION = `#graphql
  mutation CartovumFunctionalRimSizeChoices($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id validations { name value } }
      userErrors { field message code }
    }
  }`;

async function rimChoices(h: Harness): Promise<string[]> {
  const d = await execute<{ metafieldDefinitions: { nodes: { validations: { name: string; value: string }[] }[] } }>(h.cli, DEFINITION);
  return JSON.parse(d.metafieldDefinitions.nodes[0].validations.find((v) => v.name === "choices")!.value);
}
async function setRimChoices(h: Harness, choices: string[]) {
  const r = await execute<{ metafieldDefinitionUpdate: { userErrors: { message: string }[] } }>(h.cli, UPDATE_DEFINITION, {
    definition: { namespace: "shared", key: "rim_size", ownerType: "PRODUCT", validations: [{ name: "choices", value: JSON.stringify(choices) }] },
  });
  if (r.metafieldDefinitionUpdate.userErrors.length) throw new Error(r.metafieldDefinitionUpdate.userErrors.map((e) => e.message).join("; "));
}

export async function conversionSuite(h: Harness) {
  const phase = "7 Conversion";
  const originalSettings = await h.store.getSettings(SHOP);
  const originalDecisions = await h.store.getDecisions(SHOP);
  const seedChoices = await rimChoices(h);
  const original = await h.read(ALL_CONVERT);
  const settings = (over: Partial<typeof DEFAULT_SETTINGS>) => h.store.saveSettings(SHOP, { ...originalSettings, keepJobs: 200, ...over });

  try {
    // Dry run with conversion writes off: reads only
    h.begin(phase, "dry run with conversion switched off (reads only)");
    await settings({ convertWritesEnabled: false });
    await h.store.saveDecisions(SHOP, EMPTY_DECISIONS);
    let dry = await dryRun(h);
    const states = Object.fromEntries(ALL_CONVERT.map((k) => [k, dry[k]?.state ?? "absent"]));
    h.eq("dry run states (A4 pairs with Colour too)", states, { C1: "ready", C2: "ready", C3: "blocked", C4: "blocked", C5: "blocked", C6: "blocked", C7: "blocked", C8: "skipped", C9: "ready", C10: "ready", A4: "ready" });
    h.eq("C1 planned value", [dry.C1?.rows[0]?.current, dry.C1?.rows[0]?.new, dry.C1?.rows[0]?.mapping], ["18", '18"', "exact"]);
    h.eq("C2 removes only the typed copy", dry.C2?.rows[0]?.action, "drop-duplicate");
    h.check(/different value/.test(dry.C3?.note ?? ""), "C3 blocked: shared value differs", dry.C3?.note);
    h.check(/No shared value matches/.test(dry.C4?.note ?? ""), "C4 blocked before a mapping is approved", dry.C4?.note);
    h.check(/Matches more than one shared value: 66\.1, 66\.1mm/.test(dry.C6?.note ?? ""), "C6 blocked: ambiguous", dry.C6?.note);
    h.check(/variants/.test(dry.C8?.note ?? ""), "C8 skipped: product with variants", dry.C8?.note);
    h.eq("C9 plans both values", dry.C9?.rows[0]?.new, '17" | 18"');
    h.sameAsBefore(original, await h.read(ALL_CONVERT), "dry run wrote nothing (all 11 products unchanged)");
    let refused = "";
    try {
      await h.run({ type: "convert", params: {}, selection: { mode: "IDS", ids: [h.id("C1")] } });
    } catch (e) {
      refused = (e as Error).message;
    }
    h.check(/dry run only/.test(refused), "converting is refused while conversion is switched off", refused);

    // Decisions: approved mapping, hold, planned value
    h.begin(phase, "approved mapping (C4), hold (C5), planned value (C7)");
    await settings({ convertWritesEnabled: true });
    await h.store.saveDecisions(SHOP, {
      ...EMPTY_DECISIONS,
      overrides: { "shared.wheel_year": { "2024-ONWARDS": "2024-Present" } },
      holds: { "shared.colour": { Maroon: "Awaiting the owner's decision" } },
      planned: { "shared.rim_size": ['21"'] },
    });
    dry = await dryRun(h);
    h.eq("C4 ready via approved mapping", [dry.C4?.state, dry.C4?.rows[0]?.new, dry.C4?.rows[0]?.mapping], ["ready", "2024-Present", "approved mapping"]);
    h.eq("C5 held: awaiting approval", [dry.C5?.state, dry.C5?.rows[0]?.mapping], ["needs-approval", "awaiting approval"]);
    h.eq("C7 planned new value, not yet created", [dry.C7?.state, dry.C7?.rows[0]?.mapping, dry.C7?.rows[0]?.needsNewTerm], ["ready", "new value (to be created on approval)", true]);

    // Staged: Draft only
    h.begin(phase, "staged conversion: Draft products only");
    await settings({ convertWritesEnabled: true, convertAllowedStatuses: ["DRAFT"] });
    let r = await h.run({ type: "convert", params: {}, selection: { mode: "IDS", ids: [h.id("C1"), h.id("C10")] } });
    h.check(r.rows.C1?.status === "skipped" && /Only DRAFT products/.test(r.rows.C1.message), "C1 (Active) skipped at this stage", r.rows.C1?.message);
    h.check(r.rows.C10?.status === "changed", "C10 (Draft) converted", r.rows.C10?.message);
    let after = await h.read(["C1", "C10"]);
    h.eq("C10 after: shared Rim Size 19\", typed copy gone", [val(after.C10, "shared.rim_size"), val(after.C10, "cartovum_local.rim_size")], [['19"'], null]);
    h.sameAsBefore({ C1: original.C1 }, { C1: after.C1 }, "C1 (Active) not modified");
    let back = await h.putBack(r.op.id);
    h.eq("Put Back: C10 restored", back.rows.C10?.status, "changed");
    h.sameAsBefore(original, await h.read(ALL_CONVERT), "all restored exactly");

    // Full conversion of the ready products
    h.begin(phase, "convert every ready product; verify; Put Back");
    await settings({ convertWritesEnabled: true, convertAllowedStatuses: [] });
    dry = await dryRun(h);
    r = await h.run({ type: "convert", params: {}, selection: { mode: "IDS", ids: C.map((k) => h.id(k)) } });
    h.eq("only products ready in the dry run are targeted", Object.keys(r.rows).sort(), ["C1", "C10", "C2", "C4", "C7", "C9"]);
    h.check(r.rows.C7?.status === "skipped" && /approved new value/.test(r.rows.C7.message), "C7 skipped: its new value does not exist yet", r.rows.C7?.message);
    after = await h.read(ALL_CONVERT);
    h.eq("C1", [val(after.C1, "shared.rim_size"), val(after.C1, "cartovum_local.rim_size")], [['18"'], null]);
    h.eq("C2 (typed copy removed, shared unchanged)", [val(after.C2, "shared.rim_size"), val(after.C2, "cartovum_local.rim_size")], [['18"'], null]);
    h.eq("C4", [val(after.C4, "shared.wheel_year"), val(after.C4, "cartovum_local.wheel_year")], [["2024-Present"], null]);
    h.eq("C9", [val(after.C9, "shared.rim_size"), val(after.C9, "cartovum_local.rim_size")], [['17"', '18"'], null]);
    h.eq("C10", [val(after.C10, "shared.rim_size"), val(after.C10, "cartovum_local.rim_size")], [['19"'], null]);
    h.sameAsBefore(
      Object.fromEntries(["C3", "C5", "C6", "C7", "C8", "A4"].map((k) => [k, original[k]])),
      Object.fromEntries(["C3", "C5", "C6", "C7", "C8", "A4"].map((k) => [k, after[k]])),
      "blocked, held, skipped and unselected products unchanged (C3 C5 C6 C7 C8 A4)",
    );
    back = await h.putBack(r.op.id);
    h.eq("Put Back: 5 changed", [back.op.changed, back.op.skipped, back.op.failed], [5, 0, 0]);
    h.sameAsBefore(original, await h.read(ALL_CONVERT), "all restored exactly");

    // Changed since the dry run
    h.begin(phase, "a product edited after the dry run is skipped");
    dry = await dryRun(h);
    h.log("    simulated merchant edit: C9 typed Rim Size set to 17|19 through the Admin API");
    await h.gw.writeAttributes(h.id("C9"), [{ key: "cartovum_local.rim_size", kind: "local", type: "list.single_line_text_field", values: ["17", "19"] }], []);
    r = await h.run({ type: "convert", params: {}, selection: { mode: "IDS", ids: [h.id("C9")] } });
    h.check(r.rows.C9?.status === "skipped" && /changed since the dry run/.test(r.rows.C9.message), "C9 skipped: changed since the dry run", r.rows.C9?.message);
    h.eq("C9 left as edited", val((await h.read(["C9"])).C9, "cartovum_local.rim_size"), ["17", "19"]);
    h.log("    restoring C9 by hand");
    await h.gw.writeAttributes(h.id("C9"), [{ key: "cartovum_local.rim_size", kind: "local", type: "list.single_line_text_field", values: ["17", "18"] }], []);
    h.sameAsBefore({ C9: original.C9 }, await h.read(["C9"]), "C9 back to its seed state");

    // Planned value created by the merchant, then converted
    h.begin(phase, "planned value 21\" created in Shopify, then C7 converts");
    h.log('    merchant step: adding 21" to the Rim Size choices through the Admin API');
    await setRimChoices(h, [...seedChoices, '21"']);
    dry = await dryRun(h);
    h.eq("C7 ready, value now exists", [dry.C7?.state, dry.C7?.rows[0]?.mapping], ["ready", "newly created value"]);
    r = await h.run({ type: "convert", params: {}, selection: { mode: "IDS", ids: [h.id("C7")] } });
    h.eq("C7 converted", [r.rows.C7?.status, val((await h.read(["C7"])).C7, "shared.rim_size")], ["changed", ['21"']]);
    back = await h.putBack(r.op.id);
    h.eq("Put Back: C7 restored", back.rows.C7?.status, "changed");
    h.sameAsBefore({ C7: original.C7 }, await h.read(["C7"]), "C7 restored exactly");
    await setRimChoices(h, seedChoices);
    h.eq("Rim Size choices back to the seed list", await rimChoices(h), seedChoices);
  } finally {
    await h.store.saveSettings(SHOP, { ...originalSettings, keepJobs: 200 });
    await h.store.saveDecisions(SHOP, originalDecisions);
    h.log("    conversion settings and decisions restored");
  }
}
