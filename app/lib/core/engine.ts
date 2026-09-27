import { applyAttributeOne, parseOp, revertAttributesOne } from "./attributes";
import { blockingNote, convertOne, planProduct } from "./convert";
import { canonical, primarySku } from "./fingerprint";
import { matches, normaliseFilters, parseFilters, shopifyQuery } from "./filters";
import type { Gateway } from "./gateway";
import { applyStockOne, revertStockOne, row, snap, type StockSnapshot } from "./stock";
import type { Operation, OperationType, Store, Target } from "./store";
import type { AttributeOp, Filters, ProductState, ResultRow, StockStatus } from "./types";
import { BATCH_SIZE, MAX_PER_REQUEST, STOCK_STATUSES } from "./types";

/**
 * The operation engine (v1.3.9 SWBM_Jobs + SWBM_Ajax run_batch / revert_batch).
 *
 * An operation is created with a frozen target list (explicit IDs, or every product matching a filter
 * snapshot, resolved on the server). Work then happens one step at a time: a step processes one batch
 * of 10 and records a result for every product, so progress is visible, a stop takes effect after the
 * current batch, and an interrupted run resumes without applying anything twice.
 */

export class EngineError extends Error {}

const RESOLVE_PAGE = 250;

export interface CreateInput {
  type: Exclude<OperationType, "revert" | "dryrun">;
  params: Record<string, unknown>;
  selection: { mode: "IDS"; ids: string[] } | { mode: "ALL_MATCHING"; filters: Record<string, unknown> };
  userLabel: string;
}

const blank = {
  resolveCursor: null,
  capped: false,
  total: 0,
  processed: 0,
  changed: 0,
  skipped: 0,
  failed: 0,
  message: "",
  revertOf: null,
  revertedAt: null,
  revertedBy: null,
  cancelRequested: false,
  startedAt: null,
  completedAt: null,
  leaseUntil: null,
};

const GID_PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/;

/** Validate the requested change and open an operation for it. */
export async function createOperation(store: Store, gw: Gateway, shop: string, input: CreateInput): Promise<Operation> {
  const settings = await store.getSettings(shop);
  let params: Record<string, unknown>;

  if (input.type === "stock") {
    const status = input.params.stockStatus as StockStatus;
    if (!STOCK_STATUSES.includes(status)) throw new EngineError("Choose a stock status.");
    params = { stockStatus: status };
  } else if (input.type === "attributes") {
    const globals = await gw.getGlobalAttributes();
    try {
      params = { op: parseOp(input.params, globals, settings) };
    } catch (e) {
      throw new EngineError((e as Error).message);
    }
  } else if (input.type === "convert") {
    if (!settings.convertWritesEnabled) throw new EngineError("Conversion is switched off for this store (dry run only). Nothing was changed.");
    const dry = await store.dryRunItems(shop);
    if (!dry.operationId) throw new EngineError("Run the dry run first.");
    params = { dryRunId: dry.operationId };
  } else {
    throw new EngineError("Unknown operation.");
  }

  if (input.selection.mode === "IDS") {
    const ids = [...new Set(input.selection.ids)].filter((id) => GID_PRODUCT.test(id));
    if (!ids.length) throw new EngineError("Select some products first.");
    if (ids.length > settings.selectAllCap) throw new EngineError(`At most ${settings.selectAllCap} products can be changed in one run.`);
    let targets = ids.map((productId) => ({ productId, expect: null as string | null }));
    if (input.type === "convert") {
      // Signatures come from the server's own latest dry run, never from the browser. Only products that
      // were ready in it are converted (v1.3.9: "Only selected products that were ready in the latest dry run").
      const dry = await store.dryRunItems(shop);
      const ready = new Map(dry.items.filter((i) => i.state === "ready").map((i) => [i.productId, i.signature]));
      targets = targets.filter((t) => ready.has(t.productId)).map((t) => ({ ...t, expect: ready.get(t.productId)! }));
      if (!targets.length) throw new EngineError("None of the selected products were ready in the latest dry run.");
    }
    const op = await store.createOperation({ ...blank, shop, type: input.type, status: "queued", params, selectionMode: "IDS", filters: null, userLabel: input.userLabel, total: targets.length });
    await store.addTargets(shop, op.id, targets);
    await store.prune(shop, settings.keepJobs);
    return op;
  }

  if (input.type === "convert") throw new EngineError("Choose the products to convert from the dry run.");
  const filters = parseFilters(input.selection.filters);
  const op = await store.createOperation({ ...blank, shop, type: input.type, status: "resolving", params, selectionMode: "ALL_MATCHING", filters, userLabel: input.userLabel });
  await store.prune(shop, settings.keepJobs);
  return op;
}

