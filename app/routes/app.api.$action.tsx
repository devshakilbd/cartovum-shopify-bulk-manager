import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { OpError, parseOp } from "../lib/core/attributes";
import { EMPTY_DECISIONS, type Decisions } from "../lib/core/convert";
import { createDryRun, createOperation, createRevert, EngineError, requestStop } from "../lib/core/engine";
import { isMultiVariant, primarySku, productStockStatus } from "../lib/core/fingerprint";
import { isGid, matches, parseFilters, queryIsExact, searchPage, shopifyQuery } from "../lib/core/filters";
import { previewAttribute, previewStock } from "../lib/core/preview";
import { BATCH_SIZE, DEFAULT_SETTINGS, MAX_CONDITIONS, PRODUCT_STATUSES, type ProductState, type ShopSettings, type StockStatus } from "../lib/core/types";
import { log } from "../lib/log.server";
import { gatewayFor, localValues, store } from "../lib/services.server";
import { authenticate } from "../shopify.server";

/**
 * The JSON endpoints behind the screens (v1.3.9 SWBM_Ajax). Every request is authenticated with the
 * embedded app's session token, which names the shop; nothing identifying the shop is taken from the
 * request body. Every input is parsed into a closed shape before use.
 */

type Body = Record<string, unknown>;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

/**
 * The staff member's own permissions, from their online token: the app's scopes narrowed to what that
 * staff member may do. A staff member without product (or inventory) write access cannot start writes
 * through the app, whatever the screen shows.
 */
function requireStaffScopes(session: { onlineAccessInfo?: { associated_user_scope?: string } }, needed: string[]) {
  const granted = (session.onlineAccessInfo?.associated_user_scope ?? "").split(",").map((s) => s.trim());
  const missing = needed.filter((s) => !granted.includes(s));
  if (missing.length) throw new EngineError("Your staff account does not have permission to change products" + (missing.includes("write_inventory") ? " or inventory" : "") + ". Ask the store owner for access.");
}

