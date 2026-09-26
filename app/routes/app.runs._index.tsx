import { useCallback } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { api, ErrorBanner, usePoll } from "../components/ui";
import { RunsTable, type RunSummary } from "../components/runs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Runs() {
  const fetchRuns = useCallback(() => api<{ operations: RunSummary[] }>("operations", undefined, "?limit=100"), []);
  const { data, error, refresh } = usePoll(fetchRuns, true, 5000);
  return (
    <s-page heading="Run history">
      <s-button slot="secondary-actions" onClick={refresh}>
        Refresh
      </s-button>
      <ErrorBanner error={error} />
      <s-section>
        <s-paragraph>Every run records each product&apos;s state before and after the change. Open a run to see its results, or to put it back. The number of runs kept is set in Settings.</s-paragraph>
        {data ? <RunsTable runs={data.operations} /> : <s-spinner accessibilityLabel="Loading" />}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
