import { useCallback, useEffect, useMemo, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { api, Confirm, control, ErrorBanner, Field, grid, table, tableWrap, td, th } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type Global = { key: string; label: string; choices: string[] };
type Decisions = { overrides: Record<string, Record<string, string>>; holds: Record<string, Record<string, string>>; planned: Record<string, string[]>; newValues: Record<string, string[]> };
type Settings = { convertWritesEnabled: boolean; convertAllowedStatuses: string[]; convertAllowedIds: string[] };
type PlanRow = { attribute: string; globalKey: string; current: string; new: string; mapping: string; state: string; action: string; note: string };
type Item = { productId: string; name: string; sku: string; status: string; state: string; note: string; rows: PlanRow[] };
type Op = { id: string; status: string; processed: number; total: number };

/**
 * Attribute conversion (v1.3.9 "Convert typed attributes to shared attributes"):
 * setup (pairs + decisions) -> dry run -> review (planned values, needs attention) -> approve mappings /
 * hold values -> select ready products -> confirm -> batched conversion -> verify -> put back from the run page.
 */
export default function Convert() {
  const navigate = useNavigate();
  const [globals, setGlobals] = useState<Global[]>([]);
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [dry, setDry] = useState<Op | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState({ what: "override", key: "", value: "", target: "", reason: "" });

  const loadItems = useCallback(() => api<{ items: Item[] }>("dryrun").then((d) => setItems(d.items), (e) => setError(e.message)), []);

  useEffect(() => {
    api<{ globals: Global[]; decisions: Decisions; settings: Settings }>("config").then((c) => {
      setGlobals(c.globals);
      setDecisions(c.decisions);
      setSettings(c.settings);
    }, (e) => setError(e.message));
    loadItems();
  }, [loadItems]);

  // Poll the dry run while it scans the catalogue.
  useEffect(() => {
    if (!dry || !["resolving", "queued", "running"].includes(dry.status)) return;
    const t = setInterval(async () => {
      try {
        const d = await api<{ operation: Op }>("operation", undefined, `?id=${dry.id}`);
        setDry(d.operation);
        if (!["resolving", "queued", "running"].includes(d.operation.status)) {
          setSelected(new Set());
          loadItems();
        }
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [dry, loadItems]);

  const startDryRun = async () => {
    setError(null);
    try {
      setDry((await api<{ operation: Op }>("dryrun", {})).operation);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const summary = useMemo(() => {
    const states: Record<string, number> = {};
    const groups = new Map<string, { row: PlanRow; count: number }>();
    for (const p of items ?? []) {
      states[p.state] = (states[p.state] ?? 0) + 1;
      for (const r of p.rows) {
        const k = [r.attribute, r.current, r.new, r.mapping, r.state].join("\u0000");
        groups.set(k, { row: r, count: (groups.get(k)?.count ?? 0) + 1 });
      }
    }
    return { states, groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g) };
  }, [items]);
  const ready = (items ?? []).filter((i) => i.state === "ready");
  const running = !!dry && ["resolving", "queued", "running"].includes(dry.status);

  const saveDecision = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      setDecisions((await api<{ decisions: Decisions }>("decision", body)).decisions);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const downloadCsv = async () => {
    const res = await fetch("/app/api/csv");
    if (!res.ok) return setError("The report could not be downloaded.");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "attribute-conversion-dry-run.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const convert = async () => {
    setBusy(true);
    try {
      const r = await api<{ operation: { id: string } }>("start", { type: "convert", selectionMode: "IDS", ids: [...selected], params: {} });
      navigate(`/app/runs/${r.operation.id}`);
    } catch (e) {
      setConfirm(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const target = globals.find((g) => g.key === decision.key);
  const writes = !!settings?.convertWritesEnabled;

  return (
    <s-page heading="Attribute conversion">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {settings && !writes && (
        <s-banner tone="info" heading="Dry run only.">
          Conversion is switched off for this store. The dry run reads the catalogue and changes nothing. Switch conversion on in Settings when the dry run has been approved.
        </s-banner>
      )}
      {settings && writes && settings.convertAllowedStatuses.length > 0 && (
        <s-banner tone="warning" heading="Staged conversion.">
          Only products with status {settings.convertAllowedStatuses.join(", ").toLowerCase()} can be converted at this stage. Anything else is skipped and left unchanged.
          {settings.convertAllowedIds.length ? ` Also approved individually: products ${settings.convertAllowedIds.map((i) => i.split("/").pop()).join(", ")}.` : ""}
        </s-banner>
      )}

      <s-section heading="Convert typed attributes to shared attributes">
        <s-paragraph>
          Moves a typed (local) value, such as Rim Size 18, onto the shared attribute of the same name, such as Rim Size 18&quot;. A value only moves when it matches one shared value exactly (units and quotation marks set aside), or has an approved mapping. Anything else is reported and the product is left exactly as it is.
        </s-paragraph>
        <s-paragraph>
          Shared attributes are product metafield definitions with a fixed list of values ({globals.length} found). Typed attributes are the free-text product metafields in the local namespaces set in Settings. They pair by name.
        </s-paragraph>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <s-button onClick={startDryRun} loading={running}>
            Run dry run (changes nothing)
          </s-button>
          <s-button disabled={!items?.length} onClick={downloadCsv}>
            Download dry-run report (CSV)
          </s-button>
        </div>
        {running && dry && (
          <p aria-live="polite">
            Reading the catalogue… {dry.processed.toLocaleString()} products scanned, {dry.total.toLocaleString()} with typed attributes.
          </p>
        )}
      </s-section>

      {items && (
        <s-section heading="Dry run review">
          <p>
            {items.length} products have typed attributes: <strong>{summary.states.ready ?? 0}</strong> ready, <strong>{summary.states["needs-approval"] ?? 0}</strong> awaiting approval, <strong>{summary.states.blocked ?? 0}</strong> blocked, <strong>{summary.states.skipped ?? 0}</strong> skipped.
          </p>
          <h3 style={{ fontSize: 14 }}>Planned values (current → planned)</h3>
          <div style={tableWrap}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Attribute</th>
                  <th style={th}>Typed value</th>
                  <th style={th}>Shared value</th>
                  <th style={th}>Mapping</th>
                  <th style={th}>State</th>
                  <th style={th}>Products</th>
                </tr>
              </thead>
              <tbody>
                {summary.groups.map(({ row, count }, i) => (
                  <tr key={i}>
                    <td style={td}>{row.attribute}</td>
                    <td style={td}>{row.current}</td>
                    <td style={td}>{row.new || "—"}</td>
                    <td style={td}>{row.mapping}</td>
                    <td style={td}>{row.state}</td>
                    <td style={td}>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {items.some((i) => i.state !== "ready") && (
            <>
              <h3 style={{ fontSize: 14 }}>Needs attention</h3>
              <ul>
                {items
                  .filter((i) => i.state !== "ready")
                  .map((i) => (
                    <li key={i.productId}>
                      <strong>{i.state}</strong> {i.sku || i.productId.split("/").pop()} — {i.name}: {i.note}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </s-section>
      )}

      <s-section heading="Mappings, held values and planned values">
        <s-paragraph>Decisions apply to the next dry run. Only approved mappings are used; a held value keeps every product carrying it unchanged; a planned value is shown as &quot;to be created&quot; until you add it to the shared attribute&apos;s list of values in Shopify.</s-paragraph>
        {!writes && <s-paragraph>Decisions are locked while the store is dry-run only.</s-paragraph>}
        <div style={grid}>
          <Field label="Decision">
            {(id) => (
              <select id={id} style={control} value={decision.what} onChange={(e) => setDecision({ ...decision, what: e.target.value })}>
                <option value="override">Approve a mapping</option>
                <option value="hold">Hold a value</option>
                <option value="planned">Plan a new shared value</option>
                <option value="new_value">Record a value created for this migration</option>
              </select>
            )}
          </Field>
          <Field label="Shared attribute">
            {(id) => (
              <select id={id} style={control} value={decision.key} onChange={(e) => setDecision({ ...decision, key: e.target.value, target: "" })}>
                <option value="">Choose…</option>
                {globals.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={decision.what === "override" || decision.what === "hold" ? "Typed value" : "Value"}>{(id) => <input id={id} style={control} value={decision.value} onChange={(e) => setDecision({ ...decision, value: e.target.value })} />}</Field>
          {decision.what === "override" && (
            <Field label="Maps to shared value">
              {(id) => (
                <select id={id} style={control} value={decision.target} onChange={(e) => setDecision({ ...decision, target: e.target.value })}>
                  <option value="">Choose…</option>
                  {target?.choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {decision.what === "hold" && <Field label="Reason">{(id) => <input id={id} style={control} value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} />}</Field>}
        </div>
        <div style={{ marginTop: 8 }}>
          <s-button disabled={!writes || !decision.key || !decision.value} onClick={() => saveDecision(decision)}>
            Save decision
          </s-button>
        </div>

        {decisions && (
          <div style={{ ...tableWrap, marginTop: 12 }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Kind</th>
                  <th style={th}>Attribute</th>
                  <th style={th}>Value</th>
                  <th style={th}>Detail</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {Object.entries(decisions.overrides).flatMap(([k, m]) =>
                  Object.entries(m).map(([v, t]) => (
                    <tr key={`o${k}${v}`}>
                      <td style={td}>Approved mapping</td>
                      <td style={td}>{label(globals, k)}</td>
                      <td style={td}>{v}</td>
                      <td style={td}>→ {t}</td>
                      <td style={td}>{writes && <s-button variant="tertiary" onClick={() => saveDecision({ what: "clear_override", key: k, value: v })}>Withdraw</s-button>}</td>
                    </tr>
                  )),
                )}
                {Object.entries(decisions.holds).flatMap(([k, m]) =>
                  Object.entries(m).map(([v, reason]) => (
                    <tr key={`h${k}${v}`}>
                      <td style={td}>Held</td>
                      <td style={td}>{label(globals, k)}</td>
                      <td style={td}>{v}</td>
                      <td style={td}>{reason}</td>
                      <td style={td}>{writes && <s-button variant="tertiary" onClick={() => saveDecision({ what: "hold", key: k, value: v, reason: "" })}>Release</s-button>}</td>
                    </tr>
                  )),
                )}
                {Object.entries(decisions.planned).flatMap(([k, list]) =>
                  list.map((v) => (
                    <tr key={`p${k}${v}`}>
                      <td style={td}>Planned new value</td>
                      <td style={td}>{label(globals, k)}</td>
                      <td style={td}>{v}</td>
                      <td style={td}>{globals.find((g) => g.key === k)?.choices.includes(v) ? "now exists" : "to be created"}</td>
                      <td style={td}>{writes && <s-button variant="tertiary" onClick={() => saveDecision({ what: "planned", key: k, value: v, remove: true })}>Remove</s-button>}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {writes && items && (
        <s-section heading="Convert">
          <s-paragraph>Only products that were ready in the latest dry run can be converted. Each product must still match the dry run exactly; one changed since is skipped. A run stops at the first product that fails its check.</s-paragraph>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <s-button disabled={!ready.length} onClick={() => setSelected(new Set(ready.map((r) => r.productId)))}>
              Select all ready ({ready.length})
            </s-button>
            <s-button onClick={() => setSelected(new Set())}>Clear selection</s-button>
            <span aria-live="polite">{selected.size} selected</span>
          </div>
          <div style={{ ...tableWrap, maxHeight: 400, overflowY: "auto" }}>
            <table style={table}>
              <tbody>
                {ready.map((i) => (
                  <tr key={i.productId}>
                    <td style={td}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${i.name}`}
                        checked={selected.has(i.productId)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(i.productId)) n.delete(i.productId);
                            else n.add(i.productId);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td style={td}>
                      {i.sku} — {i.name} <span style={{ fontSize: 12 }}>({i.status.toLowerCase()})</span>
                    </td>
                    <td style={td}>{i.rows.map((r) => (r.action === "drop-duplicate" ? `${r.attribute}: remove typed copy` : `${r.attribute}: ${r.current} → ${r.new}`)).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8 }}>
            <s-button variant="primary" disabled={!selected.size} onClick={() => setConfirm(true)}>
              Convert selected products
            </s-button>
          </div>
        </s-section>
      )}

      <Confirm open={confirm} title="Convert typed attributes?" confirmLabel="Convert" destructive busy={busy} onConfirm={convert} onCancel={() => setConfirm(false)}>
        <p>
          <strong>
            Convert typed attributes on {selected.size} product{selected.size === 1 ? "" : "s"}.
          </strong>
        </p>
        <p>Each product converts in one write. Afterwards it is read back: the shared attributes must hold exactly the planned values, other attributes must be untouched, and nothing else about the product may have changed. The run can be put back.</p>
      </Confirm>
    </s-page>
  );
}

const label = (globals: Global[], key: string) => globals.find((g) => g.key === key)?.label ?? key;

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
