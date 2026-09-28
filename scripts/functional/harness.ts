/**
 * Functional test harness for the development store (cartovum-bulk-dev only).
 *
 * Operations are created in the development database exactly as the app's API creates them, and the
 * running app's own background worker executes them against Shopify with the app's offline session.
 * The harness then reads every product back independently (through `shopify app execute`), checks the
 * expected after-state and the app's per-product results, runs Put Back, and requires the restored product's
 * full fingerprint to equal the fingerprint taken before the test.
 *
 * It never touches a product without the cbm-seed tag except to read it (K1), never changes X1, never
 * deletes anything, and restores every value it changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createOperation, createRevert, type CreateInput } from "../../app/lib/core/engine";
import { canonical, fingerprint, unexpectedChanges } from "../../app/lib/core/fingerprint";
import type { Operation, Target } from "../../app/lib/core/store";
import { DEFAULT_SETTINGS, type ProductState, type ResultRow } from "../../app/lib/core/types";
import { ShopifyGateway } from "../../app/lib/gateway.server";
import { PrismaStore } from "../../app/lib/store.server";
import { cliAdmin, execute, type CliAdmin } from "../seed/cli-admin";
import { SEED_TAG, STORE } from "../seed/spec";

export const SHOP = STORE;
export const LABEL = "Functional test harness";

export interface Check {
  phase: string;
  test: string;
  check: string;
  result: "PASS" | "FAIL" | "BLOCKED";
  detail: string;
}

/** A store whose new operations are leased for two hours, so the running worker never picks them up and the harness can step them itself. */
export class LeasedStore extends PrismaStore {
  override async createOperation(op: Omit<Operation, "id" | "createdAt">) {
    return super.createOperation({ ...op, leaseUntil: new Date(Date.now() + 2 * 3600_000) });
  }
}

export class Harness {
  readonly db = new PrismaClient();
  readonly store = new PrismaStore(this.db);
  readonly leased = new LeasedStore(this.db);
  readonly cli: CliAdmin;
  readonly gw: ShopifyGateway;
  readonly checks: Check[] = [];
  ids = new Map<string, string>(); // seed ID (S1, B03, …) → product GID
  k1: string | null = null;
  phase = "";
  test = "";

  constructor(private out: (line: string) => void) {
    this.cli = cliAdmin((l) => out(l));
    this.gw = new ShopifyGateway(this.cli, DEFAULT_SETTINGS, SHOP);
  }

  log(line: string) {
    this.out(line);
  }

  check(ok: boolean, check: string, detail = "") {
    this.checks.push({ phase: this.phase, test: this.test, check, result: ok ? "PASS" : "FAIL", detail });
    this.out(`    ${ok ? "✔" : "✖"} ${check}${detail ? ` — ${detail}` : ""}`);
    return ok;
  }

  blocked(check: string, detail: string) {
    this.checks.push({ phase: this.phase, test: this.test, check, result: "BLOCKED", detail });
    this.out(`    ■ BLOCKED ${check} — ${detail}`);
  }

  eq(label: string, got: unknown, want: unknown) {
    return this.check(canonical(got) === canonical(want), label, canonical(got) === canonical(want) ? "" : `got ${canonical(got)}, expected ${canonical(want)}`);
  }

  begin(phase: string, test: string) {
    this.phase = phase;
    this.test = test;
    this.out(`\n[${phase}] ${test}`);
  }

  /** Confirms the store and maps the seeded products (and K1, if present) to their IDs. */
  async connect() {
    const data = await execute<{ shop: { myshopifyDomain: string }; seeded: { nodes: { id: string; handle: string }[] }; k1: { nodes: { id: string }[] } }>(
      this.cli,
      `#graphql
      query CartovumFunctionalIds($seeded: String!, $k1: String!) {
        shop { myshopifyDomain }
        seeded: products(first: 100, query: $seeded) { nodes { id handle } }
        k1: products(first: 2, query: $k1) { nodes { id } }
      }`,
      { seeded: `tag:${SEED_TAG} AND (status:active OR status:draft OR status:archived OR status:unlisted)`, k1: `sku:CBM-K1 AND (status:active OR status:draft OR status:archived OR status:unlisted)` },
    );
    if (data.shop.myshopifyDomain !== SHOP) throw new Error(`Connected to ${data.shop.myshopifyDomain}, not ${SHOP}.`);
    for (const n of data.seeded.nodes) this.ids.set(n.handle.replace("cbm-test-", "").toUpperCase(), n.id);
    this.k1 = data.k1.nodes[0]?.id ?? null;
    this.out(`Connected to ${SHOP}: ${this.ids.size} seeded products${this.k1 ? ", K1 found" : ", K1 not found"}.`);
    if (this.ids.size !== 41) throw new Error(`Expected 41 seeded products, found ${this.ids.size}.`);
  }