/** At most this many run-starting requests per shop per minute. */
const starts = new Map<string, number[]>();
function limited(shop: string) {
  const now = Date.now();
  const recent = (starts.get(shop) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  starts.set(shop, recent);
  return recent.length > 30;
}

function tableRow(p: ProductState) {
  return {
    id: p.id,
    name: p.title,
    sku: primarySku(p),
    status: p.status,
    productType: p.productType,
    tags: p.tags,
    stockStatus: productStockStatus(p),
    tracked: p.variants.some((v) => v.tracked),
    inventory: p.variants.reduce((sum, v) => sum + v.levels.reduce((s, l) => s + l.available, 0), 0),
    variants: p.variants.length,
    multiVariant: isMultiVariant(p),
    imageUrl: p.imageUrl ?? null,
    collectionIds: p.collectionIds,
    options: p.options.filter((o) => !(p.hasOnlyDefaultVariant && o.name === "Title")),
    attributes: p.attributes,
  };
}

function parseSettings(raw: Body): ShopSettings {
  const list = (v: unknown) => (typeof v === "string" ? v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : []);
  const namespaces = list(raw.localNamespaces).filter((n) => /^[A-Za-z0-9_-]{2,255}$/.test(n) && !n.startsWith("app--"));
  const int = (v: unknown, min: number, max: number, d: number) => (Number.isInteger(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d);
  return {
    localNamespaces: namespaces.length ? namespaces : DEFAULT_SETTINGS.localNamespaces,
    protectMultiVariantProducts: raw.protectMultiVariantProducts !== false,
    keepJobs: int(raw.keepJobs, 5, 500, DEFAULT_SETTINGS.keepJobs),
    selectAllCap: int(raw.selectAllCap, 100, 100000, DEFAULT_SETTINGS.selectAllCap),
    convertWritesEnabled: raw.convertWritesEnabled === true,
    convertAllowedStatuses: (Array.isArray(raw.convertAllowedStatuses) ? raw.convertAllowedStatuses : []).filter((s): s is ShopSettings["convertAllowedStatuses"][number] => PRODUCT_STATUSES.includes(s as never)),
    convertAllowedIds: list(raw.convertAllowedIds).map((s) => (/^\d+$/.test(s) ? `gid://shopify/Product/${s}` : s)).filter((s) => isGid(s, "Product")),
  };
}

function applyDecision(d: Decisions, body: Body, globals: { key: string; choices: string[] }[]): Decisions {
  const key = String(body.key ?? "");
  const value = String(body.value ?? "").trim();
  const global = globals.find((g) => g.key === key);
  if (!global) throw new OpError("That shared attribute does not exist.");
  if (!value) throw new OpError("Say which typed value this applies to.");
  const next = structuredClone(d);
  switch (body.what) {
    case "override": {
      const target = String(body.target ?? "");
      if (!global.choices.includes(target)) throw new OpError("That shared value does not exist.");
      (next.overrides[key] ??= {})[value] = target;
      break;
    }
    case "clear_override":
      delete next.overrides[key]?.[value];
      break;
    case "hold": {
      const reason = String(body.reason ?? "").trim().slice(0, 500);
      if (reason) (next.holds[key] ??= {})[value] = reason;
      else delete next.holds[key]?.[value];
      break;
    }
    case "planned": {
      const list = new Set(next.planned[key] ?? []);
      if (body.remove) list.delete(value);
      else list.add(value.slice(0, 255));
      next.planned[key] = [...list];
      break;
    }
    case "new_value":
      if (!global.choices.includes(value)) throw new OpError(`"${value}" is not a value of this shared attribute yet.`);
      next.newValues[key] = [...new Set([...(next.newValues[key] ?? []), value])];
      break;
    default:
      throw new OpError("Unknown setting.");
  }
  return next;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  if (params.action === "csv") {
    // Dry-run report (v1.3.9 "Download dry-run report (CSV)"). Cells that could be read as formulas are neutralised.
    const cell = (v: unknown) => {
      let t = String(v ?? "");
      if (/^[=+\-@]/.test(t)) t = "'" + t;
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const { items } = await store.dryRunItems(shop);
    const lines = [["Product ID", "Product name", "SKU", "Product status", "Attribute", "Current value", "New shared value", "Mapping", "Action", "Row state", "Product state", "Requires manual approval", "Note"].map(cell).join(",")];
    for (const p of items)
      for (const r of p.rows)
        lines.push([p.productId, p.name, p.sku, p.status, r.attribute, r.current, r.new, r.mapping, r.action === "drop-duplicate" ? "remove typed copy (already shared)" : "convert", r.state, p.state, r.state === "needs-approval" ? "yes" : "no", r.note].map(cell).join(","));
    return new Response("﻿" + lines.join("\r\n"), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="attribute-conversion-dry-run.csv"' },
    });
  }

  if (params.action === "config") {
    const gw = await gatewayFor(shop, admin);
    const [globals, collections, productTypes, productTags, locals, settings, decisions] = await Promise.all([gw.getGlobalAttributes(), gw.getCollections(), gw.getProductTypes(), gw.getProductTags(), localValues(shop, gw), store.getSettings(shop), store.getDecisions(shop)]);
    return json({ globals, collections, productTypes, productTags, localValues: locals, settings, decisions, batchSize: BATCH_SIZE, maxConditions: MAX_CONDITIONS });
  }

  if (params.action === "operations") {
    return json({ operations: await store.listOperations(shop, Math.min(100, Number(url.searchParams.get("limit")) || 20)) });
  }

  if (params.action === "operation") {
    const op = await store.getOperation(shop, String(url.searchParams.get("id") ?? ""));
    if (!op) return fail("That run is not in the log.", 404);
    const status = url.searchParams.get("status");
    const all = (await store.results(shop, op.id)).filter((t) => t.result);
    const rows = all.map((t) => t.result!).filter((r) => !status || r.status === status);
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    // The full before and after states stay in the log; the screen gets what it shows.
    return json({ operation: op, total: rows.length, results: rows.slice(offset, offset + 100).map(({ before: _b, after: _a, ...r }) => r) });
  }

  if (params.action === "dryrun") {
    const { operationId, items } = await store.dryRunItems(shop);
    return json({ operationId, items });
  }

  return fail("Unknown request.", 404);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const user = session.onlineAccessInfo?.associated_user;
  const userLabel = user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Staff" : "Staff";
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return fail("The request could not be read.");
  }
  if (!body || typeof body !== "object") return fail("The request could not be read.");

  try {
    switch (params.action) {
      case "search": {
        // One page of results. Shopify narrows the catalogue; every candidate is then confirmed exactly,
        // as v1.3.9 confirmed its LIKE matches. The cursor carries Shopify's cursor plus how far into that page we got.
        const filters = parseFilters((body.filters as Body) ?? {});
        const gw = await gatewayFor(shop, admin);
        const { items, next } = await searchPage(gw, filters, typeof body.cursor === "string" ? body.cursor : null);
        const total = queryIsExact(filters) ? await gw.countProducts(shopifyQuery(filters)) : null;
        return json({ items: items.map(tableRow), next, total });
      }

      case "preview": {
        const settings = await store.getSettings(shop);
        const gw = await gatewayFor(shop, admin);
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id): id is string => isGid(id, "Product")).slice(0, 50);
        const products = ids.length ? await gw.getProducts(ids) : (await gw.searchProducts(shopifyQuery(parseFilters((body.filters as Body) ?? {})), 25, null)).products.filter((p) => matches(p, parseFilters((body.filters as Body) ?? {})));
        if (body.type === "stock") {
          const status = String(body.stockStatus) as StockStatus;
          return json({ rows: products.map((p) => previewStock(p, status, settings)) });
        }
        const op = parseOp((body.params as Body) ?? {}, await gw.getGlobalAttributes(), settings);
        return json({ rows: products.map((p) => previewAttribute(p, op, settings)) });
      }

      case "start": {
        requireStaffScopes(session, body.type === "stock" ? ["write_products", "write_inventory"] : ["write_products"]);
        if (limited(shop)) return fail("Too many runs started in the last minute. Wait a moment.", 429);
        const gw = await gatewayFor(shop, admin);
        const selection =
          body.selectionMode === "ALL_MATCHING"
            ? { mode: "ALL_MATCHING" as const, filters: (body.filters as Body) ?? {} }
            : { mode: "IDS" as const, ids: (Array.isArray(body.ids) ? body.ids : []).filter((id): id is string => typeof id === "string") };
        const type = body.type as "stock" | "attributes" | "convert";
        const op = await createOperation(store, gw, shop, { type, params: (body.params as Body) ?? {}, selection, userLabel });
        log("operation.created", { shop, operationId: op.id, type, selectionMode: selection.mode });
        return json({ operation: op });
      }

      case "stop":
        requireStaffScopes(session, ["write_products"]);
        await requestStop(store, shop, String(body.id ?? ""));
        return json({ ok: true });

      case "revert": {
        requireStaffScopes(session, ["write_products", "write_inventory"]);
        if (limited(shop)) return fail("Too many runs started in the last minute. Wait a moment.", 429);
        const op = await createRevert(store, shop, String(body.id ?? ""), userLabel);
        log("operation.revert_created", { shop, operationId: op.id, revertOf: op.revertOf });
        return json({ operation: op });
      }

      case "dryrun": {
        if (limited(shop)) return fail("Too many runs started in the last minute. Wait a moment.", 429);
        return json({ operation: await createDryRun(store, shop, userLabel) });
      }

      case "decision": {
        requireStaffScopes(session, ["write_products"]);
        const settings = await store.getSettings(shop);
        if (!settings.convertWritesEnabled) return fail("Conversion is switched off for this store (dry run only). Nothing was changed.", 403);
        const gw = await gatewayFor(shop, admin);
        const next = applyDecision(await store.getDecisions(shop), body, await gw.getGlobalAttributes());
        await store.saveDecisions(shop, next);
        return json({ decisions: next });
      }

      case "settings": {
        requireStaffScopes(session, ["write_products"]);
        const settings = parseSettings(body);
        await store.saveSettings(shop, settings);
        log("settings.saved", { shop });
        return json({ settings });
      }

      case "reset-decisions":
        requireStaffScopes(session, ["write_products"]);
        await store.saveDecisions(shop, EMPTY_DECISIONS);
        return json({ decisions: EMPTY_DECISIONS });
    }
  } catch (e) {
    if (e instanceof EngineError || e instanceof OpError) return fail(e.message);
    log("api.error", { shop, action: params.action, message: (e as Error).message });
    return fail(`Something went wrong: ${(e as Error).message}`, 500);
  }
  return fail("Unknown request.", 404);
}