/** Open an operation that undoes an earlier one (v1.3.9 revert_start). */
export async function createRevert(store: Store, shop: string, sourceId: string, userLabel: string): Promise<Operation> {
  const source = await store.getOperation(shop, sourceId);
  if (!source) throw new EngineError("That run is not in the log.");
  if (source.type === "revert") throw new EngineError("A revert cannot itself be reverted. Run the change again instead.");
  if (source.type === "dryrun") throw new EngineError("A dry run changes nothing, so there is nothing to put back.");
  if (source.revertedAt) throw new EngineError("That run has already been put back.");
  if (!["completed", "stopped", "failed"].includes(source.status)) throw new EngineError("That run is still in progress. Wait for it to finish or stop it first.");

  // Rows that wrote to a product, including those saved but failing their read-back check.
  const rows = (await store.results(shop, sourceId))
    .map((t) => t.result)
    .filter((r): r is ResultRow => !!r && (r.status === "changed" || (r.status === "failed" && r.after !== undefined)));
  if (!rows.length) throw new EngineError("That run changed nothing, so there is nothing to put back.");

  const settings = await store.getSettings(shop);
  const op = await store.createOperation({
    ...blank,
    shop,
    type: "revert",
    status: "queued",
    params: { kind: source.type },
    selectionMode: "IDS",
    filters: null,
    userLabel,
    revertOf: sourceId,
    total: rows.length,
  });
  await store.addTargets(shop, op.id, rows.map((r) => ({ productId: r.id, expect: JSON.stringify(r) })));
  await store.prune(shop, settings.keepJobs);
  return op;
}

export async function createDryRun(store: Store, shop: string, userLabel: string): Promise<Operation> {
  const settings = await store.getSettings(shop);
  const op = await store.createOperation({ ...blank, shop, type: "dryrun", status: "resolving", params: {}, selectionMode: "ALL_MATCHING", filters: null, userLabel });
  await store.prune(shop, settings.keepJobs);
  return op;
}

export async function requestStop(store: Store, shop: string, id: string) {
  const op = await store.getOperation(shop, id);
  if (!op) throw new EngineError("That run is not in the log.");
  if (["completed", "stopped", "failed"].includes(op.status)) return;
  await store.updateOperation(shop, id, { cancelRequested: true, status: op.status === "resolving" ? "stopped" : "stopping", ...(op.status === "resolving" ? { completedAt: new Date(), message: "Stopped before any product was changed." } : {}) });
}

/* -------------------------------------------------------------------------- stepping */

/** Where the before-state of one product lives, for comparing after an interruption. */
function currentState(type: string, product: ProductState, before: unknown): unknown {
  if (type === "stock") {
    const variant = product.variants.find((v) => v.id === (before as StockSnapshot).variantId);
    return variant ? snap(variant) : null;
  }
  return product.attributes;
}

/**
 * A product whose write began but never recorded a result (crash, deploy, timeout). If it is still
 * exactly as it was before, it is processed normally. If not, the write landed at least in part: it is
 * recorded as failed with its before and after, which keeps it available to Put back, and never re-applied.
 */
async function reconcile(gw: Gateway, type: string, t: Target): Promise<ResultRow | null> {
  const before = JSON.parse(t.pendingBefore!);
  const product = (await gw.getProducts([t.productId]))[0];
  if (!product) return row(null, t.productId, "failed", "Product not found after an interruption.");
  const now = currentState(type, product, before);
  if (canonical(now) === canonical(before)) return null;
  return row(product, t.productId, "failed", "The run was interrupted during this product's write. It was changed but could not be verified in the same pass, so it was not written again. Review it; Put back is available.", before, now);
}

