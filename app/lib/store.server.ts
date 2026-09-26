import type { Operation as Row, OperationTarget as TargetRow, PrismaClient } from "@prisma/client";
import { EMPTY_DECISIONS, type Decisions } from "./core/convert";
import type { DryRunItem, Operation, Store, Target } from "./core/store";
import { DEFAULT_SETTINGS, type ShopSettings } from "./core/types";

/** Prisma implementation of the engine's Store. Every query filters by shop. */

const ACTIVE = ["resolving", "queued", "running", "stopping"];

function toOp(r: Row): Operation {
  return {
    ...r,
    type: r.type as Operation["type"],
    status: r.status as Operation["status"],
    selectionMode: r.selectionMode as Operation["selectionMode"],
    params: JSON.parse(r.params),
    filters: r.filters ? JSON.parse(r.filters) : null,
  };
}

function toTarget(t: TargetRow): Target {
  return { ...t, state: t.state as Target["state"], result: t.result ? JSON.parse(t.result) : null };
}

function fromPatch(patch: Partial<Operation>) {
  const { params, filters, id: _id, shop: _shop, createdAt: _c, ...rest } = patch;
  return {
    ...rest,
    ...(params !== undefined ? { params: JSON.stringify(params) } : {}),
    ...(filters !== undefined ? { filters: filters ? JSON.stringify(filters) : null } : {}),
  };
}

export class PrismaStore implements Store {
  constructor(private db: PrismaClient) {}

  async createOperation(op: Omit<Operation, "id" | "createdAt">) {
    const { params, filters, ...rest } = op;
    return toOp(await this.db.operation.create({ data: { ...rest, params: JSON.stringify(params), filters: filters ? JSON.stringify(filters) : null } }));
  }
  async getOperation(shop: string, id: string) {
    const r = await this.db.operation.findFirst({ where: { id, shop } });
    return r ? toOp(r) : null;
  }
  async updateOperation(shop: string, id: string, patch: Partial<Operation>) {
    await this.db.operation.updateMany({ where: { id, shop }, data: fromPatch(patch) });
  }
  async listOperations(shop: string, limit: number) {
    return (await this.db.operation.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: limit })).map(toOp);
  }
  async claim(now: Date, leaseMs: number) {
    const candidates = await this.db.operation.findMany({
      where: { status: { in: ACTIVE }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    for (const c of candidates) {
      // Compare-and-set on the lease: only one worker wins, even across processes.
      const won = await this.db.operation.updateMany({
        where: { id: c.id, leaseUntil: c.leaseUntil },
        data: { leaseUntil: new Date(now.getTime() + leaseMs) },
      });
      if (won.count === 1) return toOp(c);
    }
    return null;
  }
  private async owns(shop: string, operationId: string) {
    return (await this.db.operation.count({ where: { id: operationId, shop } })) === 1;
  }
  async addTargets(shop: string, operationId: string, list: { productId: string; expect?: string | null }[]) {
    if (!(await this.owns(shop, operationId)) || !list.length) return 0;
    const existing = await this.db.operationTarget.count({ where: { operationId } });
    const known = new Set(
      (await this.db.operationTarget.findMany({ where: { operationId, productId: { in: list.map((t) => t.productId) } }, select: { productId: true } })).map((t) => t.productId),
    );
    const fresh = list.filter((t, i) => !known.has(t.productId) && list.findIndex((x) => x.productId === t.productId) === i);
    for (let i = 0; i < fresh.length; i += 500) {
      await this.db.operationTarget.createMany({
        data: fresh.slice(i, i + 500).map((t, j) => ({ operationId, seq: existing + i + j, productId: t.productId, expect: t.expect ?? null })),
      });
    }
    return fresh.length;
  }
  async nextTargets(shop: string, operationId: string, limit: number) {
    if (!(await this.owns(shop, operationId))) return [];
    return (await this.db.operationTarget.findMany({ where: { operationId, state: { not: "done" } }, orderBy: { seq: "asc" }, take: limit })).map(toTarget);
  }
  async markWriting(shop: string, id: number, before: string) {
    await this.db.operationTarget.updateMany({ where: { id, operation: { shop } }, data: { state: "writing", pendingBefore: before } });
  }
  async saveResult(shop: string, id: number, result: unknown) {
    await this.db.operationTarget.updateMany({ where: { id, operation: { shop } }, data: { state: "done", result: JSON.stringify(result) } });
  }
  async results(shop: string, operationId: string) {
    if (!(await this.owns(shop, operationId))) return [];
    return (await this.db.operationTarget.findMany({ where: { operationId }, orderBy: { seq: "asc" } })).map(toTarget);
  }
  async prune(shop: string, keep: number) {
    const old = await this.db.operation.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, skip: keep, select: { id: true, status: true } });
    const ids = old.filter((o) => !ACTIVE.includes(o.status)).map((o) => o.id);
    if (!ids.length) return;
    const config = await this.db.shopConfig.findUnique({ where: { shop } });
    const keepIds = ids.filter((id) => id !== config?.latestDryRunId);
    await this.db.dryRunItem.deleteMany({ where: { shop, operationId: { in: keepIds } } });
    await this.db.operation.deleteMany({ where: { shop, id: { in: keepIds } } });
  }
  private async config(shop: string) {
    return this.db.shopConfig.upsert({ where: { shop }, update: {}, create: { shop, settings: JSON.stringify(DEFAULT_SETTINGS), decisions: JSON.stringify(EMPTY_DECISIONS) } });
  }
  async getSettings(shop: string): Promise<ShopSettings> {
    return { ...DEFAULT_SETTINGS, ...JSON.parse((await this.config(shop)).settings) };
  }
  async saveSettings(shop: string, settings: ShopSettings) {
    await this.config(shop);
    await this.db.shopConfig.update({ where: { shop }, data: { settings: JSON.stringify(settings) } });
  }
  async getDecisions(shop: string): Promise<Decisions> {
    return { ...EMPTY_DECISIONS, ...JSON.parse((await this.config(shop)).decisions) };
  }
  async saveDecisions(shop: string, decisions: Decisions) {
    await this.config(shop);
    await this.db.shopConfig.update({ where: { shop }, data: { decisions: JSON.stringify(decisions) } });
  }
  async replaceDryRun(shop: string, operationId: string) {
    await this.config(shop);
    await this.db.dryRunItem.deleteMany({ where: { shop, operationId: { not: operationId } } });
    await this.db.shopConfig.update({ where: { shop }, data: { latestDryRunId: operationId } });
  }
  async addDryRunItems(shop: string, operationId: string, items: DryRunItem[]) {
    if (!items.length || !(await this.owns(shop, operationId))) return;
    await this.db.dryRunItem.createMany({ data: items.map((i) => ({ shop, operationId, productId: i.productId, data: JSON.stringify(i) })) });
  }
  async dryRunItems(shop: string, operationId?: string) {
    const id = operationId ?? (await this.config(shop)).latestDryRunId;
    if (!id) return { operationId: null, items: [] };
    const rows = await this.db.dryRunItem.findMany({ where: { shop, operationId: id }, orderBy: { id: "asc" } });
    return { operationId: id, items: rows.map((r) => JSON.parse(r.data) as DryRunItem) };
  }
  async purgeShop(shop: string) {
    await this.db.$transaction([
      this.db.dryRunItem.deleteMany({ where: { shop } }),
      this.db.operation.deleteMany({ where: { shop } }),
      this.db.shopConfig.deleteMany({ where: { shop } }),
      this.db.localValueCache.deleteMany({ where: { shop } }),
      this.db.session.deleteMany({ where: { shop } }),
    ]);
  }
}
