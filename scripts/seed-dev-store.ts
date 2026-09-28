/**
 * Development-store seed for the Cartovum Bulk Product Manager test matrix.
 *
 *   npm run seed:dev                          plan: check the matrix offline and print it. No Shopify calls.
 *   npm run seed:dev -- preflight             read-only checks against the development store.
 *   npm run seed:dev -- apply --confirm cartovum-bulk-dev
 *                                             create the definitions, collections and 41 products, then verify.
 *   npm run seed:dev -- verify                read-only: read every seeded product back through the app's own
 *                                             gateway, compare it with the matrix, and run every expected
 *                                             filter through the app's real search against the store.
 *
 * Only ever talks to cartovum-bulk-dev.myshopify.com (fixed in spec.ts; there is no store option), through
 * `shopify app execute`, so it runs with the installed app's own scopes and never handles a token.
 * It never runs the app's bulk operations and never deletes anything.
 *
 * Rerunning apply resets every seeded product to its seed state (productSet replaces variants, metafields
 * and collections), which also makes Put Back unavailable for runs made before the reset.
 */
import { searchPage, ANY_STATUS_QUERY } from "../app/lib/core/filters";
import { isMultiVariant, isQuantityManaged, productStockStatus, variantStockStatus } from "../app/lib/core/fingerprint";
import type { ProductState } from "../app/lib/core/types";
import { DEFAULT_SETTINGS } from "../app/lib/core/types";
import { ShopifyGateway } from "../app/lib/gateway.server";
import { cliAdmin, execute, type CliAdmin } from "./seed/cli-admin";
import { CREATE_COLLECTION, CREATE_DEFINITION, PREFLIGHT, productSetChunk } from "./seed/documents";
import { checkSpec, COLLECTIONS, type CollectionRef, DEFINITIONS, EXPECTED_FILTERS, filterInput, PRODUCTS, productSetInput, SEED_TAG, SHARED_NS, STORE } from "./seed/spec";

const CONFIRM = STORE.replace(".myshopify.com", "");
const CHUNK = 5;
const SEEDED_QUERY = `tag:${SEED_TAG} AND ${ANY_STATUS_QUERY}`;

type Preflight = {
  shop: { myshopifyDomain: string };
  locations: { nodes: { id: string; name: string; isActive: boolean }[] };
  all: { count: number; precision: string };
  seeded: { count: number; precision: string };
  existing: { nodes: { id: string; handle: string; tags: string[] }[] };
  metafieldDefinitions: { nodes: { key: string; name: string; type: { name: string }; validations: { name: string; value: string }[] }[] };
  collections: { nodes: { id: string; handle: string; title: string }[] };
};

const out = (line = "") => process.stdout.write(line + "\n");

