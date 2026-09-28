/**
 * Functional tests against the development store, through the running app.
 *
 *   npm run test:functional -- <suite> [<suite> …] --confirm cartovum-bulk-dev
 *
 * Suites: stock, attributes, batch, conversion, filters, k1. The app (shopify app dev) must be running: its
 * worker executes the operations. Every change is put back and verified. Only cartovum-bulk-dev is used.
 */
import { canonical, fingerprint } from "../../app/lib/core/fingerprint";
import { DEFAULT_SETTINGS } from "../../app/lib/core/types";
import { Harness, SHOP } from "./harness";
import { batchSuite } from "./batch";
import { conversionSuite } from "./conversion";
import { filterSuite, k1Suite, readK1 } from "./filters-k1";
import { attributeSuite, stockSuite } from "./suites";

const SUITES: Record<string, (h: Harness) => Promise<void>> = { stock: stockSuite, attributes: attributeSuite, batch: batchSuite, conversion: conversionSuite, filters: filterSuite, k1: k1Suite };

const args = process.argv.slice(2).filter((a) => a !== "--");
const confirm = args[args.indexOf("--confirm") + 1];
const chosen = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--confirm");
const out = (line: string) => process.stdout.write(line + "\n");

if (confirm !== SHOP.replace(".myshopify.com", "")) {
  out(`These tests write to ${SHOP} (and put every change back). Rerun with --confirm ${SHOP.replace(".myshopify.com", "")}`);
  process.exit(1);
}
const unknown = chosen.filter((s) => !SUITES[s]);
if (!chosen.length || unknown.length) {
  out(`Choose suites from: ${Object.keys(SUITES).join(", ")}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`);
  process.exit(1);
}

const h = new Harness(out);
const originalSettings = await h.store.getSettings(SHOP);
let failed = 0;
try {
  await h.connect();
  // Keep every test run in Run History for review; restored below.
  await h.store.saveSettings(SHOP, { ...DEFAULT_SETTINGS, ...originalSettings, keepJobs: 200 });
  const controls = await h.read(["X1"]);
  const k1Before = await readK1(h);
  for (const s of chosen) await SUITES[s](h);
  h.begin("Controls", "X1 and K1 never changed by any suite");
  const now = await h.read(["X1"]);
  h.check(canonical(fingerprint(controls.X1)) === canonical(fingerprint(now.X1)), "X1 fingerprint identical before and after");
  if (k1Before) h.check(canonical(k1Before) === canonical(await readK1(h)), "K1 (including its standard category metafields) identical before and after");
} catch (e) {
  h.check(false, "suite aborted", (e as Error).message);
} finally {
  await h.store.saveSettings(SHOP, originalSettings);
  out(`App settings restored (runs kept: ${originalSettings.keepJobs}, conversion writes: ${originalSettings.convertWritesEnabled ? "on" : "off"}).`);
  failed = h.report(`test-reports/functional-${chosen.join("-")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  out(`Admin API calls by the harness: ${h.cli.calls}`);
  await h.db.$disconnect();
}
process.exit(failed ? 1 : 0);
