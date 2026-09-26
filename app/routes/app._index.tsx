import { useCallback } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { api, ErrorBanner, usePoll } from "../components/ui";
import { RunsTable, type RunSummary } from "../components/runs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const APP_VERSION = "1.0.0";
const API_VERSION = "2026-07";

const FEATURES = [
  "Find products by name, a list of SKUs, collection, stock status and product status",
  "Filter by several attribute conditions at once; a product must match them all",
  "Select products page by page, or every matching product in one click",
  "Bulk stock status: in stock, out of stock or on backorder (continue selling)",
  "Bulk attribute edits: add, remove or replace values, remove an attribute, or set a typed value",
  "Convert typed attributes to shared attributes, with a dry run and a CSV report",
  "Batches of 10 with live progress and a result for every product",
  "Every product checked after its change; anything else that moved is reported",
  "A log of recent runs, any of which can be put back without overwriting later edits",
];

export default function Dashboard() {
  const fetchRuns = useCallback(() => api<{ operations: RunSummary[] }>("operations", undefined, "?limit=10"), []);
  const { data, error } = usePoll(fetchRuns, true, 5000);
  const active = data?.operations.filter((o) => ["resolving", "queued", "running", "stopping"].includes(o.status)) ?? [];

  return (
    <s-page heading="Cartovum Bulk Product Manager">
      <ErrorBanner error={error} />
      <s-section>
        <s-paragraph>Find products, select them, then set their stock status or edit one attribute across all of them. Changes run in small batches and every run can be put back.</s-paragraph>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <s-button variant="primary" href="/app/products">
            Find products
          </s-button>
          <s-button href="/app/convert">Attribute conversion</s-button>
          <s-button href="/app/runs">Run history</s-button>
        </div>
      </s-section>

      {active.length > 0 && (
        <s-section heading="In progress">
          {active.map((o) => (
            <p key={o.id}>
              <Link to={`/app/runs/${o.id}`}>{o.status}</Link>: {o.processed} / {o.total}
            </p>
          ))}
        </s-section>
      )}

      <s-section heading="Recent runs">{data ? <RunsTable runs={data.operations} /> : <s-spinner accessibilityLabel="Loading" />}</s-section>

      <s-section heading="What this app does">
        <s-unordered-list>
          {FEATURES.map((f) => (
            <s-list-item key={f}>{f}</s-list-item>
          ))}
        </s-unordered-list>
        <s-heading>What it will not do</s-heading>
        <s-unordered-list>
          <s-list-item>It never creates a shared attribute or a shared value. Only values already in the list can be chosen.</s-list-item>
          <s-list-item>It never turns a local attribute into a shared one, or the other way round, outside the conversion screen.</s-list-item>
          <s-list-item>It leaves products with variants alone, and never touches product options, which define variants.</s-list-item>
          <s-list-item>It never writes inventory quantities, and skips quantity-managed inventory.</s-list-item>
          <s-list-item>It never deletes a product, a variant, a collection, or an attribute definition.</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Version {APP_VERSION} · Shopify Admin API {API_VERSION} · Developed by Cartovum Agency.{" "}
          <s-link href="https://cartovumagency.com/contact/" target="_blank">
            Contact support
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