function fail(message: string): never {
  out(`\n✖ ${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------------------------------ plan */

function plan() {
  const problems = checkSpec();
  out(`Matrix: ${PRODUCTS.length} products, ${DEFINITIONS.length} shared attribute definitions, ${Object.keys(COLLECTIONS).length} collections, ${EXPECTED_FILTERS.length} expected filter results.`);
  out(`Store: ${STORE} (fixed). K1 is not seeded: create it by hand (see TESTING.md).\n`);
  for (const d of DEFINITIONS) out(`  definition ${SHARED_NS}.${d.key} "${d.name}" ${d.type} choices: ${d.choices.join(", ")}`);
  for (const c of Object.values(COLLECTIONS)) out(`  collection ${c.handle} "${c.title}"`);
  out("");
  for (const p of PRODUCTS) {
    const inv = p.variants.map((v) => (v.inventory.tracked ? `${v.sku} tracked ${v.inventory.onHand} ${v.inventory.policy}` : `${v.sku} untracked`)).join("; ");
    const attrs = p.attributes.map((a) => `${a.ns}.${a.key}=${a.values.join("|")}${a.type.startsWith("list.") ? " (list)" : ""}`).join(", ") || "—";
    out(`  ${p.id.padEnd(4)} ${p.status.padEnd(8)} ${p.productType.padEnd(11)} [${p.tags.join(", ")}] {${p.collections.join(", ")}} ${inv} | ${attrs}${p.mutationSafe ? "" : "  ⚠ CONTROL: never change"}`);
  }
  out("");
  if (problems.length) fail(`The matrix is inconsistent:\n  - ${problems.join("\n  - ")}`);
  out("✔ Matrix consistent: unique IDs, handles and SKUs; values are definition choices; inventory gives the expected stock state; every expected filter result matches the app's own rules.");
  out("Nothing was sent to Shopify.");
}

/* ------------------------------------------------------------------------------------- preflight */

async function preflight(admin: CliAdmin) {
  const collections = Object.values(COLLECTIONS).map((c) => `handle:${c.handle}`).join(" OR ");
  const data = await execute<Preflight>(admin, PREFLIGHT, { all: ANY_STATUS_QUERY, seeded: SEEDED_QUERY, collections });
  const problems: string[] = [];

  if (data.shop.myshopifyDomain !== STORE) problems.push(`Connected to ${data.shop.myshopifyDomain}, not ${STORE}.`);
  const active = data.locations.nodes.filter((l) => l.isActive);
  if (active.length !== 1) problems.push(`Expected exactly 1 active location (the stock tests assume one); found ${active.length}.`);
  const others = data.all.count - data.seeded.count;
  if (data.all.precision !== "EXACT" || data.seeded.precision !== "EXACT") problems.push("Shopify could not give exact product counts.");
  if (others > 0) problems.push(`${others} product(s) without the ${SEED_TAG} tag exist. The seed only runs on a store holding nothing but seed products.`);

  for (const d of DEFINITIONS) {
    const existing = data.metafieldDefinitions.nodes.find((n) => n.key === d.key);
    if (!existing) continue;
    const choices = JSON.parse(existing.validations.find((v) => v.name === "choices")?.value ?? "[]") as string[];
    if (existing.type.name !== d.type || JSON.stringify(choices) !== JSON.stringify(d.choices)) {
      problems.push(`Definition ${SHARED_NS}.${d.key} already exists with a different type or choices; the seed will not change it.`);
    }
  }

  out(`Store: ${data.shop.myshopifyDomain}`);
  out(`Location: ${active.map((l) => `${l.name} (${l.id})`).join(", ") || "none"}`);
  out(`Products: ${data.all.count} in total, ${data.seeded.count} seeded`);
  out(`Definitions already present: ${DEFINITIONS.filter((d) => data.metafieldDefinitions.nodes.some((n) => n.key === d.key)).map((d) => d.key).join(", ") || "none"}`);
  out(`Collections already present: ${data.collections.nodes.map((c) => c.handle).join(", ") || "none"}`);
  out(`Admin API calls: ${admin.calls}`);
  if (problems.length) fail(`Preflight failed:\n  - ${problems.join("\n  - ")}`);
  out("✔ Preflight passed. Nothing was changed.");
  return { data, locationId: active[0].id };
}

/* ----------------------------------------------------------------------------------------- apply */

async function apply(admin: CliAdmin) {
  const problems = checkSpec();
  if (problems.length) fail(`The matrix is inconsistent; nothing was sent:\n  - ${problems.join("\n  - ")}`);
  const { data, locationId } = await preflight(admin);

  out("\nDefinitions");
  for (const d of DEFINITIONS) {
    if (data.metafieldDefinitions.nodes.some((n) => n.key === d.key)) {
      out(`  ${SHARED_NS}.${d.key}: already present, unchanged`);
      continue;
    }
    const r = await execute<{ metafieldDefinitionCreate: { createdDefinition: { id: string } | null; userErrors: { message: string }[] } }>(admin, CREATE_DEFINITION, {
      definition: { name: d.name, namespace: SHARED_NS, key: d.key, ownerType: "PRODUCT", type: d.type, validations: [{ name: "choices", value: JSON.stringify(d.choices) }] },
    });
    if (r.metafieldDefinitionCreate.userErrors.length) fail(`Definition ${d.key}: ${r.metafieldDefinitionCreate.userErrors.map((e) => e.message).join("; ")}`);
    out(`  ${SHARED_NS}.${d.key}: created`);
  }

  out("\nCollections");
  const collectionIds = {} as Record<CollectionRef, string>;
  for (const [ref, c] of Object.entries(COLLECTIONS) as [CollectionRef, (typeof COLLECTIONS)[CollectionRef]][]) {
    const found = data.collections.nodes.find((n) => n.handle === c.handle);
    if (found) {
      collectionIds[ref] = found.id;
      out(`  ${c.handle}: already present`);
      continue;
    }
    const r = await execute<{ collectionCreate: { collection: { id: string } | null; userErrors: { message: string }[] } }>(admin, CREATE_COLLECTION, { collection: { title: c.title, handle: c.handle } });
    if (!r.collectionCreate.collection) fail(`Collection ${c.handle}: ${r.collectionCreate.userErrors.map((e) => e.message).join("; ")}`);
    collectionIds[ref] = r.collectionCreate.collection.id;
    out(`  ${c.handle}: created`);
  }

  out("\nProducts");
  const existing = new Map(data.existing.nodes.map((n) => [n.handle, n.id]));
  for (let i = 0; i < PRODUCTS.length; i += CHUNK) {
    const chunk = PRODUCTS.slice(i, i + CHUNK);
    const variables: Record<string, unknown> = {};
    chunk.forEach((p, j) => {
      const id = existing.get(p.handle);
      variables[`id${j}`] = id ? { id } : null;
      variables[`in${j}`] = productSetInput(p, locationId, collectionIds);
    });
    const r = await execute<Record<string, { product: { id: string; handle: string } | null; userErrors: { field: string[]; message: string }[] }>>(admin, productSetChunk(chunk.length), variables);
    chunk.forEach((p, j) => {
      const res = r[`p${j}`];
      if (!res?.product || res.userErrors.length) fail(`${p.id}: ${res?.userErrors.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ") || "no product returned"}. Products before it were written; rerun apply after fixing (it resets seeded products).`);
      out(`  ${p.id.padEnd(4)} ${existing.has(p.handle) ? "reset" : "created"} ${res.product.id}`);
    });
  }
  out(`\nAdmin API calls so far: ${admin.calls}`);
  await verify(admin);
}

