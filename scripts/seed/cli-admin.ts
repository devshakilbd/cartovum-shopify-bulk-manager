import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayError } from "../../app/lib/core/gateway";
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
      // The CLI is given paths relative to the project folder: with an absolute Windows path it reported
      // success but wrote no output file.
      const rel = (name: string) => `.seed-tmp/${name}`;
      const [qRel, vRel, oRel] = [rel(`q-${id}.graphql`), rel(`v-${id}.json`), rel(`o-${id}.json`)];
      const [q, v, o] = [qRel, vRel, oRel].map((r) => join(ROOT, r));
      writeFileSync(q, query);
      writeFileSync(v, JSON.stringify(options?.variables ?? {}));
      const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
      log(`  → ${name}`);
      client.calls++;
      const args = ["shopify", "app", "execute", "--config", "shopify.app.toml", "--store", STORE, "--version", API_VERSION, "--query-file", qRel, "--variable-file", vRel, "--output-file", oRel, "--no-color"];
      const isMutation = /^\s*mutation\b/m.test(query.replace(/^\s*#graphql/, ""));
      // npx is a .cmd file on Windows, which Node only starts through a shell. Every argument is fixed text
      // or a generated file name without spaces or shell characters.
      const once = () => spawnSync("npx", args, { cwd: ROOT, shell: process.platform === "win32", encoding: "utf8", timeout: 120_000 });
      let run = once();
      // Seen on 2026-09-28: the CLI printed "Operation succeeded", wrote its result, and then never exited.
      // A complete result file is used whatever the exit. A read that hung with no result is tried once more;
      // a write never is: its outcome is uncertain and must be decided by reading back.
      if (run.status === null && !existsSync(o) && !isMutation) {
        log(`    (the CLI did not finish; retrying the read ${name} once)`);
        run = once();
      }
      const cliOutput = () => `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim().slice(-1200);
      try {
        const hung = run.status === null;
        if (!hung && run.status !== 0) throw new Error(`shopify app execute failed (${name}, exit ${run.status}):\n${cliOutput()}`);
        if (!existsSync(o)) {
          if (hung && isMutation) throw new GatewayError(`shopify app execute did not finish ${name}; whether the write happened is unknown. Run verify.`, true);
          throw new Error(`shopify app execute wrote no result for ${name}${hung ? " (it did not finish)" : ""}. It said:\n${cliOutput()}`);
        }
        if (hung) log(`    (the CLI did not exit after writing the result of ${name}; the result is complete and was used)`);
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
