/**
 * The app's public URL, from SHOPIFY_APP_URL. During "npm run dev" the Shopify CLI sets it to its tunnel.
 * In production it is the dedicated app domain (planned: https://app.cartovumagency.com) and must match
 * application_url in shopify.app.production.toml. The OAuth redirect URL is this URL + /auth/callback.
 *
 * A production server with a missing or non-HTTPS URL stops at startup with a clear message, rather than
 * failing later inside authentication. Plain http is accepted only for localhost.
 */
export function appUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.SHOPIFY_APP_URL ?? "").trim().replace(/\/+$/, "");
  const production = env.NODE_ENV === "production";

  if (!raw) {
    if (production) throw new Error("SHOPIFY_APP_URL is not set. Set it to the app's public HTTPS URL, e.g. https://app.cartovumagency.com.");
    return "";
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SHOPIFY_APP_URL is not a valid URL: "${raw}".`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (production && url.protocol !== "https:" && !local) {
    throw new Error(`SHOPIFY_APP_URL must use https in production (got "${raw}").`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`SHOPIFY_APP_URL must be the app's origin only, with no path (got "${raw}").`);
  }
  return url.origin;
}

export const authCallbackUrl = (env?: Record<string, string | undefined>) => `${appUrl(env)}/auth/callback`;