/* ---------------------------------------------------------------------------------------- verify */

async function verify(admin: CliAdmin) {
  out("\nVerify (read-only, through the app's own gateway and search)");
  const gw = new ShopifyGateway(admin, DEFAULT_SETTINGS, STORE);
  const shop = await execute<{ shop: { myshopifyDomain: string } }>(admin, `#graphql
    query CartovumSeedShop { shop { myshopifyDomain } }`);
  if (shop.shop.myshopifyDomain !== STORE) fail(`Connected to ${shop.shop.myshopifyDomain}, not ${STORE}.`);

  const read: ProductState[] = [];
  let after: string | null = null;
  do {
    const page = await gw.searchProducts(SEEDED_QUERY, 25, after);
    read.push(...page.products);
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  const byHandle = new Map(read.map((p) => [p.handle, p]));

  const collections = await gw.getCollections();
  const collectionIds = {} as Record<CollectionRef, string>;
  for (const [ref, c] of Object.entries(COLLECTIONS) as [CollectionRef, (typeof COLLECTIONS)[CollectionRef]][]) {
    const found = collections.find((x) => x.title === c.title);
    if (!found) fail(`Collection "${c.title}" not found.`);
    collectionIds[ref] = found.id;
  }

  const problems: string[] = [];
  for (const p of PRODUCTS) {
    const s = byHandle.get(p.handle);
    if (!s) {
      problems.push(`${p.id}: not found`);
      continue;
    }
    const diff = (what: string, got: unknown, want: unknown) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${p.id}: ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    };
    diff("status", s.status, p.status);
    diff("product type", s.productType, p.productType);
    diff("tags", [...s.tags].sort(), [...p.tags].sort());
    diff("collections", [...s.collectionIds].sort(), p.collections.map((c) => collectionIds[c]).sort());
    diff("stock status", productStockStatus(s), p.expect.stock);
    diff("has variants", isMultiVariant(s), p.expect.multiVariant);
    diff("SKUs", s.variants.map((v) => v.sku).sort(), p.variants.map((v) => v.sku).sort());
    for (const v of p.variants) {
      const sv = s.variants.find((x) => x.sku === v.sku);
      if (!sv) continue;
      diff(`${v.sku} tracked`, sv.tracked, v.inventory.tracked);
      if (v.inventory.tracked) {
        diff(`${v.sku} policy`, sv.inventoryPolicy, v.inventory.policy);
        diff(`${v.sku} on hand`, sv.levels.reduce((n, l) => n + l.onHand, 0), v.inventory.onHand);
        diff(`${v.sku} quantity-managed`, isQuantityManaged(sv), v.inventory.onHand > 0);
      }
      diff(`${v.sku} stock`, variantStockStatus(sv), v.inventory.tracked ? (v.inventory.onHand > 0 ? "instock" : v.inventory.policy === "CONTINUE" ? "onbackorder" : "outofstock") : "instock");
    }
    const attrs = s.attributes.map((a) => ({ key: a.key, type: a.type, values: a.values })).sort((a, b) => a.key.localeCompare(b.key));
    const want = p.attributes.map((a) => ({ key: `${a.ns}.${a.key}`, type: a.type, values: a.values })).sort((a, b) => a.key.localeCompare(b.key));
    diff("attributes", attrs, want);
  }
  out(`  Read back ${read.length} seeded product(s); ${PRODUCTS.length} expected.`);

  // Every expected filter through the app's real search: Shopify's narrowing plus the app's own check.
  const idByProductId = new Map(read.map((s) => [s.id, PRODUCTS.find((p) => p.handle === s.handle)?.id]));
  for (const row of EXPECTED_FILTERS) {
    const f = filterInput(row, collectionIds);
    const got: string[] = [];
    const ignored: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchPage(gw, f, cursor);
      for (const s of page.items) {
        const id = idByProductId.get(s.id);
        if (id) got.push(id);
        else ignored.push(s.title);
      }
      cursor = page.next;
    } while (cursor);
    const ok = JSON.stringify([...got].sort()) === JSON.stringify([...row.ids].sort());
    out(`  ${ok ? "✔" : "✖"} ${row.name}: ${got.length} found${ignored.length ? ` (+${ignored.length} not seeded, ignored: ${ignored.join(", ")})` : ""}`);
    if (!ok) problems.push(`Filter "${row.name}": got [${[...got].sort().join(", ")}], expected [${[...row.ids].sort().join(", ")}]`);
  }

  out(`  Admin API calls: ${admin.calls}`);
  if (problems.length) fail(`Verification found ${problems.length} difference(s):\n  - ${problems.join("\n  - ")}`);
  out("✔ Every seeded product and every expected filter result matches the matrix. Nothing was changed.");
}

/* ------------------------------------------------------------------------------------------ main */

const [mode = "plan", ...rest] = process.argv.slice(2).filter((a) => a !== "--");
const confirm = rest[rest.indexOf("--confirm") + 1];

switch (mode) {
  case "plan":
    plan();
    break;
  case "preflight":
    await preflight(cliAdmin(out));
    break;
  case "verify":
    await verify(cliAdmin(out));
    break;
  case "apply":
    if (!rest.includes("--confirm") || confirm !== CONFIRM) fail(`apply writes to ${STORE}. Rerun with: npm run seed:dev -- apply --confirm ${CONFIRM}`);
    await apply(cliAdmin(out));
    break;
  default:
    fail(`Unknown mode "${mode}". Use plan, preflight, apply or verify.`);
}
