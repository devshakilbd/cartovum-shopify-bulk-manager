import db from "../db.server";

/** Webhooks can be delivered more than once. Returns false for a delivery already handled. */
export async function firstDelivery(webhookId: string, shop: string, topic: string) {
  if (!webhookId) return true;
  try {
    await db.webhookEvent.create({ data: { id: webhookId, shop, topic } });
    await db.webhookEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86400_000) } } });
    return true;
  } catch {
    return false;
  }
}
