import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { step } from "./core/engine";
import { ShopifyGateway, type AdminClient } from "./gateway.server";
import { log } from "./log.server";
import { PrismaStore } from "./store.server";

export const store = new PrismaStore(prisma);

export async function gatewayFor(shop: string, admin: AdminClient) {
  return new ShopifyGateway(admin, await store.getSettings(shop), shop);
}

/** Local attribute values are one catalogue scan, cached for 12 hours and dropped after any attribute change. */
export async function localValues(shop: string, gw: ShopifyGateway) {
  const cached = await prisma.localValueCache.findUnique({ where: { shop } });
  if (cached && Date.now() - cached.createdAt.getTime() < 12 * 3600_000) return JSON.parse(cached.data) as Awaited<ReturnType<ShopifyGateway["getLocalAttributeValues"]>>;
  const data = await gw.getLocalAttributeValues();
  await prisma.localValueCache.upsert({ where: { shop }, update: { data: JSON.stringify(data), createdAt: new Date() }, create: { shop, data: JSON.stringify(data) } });
  return data;
}

export const flushLocalValues = (shop: string) => prisma.localValueCache.deleteMany({ where: { shop } });

/* ------------------------------------------------------------------ background worker */

const LEASE_MS = 60_000;
const IDLE_MS = 1_000;

declare global {
  // eslint-disable-next-line no-var
  var cartovumWorker: boolean | undefined;
}

/**
 * One loop per server process. It claims an operation (a lease, so several processes never work the
 * same one), runs a single step (one batch of 10), then releases it. Operations therefore interleave
 * fairly between shops, and a crashed process's lease simply expires and another picks the work up.
 */
export function startWorker() {
  if (global.cartovumWorker || process.env.CARTOVUM_WORKER === "off") return;
  global.cartovumWorker = true;

  const errors = new Map<string, number>();
  const tick = async () => {
    let busy = false;
    let current: { shop: string; id: string } | null = null;
    try {
      const op = await store.claim(new Date(), LEASE_MS);
      if (op) {
        busy = true;
        current = op;
        const { admin } = await unauthenticated.admin(op.shop);
        const gw = await gatewayFor(op.shop, admin);
        const more = await step(store, gw, op.shop, op.id);
        if (["attributes", "convert", "revert"].includes(op.type)) await flushLocalValues(op.shop);
        await store.updateOperation(op.shop, op.id, { leaseUntil: null });
        errors.delete(op.id);
        if (!more) log("operation.finished", { shop: op.shop, operationId: op.id, type: op.type });
      }
    } catch (e) {
      const message = (e as Error).message;
      log("worker.error", { operationId: current?.id, message });
      if (current) {
        // The lease is left to expire, so the step is retried a minute later; a run that keeps failing
        // (for example, the store uninstalled the app) is marked failed instead of retrying forever.
        const count = (errors.get(current.id) ?? 0) + 1;
        errors.set(current.id, count);
        if (count >= 5) {
          errors.delete(current.id);
          await store
            .updateOperation(current.shop, current.id, { status: "failed", completedAt: new Date(), leaseUntil: null, message: `The run could not continue: ${message}. Products already processed keep their results and can be put back.` })
            .catch(() => undefined);
        }
      }
    } finally {
      setTimeout(tick, busy ? 0 : IDLE_MS);
    }
  };
  setTimeout(tick, IDLE_MS);
}
