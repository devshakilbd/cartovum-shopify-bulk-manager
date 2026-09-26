import { randomUUID } from "node:crypto";
import { EMPTY_DECISIONS, type Decisions } from "./convert";
import type { DryRunItem, Operation, Store, Target } from "./store";
import { DEFAULT_SETTINGS, type ResultRow, type ShopSettings } from "./types";

/** In-memory Store with the same contract as the Prisma one. Used by tests and simulations. */
export class MemoryStore implements Store {
  ops = new Map<string, Operation>();
  targets: Target[] = [];
  settings = new Map<string, ShopSettings>();
  decisions = new Map<string, Decisions>();
  dry = new Map<string, DryRunItem[]>();
  latestDry = new Map<string, string>();
  private seq = 0;
  private clock = 0;

  async createOperation(op: Omit<Operation, "id" | "createdAt">) {
    // Strictly increasing timestamps keep "newest first" deterministic within one millisecond.
    const created = { ...op, id: randomUUID(), createdAt: new Date(Date.now() + this.clock++) };
    this.ops.set(created.id, created);
    return { ...created };
  }
  async getOperation(shop: string, id: string) {
    const op = this.ops.get(id);
    return op && op.shop === shop ? { ...op } : null;
  }
  async updateOperation(shop: string, id: string, patch: Partial<Operation>) {
    const op = this.ops.get(id);
    if (op && op.shop === shop) this.ops.set(id, { ...op, ...patch });
  }
  async listOperations(shop: string, limit: number) {
    return [...this.ops.values()].filter((o) => o.shop === shop).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
  async claim(now: Date, leaseMs: number) {
    const op = [...this.ops.values()].find((o) => ["resolving", "queued", "running", "stopping"].includes(o.status) && (!o.leaseUntil || o.leaseUntil < now));
    if (!op) return null;
    op.leaseUntil = new Date(now.getTime() + leaseMs);
    return { ...op };
  }
  async addTargets(shop: string, operationId: string, list: { productId: string; expect?: string | null }[]) {
    const existing = new Set(this.targets.filter((t) => t.operationId === operationId).map((t) => t.productId));
    let added = 0;
    let seq = this.targets.filter((t) => t.operationId === operationId).length;
    for (const t of list) {
      if (existing.has(t.productId)) continue;
      existing.add(t.productId);
      this.targets.push({ id: ++this.seq, operationId, seq: seq++, productId: t.productId, expect: t.expect ?? null, state: "pending", pendingBefore: null, result: null });
      added++;
    }
    return added;
  }
  private own(shop: string, operationId: string) {
    return this.ops.get(operationId)?.shop === shop;
  }
  async nextTargets(shop: string, operationId: string, limit: number) {
    if (!this.own(shop, operationId)) return [];
    return this.targets.filter((t) => t.operationId === operationId && t.state !== "done").sort((a, b) => a.seq - b.seq).slice(0, limit).map((t) => ({ ...t }));
  }
  private target(shop: string, id: number) {
    const t = this.targets.find((x) => x.id === id);
    return t && this.own(shop, t.operationId) ? t : null;
  }
  async markWriting(shop: string, id: number, before: string) {
    const t = this.target(shop, id);
    if (t) Object.assign(t, { state: "writing", pendingBefore: before });
  }
  async saveResult(shop: string, id: number, result: ResultRow) {
    const t = this.target(shop, id);
    if (t) Object.assign(t, { state: "done", result });
  }
  async results(shop: string, operationId: string) {
    if (!this.own(shop, operationId)) return [];
    return this.targets.filter((t) => t.operationId === operationId).sort((a, b) => a.seq - b.seq);
  }
  async prune(shop: string, keep: number) {
    const list = await this.listOperations(shop, Number.MAX_SAFE_INTEGER);
    for (const op of list.slice(keep)) {
      if (["resolving", "queued", "running", "stopping"].includes(op.status)) continue;
      this.ops.delete(op.id);
      this.targets = this.targets.filter((t) => t.operationId !== op.id);
    }
  }
  async getSettings(shop: string) {
    return { ...DEFAULT_SETTINGS, ...(this.settings.get(shop) ?? {}) };
  }
  async saveSettings(shop: string, s: ShopSettings) {
    this.settings.set(shop, s);
  }
  async getDecisions(shop: string) {
    return structuredClone(this.decisions.get(shop) ?? EMPTY_DECISIONS);
  }
  async saveDecisions(shop: string, d: Decisions) {
    this.decisions.set(shop, structuredClone(d));
  }
  async replaceDryRun(shop: string, operationId: string) {
    const old = this.latestDry.get(shop);
    if (old && old !== operationId) this.dry.delete(old);
    this.latestDry.set(shop, operationId);
  }
  async addDryRunItems(shop: string, operationId: string, items: DryRunItem[]) {
    if (!this.own(shop, operationId)) return;
    this.dry.set(operationId, [...(this.dry.get(operationId) ?? []), ...items]);
  }
  async dryRunItems(shop: string, operationId?: string) {
    const id = operationId ?? this.latestDry.get(shop) ?? null;
    if (!id || !this.own(shop, id)) return { operationId: null, items: [] };
    return { operationId: id, items: this.dry.get(id) ?? [] };
  }
  async purgeShop(shop: string) {
    for (const op of [...this.ops.values()]) if (op.shop === shop) {
      this.ops.delete(op.id);
      this.targets = this.targets.filter((t) => t.operationId !== op.id);
      this.dry.delete(op.id);
    }
    this.settings.delete(shop);
    this.decisions.delete(shop);
    this.latestDry.delete(shop);
  }
}
