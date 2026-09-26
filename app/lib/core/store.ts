import type { ConvertPlan, Decisions } from "./convert";
import type { Filters, ResultRow, ShopSettings } from "./types";

/**
 * Persistence the engine needs, always scoped by shop. Prisma implements it in production
 * (store.server.ts); MemoryStore implements it for tests. Every method takes the shop so one store's
 * data can never be read or written through another's request.
 */

export type OperationType = "stock" | "attributes" | "convert" | "revert" | "dryrun";
export type OperationStatus = "resolving" | "queued" | "running" | "stopping" | "stopped" | "completed" | "failed";

export interface Operation {
  id: string;
  shop: string;
  type: OperationType;
  status: OperationStatus;
  params: Record<string, unknown>;
  selectionMode: "IDS" | "ALL_MATCHING";
  filters: Filters | null;
  resolveCursor: string | null;
  capped: boolean;
  userLabel: string;
  total: number;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
  message: string;
  revertOf: string | null;
  revertedAt: Date | null;
  revertedBy: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  leaseUntil: Date | null;
}

export interface Target {
  id: number;
  operationId: string;
  seq: number;
  productId: string;
  /** Convert: the dry-run signature. Revert: the recorded row being undone (JSON). */
  expect: string | null;
  state: "pending" | "writing" | "done";
  /** Before-state saved just before the write, for reconciling an interrupted write. */
  pendingBefore: string | null;
  result: ResultRow | null;
}

export interface DryRunItem {
  productId: string;
  name: string;
  sku: string;
  status: string;
  state: ConvertPlan["state"];
  note: string;
  signature: string;
  rows: ConvertPlan["rows"];
}

export interface Store {
  createOperation(op: Omit<Operation, "id" | "createdAt">): Promise<Operation>;
  getOperation(shop: string, id: string): Promise<Operation | null>;
  updateOperation(shop: string, id: string, patch: Partial<Operation>): Promise<void>;
  listOperations(shop: string, limit: number): Promise<Operation[]>;
  /** Claims one operation needing work whose lease has expired. Atomic across workers. */
  claim(now: Date, leaseMs: number): Promise<Operation | null>;

  addTargets(shop: string, operationId: string, targets: { productId: string; expect?: string | null }[]): Promise<number>;
  nextTargets(shop: string, operationId: string, limit: number): Promise<Target[]>;
  markWriting(shop: string, targetId: number, before: string): Promise<void>;
  saveResult(shop: string, targetId: number, result: ResultRow): Promise<void>;
  results(shop: string, operationId: string): Promise<Target[]>;

  prune(shop: string, keep: number): Promise<void>;
  getSettings(shop: string): Promise<ShopSettings>;
  saveSettings(shop: string, settings: ShopSettings): Promise<void>;
  getDecisions(shop: string): Promise<Decisions>;
  saveDecisions(shop: string, decisions: Decisions): Promise<void>;

  /** The latest completed dry run for the shop, used as the only source of convert signatures. */
  replaceDryRun(shop: string, operationId: string): Promise<void>;
  addDryRunItems(shop: string, operationId: string, items: DryRunItem[]): Promise<void>;
  dryRunItems(shop: string, operationId?: string): Promise<{ operationId: string | null; items: DryRunItem[] }>;
  /** Removes everything held for a shop (uninstall / shop redact). */
  purgeShop(shop: string): Promise<void>;
}
