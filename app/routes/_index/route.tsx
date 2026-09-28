import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { APP_NAME, PublicPage } from "../../components/public-page";

export const meta: MetaFunction = () => [{ title: APP_NAME }, { name: "description", content: "Bulk-edit Shopify stock status and product attributes safely: batches of 10, every product checked afterwards, and every run can be put back." }];

/** Shopify opens the app with ?shop=…; send that into the embedded app. Everyone else sees the public page. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  return null;
};

export default function Landing() {
  return (
    <PublicPage title={APP_NAME}>
      <p>Find products, filter and select them, then change their stock status or one attribute across all of them — safely.</p>
      <ul>
        <li>Search by name, SKU, collection, product type, tags, status, stock status and several attribute conditions at once.</li>
        <li>Select page by page, or every matching product in one click.</li>
        <li>Set stock status; add, remove or replace attribute values; remove an attribute; set a typed value.</li>
        <li>Convert free-text attributes to shared attributes, with a dry run, approved mappings and held values.</li>
        <li>Changes run in batches of 10. Every product is read back and checked; anything else that changed is reported.</li>
        <li>Every run can be put back. A product changed since the run is left alone, never overwritten.</li>
      </ul>
      <p>Install it from the Shopify App Store. Once installed, open it from your Shopify admin under Apps.</p>
    </PublicPage>
  );
}
