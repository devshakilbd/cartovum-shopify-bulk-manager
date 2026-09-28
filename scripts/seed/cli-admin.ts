import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdminClient } from "../../app/lib/gateway.server";
import { API_VERSION, STORE } from "./spec";

/**
 * Admin API access for the seed, through `shopify app execute`: it runs with the installed app's own
 * permissions (write_products, write_inventory) using the Shopify CLI login, so this script never reads,
 * stores or prints an access token. The store is fixed to the development store; there is no parameter
 * that could point it anywhere else.
 */

const ROOT = process.cwd();
const TMP = join(ROOT, ".seed-tmp");

export interface CliAdmin extends AdminClient {
  /** Number of Admin API calls made, for the report. */
  calls: number;
}

export function cliAdmin(log: (line: string) => void = () => undefined): CliAdmin {
  mkdirSync(TMP, { recursive: true });
  let n = 0;
  const client: CliAdmin = {
    calls: 0,
    async graphql(query, options) {
      const id = `${process.pid}-${++n}`;
      const q = join(TMP, `q-${id}.graphql`);
      const v = join(TMP, `v-${id}.json`);
      const o = join(TMP, `o-${id}.json`);
      writeFileSync(q, query);
      writeFileSync(v, JSON.stringify(options?.variables ?? {}));
      const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
      log(`  → ${name}`);
      client.calls++;
      const args = ["shopify", "app", "execute", "--config", "shopify.app.toml", "--store", STORE, "--version", API_VERSION, "--query-file", q, "--variable-file", v, "--output-file", o, "--no-color"];
      const run = spawnSync("npx", args, { cwd: ROOT, shell: process.platform === "win32", encoding: "utf8", timeout: 180_000 });
      try {
        if (run.status !== 0) {
          throw new Error(`shopify app execute failed (${name}, exit ${run.status}): ${(run.stderr || run.stdout || "").trim().slice(-800)}`);
        }
        const raw = readFileSync(o, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`shopify app execute returned something that is not JSON (${name}): ${raw.slice(0, 300)}`);
        }
        // The CLI may write the whole response or only its data; the gateway expects { data, errors }.
        const body = parsed && typeof parsed === "object" && ("data" in parsed || "errors" in parsed) ? parsed : { data: parsed };
        return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      } finally {
        for (const f of [q, v, o]) rmSync(f, { force: true });
      }
    },
  };
  return client;
}

/** A query or mutation whose result is needed directly (not through the app's gateway). Throws on any error. */
export async function execute<T = Record<string, unknown>>(admin: AdminClient, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("Shopify returned no data.");
  return body.data;
}
