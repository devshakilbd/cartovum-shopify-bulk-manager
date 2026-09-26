import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { firstDelivery } from "../lib/webhooks.server";
import { log } from "../lib/log.server";
import { authenticate } from "../shopify.server";

/**
 * Uninstall: the access token is removed at once and any run in progress is stopped. Run history is
 * kept until Shopify sends shop/redact (48 hours later), so a quick reinstall keeps its Put back.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  if (!(await firstDelivery(webhookId, shop, topic))) return new Response();

  await db.session.deleteMany({ where: { shop } });
  await db.operation.updateMany({
    where: { shop, status: { in: ["resolving", "queued", "running", "stopping"] } },
    data: { status: "stopped", completedAt: new Date(), leaseUntil: null, message: "Stopped because the app was uninstalled. Products not reached were not changed." },
  });
  log("webhook.uninstalled", { shop });
  return new Response();
};
