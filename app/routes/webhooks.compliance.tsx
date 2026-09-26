import type { ActionFunctionArgs } from "react-router";
import { firstDelivery } from "../lib/webhooks.server";
import { log } from "../lib/log.server";
import { store } from "../lib/services.server";
import { authenticate } from "../shopify.server";

/**
 * Mandatory privacy webhooks. The app stores no customer data, so the two customer topics have nothing
 * to return or erase. shop/redact erases everything held for the store.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  if (!(await firstDelivery(webhookId, shop, topic))) return new Response();

  if (topic === "SHOP_REDACT") await store.purgeShop(shop);
  log("webhook.compliance", { shop, topic });
  return new Response();
};
