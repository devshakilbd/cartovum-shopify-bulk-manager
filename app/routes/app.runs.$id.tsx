import { useCallback, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { api, Confirm, ErrorBanner, StatusBadge, table, tableWrap, td, th, usePoll, when } from "../components/ui";
import { describeRun, type RunSummary } from "../components/runs";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { id: params.id ?? "" };
};

type Result = { id: string; sku: string; name: string; status: string; message: string };
type Data = { operation: RunSummary; total: number; results: Result[] };
const ACTIVE = ["resolving", "queued", "running", "stopping"];

export default function Run() {
  const { id } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [active, setActive] = useState(true);

  const fetchRun = useCallback(async () => {
    const d = await api<Data>("operation", undefined, `?id=${encodeURIComponent(id)}&status=${filter}&offset=${offset}`);
    setActive(ACTIVE.includes(d.operation.status));
    return d;
  }, [id, filter, offset]);
  const { data, error, refresh } = usePoll(fetchRun, active);
  const op = data?.operation;

  const stop = async () => {
    try {
      await api("stop", { id });
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const revert = async () => {
    setBusy(true);
    try {
      const r = await api<{ operation: { id: string } }>("revert", { id });
      setConfirmRevert(false);
      navigate(`/app/runs/${r.operation.id}`);
    } catch (e) {
      setConfirmRevert(false);
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!op) return <s-page heading="Run">{error ? <ErrorBanner error={error} /> : <s-spinner accessibilityLabel="Loading" />}</s-page>;

  const percent = op.total ? Math.round((op.processed / op.total) * 100) : 0;
  const batches = Math.ceil(op.total / 10);
  const revertable = op.type !== "revert" && op.type !== "dryrun" && !op.revertedAt && !ACTIVE.includes(op.status) && op.changed + op.failed > 0;

  return (
    <s-page heading={describeRun(op)}>
      <ErrorBanner error={actionError || error} onDismiss={() => setActionError(null)} />
      <s-section heading={ACTIVE.includes(op.status) ? "Processing…" : op.status === "completed" ? "Operation complete" : `Run ${op.status}`}>
        <div aria-live="polite">
          {op.status === "resolving" ? (
            <p>Finding every matching product… {op.total.toLocaleString()} so far.</p>
          ) : (
            <>
              <progress value={op.processed} max={Math.max(op.total, 1)} style={{ width: "100%", height: 16 }} aria-label="Progress" />
              <p>
                <strong>
                  {op.processed.toLocaleString()} / {op.total.toLocaleString()}
                </strong>{" "}
                ({percent}%) · Batch {Math.min(Math.ceil(op.processed / 10), batches)} / {batches}
              </p>
            </>
          )}
          <p>
            Changed: <strong>{op.changed}</strong> · Skipped: <strong>{op.skipped}</strong> · Failed: <strong>{op.failed}</strong>
          </p>
          {op.message && <s-banner tone={op.status === "failed" || op.failed ? "warning" : "info"}>{op.message}</s-banner>}
          {op.capped && <s-banner tone="warning">More products matched than one run can hold; only the first {op.total} were included.</s-banner>}
        </div>
        <p style={{ fontSize: 13 }}>
          Started {when(op.startedAt ?? op.createdAt)} by {op.userLabel}
          {op.completedAt ? ` · finished ${when(op.completedAt)}` : ""}
          {op.revertOf ? (
            <>
              {" "}
              · puts back <Link to={`/app/runs/${op.revertOf}`}>an earlier run</Link>
            </>
          ) : null}
          {op.revertedBy ? (
            <>
              {" "}
              · <Link to={`/app/runs/${op.revertedBy}`}>put back {when(op.revertedAt)}</Link>
            </>
          ) : null}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ACTIVE.includes(op.status) && !op.cancelRequested && <s-button onClick={stop}>Stop after this batch</s-button>}
          {revertable && (
            <s-button tone="critical" onClick={() => setConfirmRevert(true)}>
              Put back
            </s-button>
          )}
          <Link to="/app/runs">All runs</Link>
        </div>
      </s-section>

      {op.type !== "dryrun" && (
        <s-section heading="Per-product results">
          <div role="group" aria-label="Show" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            {["", "changed", "skipped", "failed"].map((s) => (
              <label key={s}>
                <input
                  type="radio"
                  name="filter"
                  checked={filter === s}
                  onChange={() => {
                    setFilter(s);
                    setOffset(0);
                  }}
                />{" "}
                {s || "All"}
              </label>
            ))}
          </div>
          {!data.results.length ? (
            <s-paragraph>No results {filter ? `marked ${filter}` : "yet"}.</s-paragraph>
          ) : (
            <div style={tableWrap}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Result</th>
                    <th style={th}>Product</th>
                    <th style={th}>SKU</th>
                    <th style={th}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => (
                    <tr key={`${r.id}-${i}`}>
                      <td style={td}>
                        <StatusBadge status={r.status} />
                      </td>
                      <td style={td}>
                        <a href={`shopify:admin/products/${r.id.split("/").pop()}`} target="_top">
                          {r.name || r.id.split("/").pop()}
                        </a>
                      </td>
                      <td style={td}>{r.sku}</td>
                      <td style={td}>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.total > 100 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <s-button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
                Previous
              </s-button>
              <span>
                {offset + 1}–{Math.min(offset + 100, data.total)} of {data.total}
              </span>
              <s-button disabled={offset + 100 >= data.total} onClick={() => setOffset(offset + 100)}>
                Next
              </s-button>
            </div>
          )}
        </s-section>
      )}

      <Confirm open={confirmRevert} title="Put this run back?" confirmLabel="Put back" destructive busy={busy} onConfirm={revert} onCancel={() => setConfirmRevert(false)}>
        <p>Every product this run changed ({op.changed + op.failed}) is restored to how it was before the run.</p>
        <p>A product that has been changed since — by someone else, or by another app — is skipped and reported with its expected and current values. It is never overwritten.</p>
      </Confirm>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