async function processTarget(store: Store, gw: Gateway, op: Operation, t: Target, ctx: Ctx): Promise<ResultRow> {
  const kind = op.type === "revert" ? String(op.params.kind) : op.type;
  if (t.state === "writing" && t.pendingBefore) {
    const reconciled = await reconcile(gw, kind, t);
    if (reconciled) return reconciled;
  }
  const beforeWrite = (before: unknown) => store.markWriting(op.shop, t.id, JSON.stringify(before));

  switch (op.type) {
    case "stock":
      return applyStockOne(gw, t.productId, op.params.stockStatus as StockStatus, ctx.settings, beforeWrite);
    case "attributes":
      return applyAttributeOne(gw, t.productId, op.params.op as AttributeOp, ctx.settings, beforeWrite);
    case "convert":
      return convertOne(gw, t.productId, t.expect ?? "", await ctx.globals(), await ctx.decisions(), ctx.settings, beforeWrite);
    case "revert": {
      const recorded = JSON.parse(t.expect ?? "{}") as ResultRow;
      return kind === "stock" ? revertStockOne(gw, recorded, beforeWrite) : revertAttributesOne(gw, recorded, beforeWrite);
    }
  }
  return row(null, t.productId, "failed", "Unknown operation.");
}

interface Ctx {
  settings: Awaited<ReturnType<Store["getSettings"]>>;
  globals: () => ReturnType<Gateway["getGlobalAttributes"]>;
  decisions: () => ReturnType<Store["getDecisions"]>;
}

function context(store: Store, gw: Gateway, settings: Ctx["settings"], shop: string): Ctx {
  let globals: ReturnType<Gateway["getGlobalAttributes"]> | null = null;
  let decisions: ReturnType<Store["getDecisions"]> | null = null;
  return {
    settings,
    globals: () => (globals ??= gw.getGlobalAttributes()),
    decisions: () => (decisions ??= store.getDecisions(shop)),
  };
}

/** Scan one page of the catalogue and add the products that match (select all matching / dry run). */
async function resolveStep(store: Store, gw: Gateway, op: Operation, ctx: Ctx): Promise<void> {
  const filters = op.filters ? normaliseFilters(op.filters as Partial<Filters>) : null;
  const query = filters ? shopifyQuery(filters) : "";
  const page = await gw.searchProducts(query, RESOLVE_PAGE, op.resolveCursor);

  if (op.type === "dryrun") {
    const globals = await ctx.globals();
    const decisions = await ctx.decisions();
    const items = page.products
      .map((p) => ({ p, plan: planProduct(p, globals, decisions, ctx.settings) }))
      .filter((x) => x.plan.state !== "none")
      .map(({ p, plan }) => ({
        productId: p.id,
        name: p.title,
        sku: primarySku(p),
        status: p.status,
        state: plan.state,
        note: plan.state === "ready" ? "" : blockingNote(plan),
        signature: plan.signature,
        rows: plan.rows,
      }));
    await store.addDryRunItems(op.shop, op.id, items);
    const processed = op.processed + page.products.length;
    const found = op.total + items.length;
    if (!page.hasNextPage) {
      await store.replaceDryRun(op.shop, op.id);
      await store.updateOperation(op.shop, op.id, { processed, total: found, resolveCursor: null, status: "completed", completedAt: new Date(), message: `Scanned ${processed} products; ${found} have typed attributes.` });
    } else {
      await store.updateOperation(op.shop, op.id, { processed, total: found, resolveCursor: page.endCursor });
    }
    return;
  }

  const matching = filters ? page.products.filter((p) => matches(p, filters)) : page.products;
  const room = ctx.settings.selectAllCap - op.total;
  const take = matching.slice(0, Math.max(0, room));
  const added = await store.addTargets(op.shop, op.id, take.map((p) => ({ productId: p.id })));
  const total = op.total + added;
  const capped = matching.length > take.length;

  if (!page.hasNextPage || capped) {
    await store.updateOperation(op.shop, op.id, {
      total,
      capped,
      resolveCursor: null,
      status: total ? "queued" : "completed",
      ...(total ? {} : { completedAt: new Date(), message: "No products matched." }),
      ...(capped ? { message: `More products matched than one run can hold. The first ${total} were selected.` } : {}),
    });
  } else {
    await store.updateOperation(op.shop, op.id, { total, resolveCursor: page.endCursor });
  }
}