  id(key: string) {
    const id = this.ids.get(key);
    if (!id) throw new Error(`Unknown seed product ${key}`);
    return id;
  }

  /** Fresh reads of products by seed ID, through the app's own mapping. */
  async read(keys: string[]): Promise<Record<string, ProductState>> {
    const products = await this.gw.getProducts(keys.map((k) => this.id(k)));
    const byId = new Map(products.map((p) => [p.id, p]));
    const out: Record<string, ProductState> = {};
    for (const k of keys) {
      const p = byId.get(this.id(k));
      if (!p) throw new Error(`${k} could not be read`);
      out[k] = p;
    }
    return out;
  }

  /** Waits for the running app's worker to finish an operation. */
  async wait(id: string, timeoutMs = 20 * 60_000, onProgress?: (op: Operation) => void): Promise<Operation> {
    const start = Date.now();
    for (;;) {
      const op = await this.store.getOperation(SHOP, id);
      if (!op) throw new Error(`Operation ${id} disappeared`);
      onProgress?.(op);
      if (["completed", "stopped", "failed"].includes(op.status)) return op;
      if (Date.now() - start > timeoutMs) throw new Error(`Operation ${id} did not finish in time (status ${op.status})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async rows(id: string): Promise<Record<string, ResultRow>> {
    const targets: Target[] = await this.store.results(SHOP, id);
    const keyOf = new Map([...this.ids].map(([k, v]) => [v, k]));
    const out: Record<string, ResultRow> = {};
    for (const t of targets) if (t.result) out[keyOf.get(t.productId) ?? t.productId] = t.result;
    return out;
  }

  /** Creates an operation the way the app's API does and lets the app's worker run it. */
  async run(input: Omit<CreateInput, "userLabel">, onProgress?: (op: Operation) => void) {
    const op = await createOperation(this.store, this.gw, SHOP, { ...input, userLabel: LABEL });
    this.log(`    run ${op.id} created (${input.type}); waiting for the app's worker…`);
    const done = await this.wait(op.id, undefined, onProgress);
    this.log(`    run finished: ${done.status}, ${done.changed} changed, ${done.skipped} skipped, ${done.failed} failed${done.message ? ` — ${done.message}` : ""}`);
    return { op: done, rows: await this.rows(op.id) };
  }

  async putBack(sourceId: string) {
    const op = await createRevert(this.store, SHOP, sourceId, LABEL);
    this.log(`    Put Back ${op.id} created; waiting for the app's worker…`);
    const done = await this.wait(op.id);
    this.log(`    Put Back finished: ${done.status}, ${done.changed} changed, ${done.skipped} skipped, ${done.failed} failed`);
    return { op: done, rows: await this.rows(op.id) };
  }

  /** The restored state must equal the state before the test in every fingerprinted field. */
  sameAsBefore(before: Record<string, ProductState>, now: Record<string, ProductState>, label = "restored exactly (full fingerprint equal to before)") {
    const diffs: string[] = [];
    for (const k of Object.keys(before)) {
      const changed = unexpectedChanges(fingerprint(before[k]), fingerprint(now[k]), []);
      if (changed.length) diffs.push(`${k}: ${changed.join(", ")}`);
    }
    return this.check(diffs.length === 0, label, diffs.join("; "));
  }

  report(file: string) {
    mkdirSync("test-reports", { recursive: true });
    writeFileSync(file, JSON.stringify({ store: SHOP, at: new Date().toISOString(), checks: this.checks }, null, 2));
    const count = (r: Check["result"]) => this.checks.filter((c) => c.result === r).length;
    this.out(`\n${this.checks.length} checks: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED. Report: ${file}`);
    return count("FAIL");
  }
}