/**
 * Do one unit of work on an operation. Returns false when there is nothing left to do.
 * batchSize is capped at MAX_PER_REQUEST: a larger batch is refused, never trimmed.
 */
export async function step(store: Store, gw: Gateway, shop: string, id: string, batchSize = BATCH_SIZE): Promise<boolean> {
  if (batchSize > MAX_PER_REQUEST || batchSize < 1) throw new EngineError(`Too many products in one batch: ${batchSize} requested, ${MAX_PER_REQUEST} is the most allowed. Nothing was changed.`);
  const op = await store.getOperation(shop, id);
  if (!op || ["completed", "stopped", "failed"].includes(op.status)) return false;
  const ctx = context(store, gw, await store.getSettings(shop), shop);

  if (op.cancelRequested) {
    await store.updateOperation(shop, id, { status: "stopped", completedAt: new Date(), message: op.message || "Stopped after the last batch. Products not reached were not changed." });
    return false;
  }
  if (op.status === "resolving") {
    await resolveStep(store, gw, op, ctx);
    return true;
  }

  if (op.type === "convert" && !ctx.settings.convertWritesEnabled) {
    await store.updateOperation(shop, id, { status: "stopped", completedAt: new Date(), message: "Conversion was switched off for this store, so the run stopped. Nothing else was changed." });
    return false;
  }

  const batch = await store.nextTargets(shop, id, batchSize);
  if (!batch.length) {
    await finish(store, op);
    return false;
  }
  if (!op.startedAt || op.status === "queued") await store.updateOperation(shop, id, { status: "running", startedAt: op.startedAt ?? new Date() });

  const counts = { changed: 0, skipped: 0, failed: 0 };
  for (const t of batch) {
    let result: ResultRow;
    try {
      result = await processTarget(store, gw, op, t, ctx);
    } catch (e) {
      result = row(null, t.productId, "failed", `Unexpected error: ${(e as Error).message}`);
    }
    await store.saveResult(shop, t.id, result);
    counts[result.status]++;
  }

  const patch: Partial<Operation> = {
    processed: op.processed + batch.length,
    changed: op.changed + counts.changed,
    skipped: op.skipped + counts.skipped,
    failed: op.failed + counts.failed,
  };
  // A conversion stops at the first product that fails its check, so nothing after it is changed.
  if (op.type === "convert" && counts.failed) {
    Object.assign(patch, { status: "stopped", completedAt: new Date(), message: "Stopped: a product failed its check, so nothing after it was changed. Review the results, then use Put back if needed." });
  }
  await store.updateOperation(shop, id, patch);
  return patch.status !== "stopped";
}

async function finish(store: Store, op: Operation) {
  const done = await store.results(op.shop, op.id);
  const missing = done.filter((t) => !t.result).length;
  await store.updateOperation(op.shop, op.id, {
    status: op.status === "stopping" ? "stopped" : "completed",
    completedAt: new Date(),
    message: missing ? `Warning: ${missing} products were not processed and are unchanged. Run them again.` : op.message,
  });
  if (op.type === "revert" && op.revertOf) {
    await store.updateOperation(op.shop, op.revertOf, { revertedAt: new Date(), revertedBy: op.id });
  }
}

/** Run an operation to the end in-process (used by the worker and by tests). */
export async function runToEnd(store: Store, gw: Gateway, shop: string, id: string, maxSteps = 1_000_000) {
  for (let i = 0; i < maxSteps; i++) if (!(await step(store, gw, shop, id))) return;
}
