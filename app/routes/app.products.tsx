import { useCallback, useEffect, useMemo, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { api, Confirm, control, ErrorBanner, Field, grid, OP_LABELS, StatusBadge, STOCK_LABELS, table, tableWrap, td, th } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type Global = { key: string; label: string; type: string; choices: string[] };
type Config = { globals: Global[]; collections: { id: string; title: string }[]; localValues: Record<string, { value: string; count: number }[]>; maxConditions: number };
type Row = {
  id: string;
  name: string;
  sku: string;
  status: string;
  stockStatus: string;
  tracked: boolean;
  inventory: number;
  variants: number;
  multiVariant: boolean;
  imageUrl: string | null;
  collectionIds: string[];
  options: { name: string; values: string[] }[];
  attributes: { key: string; kind: string; values: string[] }[];
};
type Condition = { attribute: string; value: string };
type Filters = { search: string; skus: string; collectionId: string; stockStatus: string; status: string; conditions: Condition[]; perPage: number };
type Preview = { rows: { id: string; name: string; sku: string; status: string; message: string }[] };

const EMPTY: Filters = { search: "", skus: "", collectionId: "", stockStatus: "", status: "", conditions: [{ attribute: "", value: "" }], perPage: 50 };
const SELECTION_KEY = "cartovum-selection";

/** Selected products survive page changes and reloads within the tab. */
function loadSelection(): Map<string, string> {
  try {
    return new Map(JSON.parse(sessionStorage.getItem(SELECTION_KEY) ?? "[]"));
  } catch {
    return new Map();
  }
}

export default function Products() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [allMatching, setAllMatching] = useState<Filters | null>(null);

  // Bulk action state
  const [action, setAction] = useState<"stock" | "attributes">("stock");
  const [stockTarget, setStockTarget] = useState("instock");
  const [op, setOp] = useState("add_terms");
  const [opAttribute, setOpAttribute] = useState("");
  const [opTerms, setOpTerms] = useState<string[]>([]);
  const [opValue, setOpValue] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Session storage only exists in the browser, so the saved selection is restored after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(loadSelection());
    api<Config>("config").then(setConfig, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(SELECTION_KEY, JSON.stringify([...selected]));
    } catch {
      /* storage unavailable: selection still works for this page view */
    }
  }, [selected]);

  const attributeOptions = useMemo(() => {
    if (!config) return [];
    const locals = Object.keys(config.localValues).sort();
    return [...config.globals.map((g) => ({ key: g.key, label: `${g.label} (global)` })), ...locals.map((k) => ({ key: k, label: `${k.split(".")[1]} (local)` }))];
  }, [config]);
  const optionNames = useMemo(() => [...new Set(rows.flatMap((r) => r.options.map((o) => o.name)))], [rows]);

  const valuesFor = (key: string) => {
    if (!config || !key) return [];
    const g = config.globals.find((x) => x.key === key);
    if (g) return g.choices.map((c) => ({ value: c, label: c }));
    return (config.localValues[key] ?? []).map((v) => ({ value: v.value, label: `${v.value} (${v.count})` }));
  };

  /** A fresh search reads the form; paging reuses the filters of the last search. */
  const find = useCallback(
    async (filters: Filters, cursor: string | null, stack: (string | null)[]) => {
      setLoading(true);
      setError(null);
      try {
        const payload = { ...filters, conditions: filters.conditions.filter((c) => c.attribute) };
        const data = await api<{ items: Row[]; next: string | null; total: number | null }>("search", { filters: payload, cursor });
        setRows(data.items);
        setNext(data.next);
        setTotal(data.total);
        setCursors(stack);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const search = () => {
    setApplied(form);
    find(form, null, [null]);
  };
  const page = cursors.length;

  const toggle = (row: Row) => {
    setAllMatching(null);
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(row.id)) n.delete(row.id);
      else n.set(row.id, row.name);
      return n;
    });
  };
  const selectPage = () => {
    setAllMatching(null);
    setSelected((s) => new Map([...s, ...rows.map((r) => [r.id, r.name] as [string, string])]));
  };
  const clearSelection = () => {
    setSelected(new Map());
    setAllMatching(null);
  };

  const count = allMatching ? null : selected.size;
  const selectionSummary = allMatching ? `All ${total !== null && JSON.stringify(allMatching) === JSON.stringify(applied) ? total.toLocaleString() + " " : ""}matching products selected` : `${selected.size} selected`;

  const params = () => (action === "stock" ? { stockStatus: stockTarget } : { op, attribute: opAttribute, terms: opTerms, value: opValue });
  const selectionBody = () =>
    allMatching
      ? { selectionMode: "ALL_MATCHING", filters: { ...allMatching, conditions: allMatching.conditions.filter((c) => c.attribute) } }
      : { selectionMode: "IDS", ids: [...selected.keys()] };

  const openPreview = async () => {
    setError(null);
    if (!allMatching && !selected.size) return setError("Select some products first.");
    if (action === "attributes" && !opAttribute) return setError("Choose an attribute first.");
    setBusy(true);
    try {
      const sel = selectionBody();
      const data = await api<Preview>("preview", { type: action, stockStatus: stockTarget, params: params(), ...("ids" in sel ? { ids: sel.ids } : { filters: sel.filters }) });
      setPreview(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const data = await api<{ operation: { id: string } }>("start", { type: action, params: params(), ...selectionBody() });
      setPreview(null);
      navigate(`/app/runs/${data.operation.id}`);
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attrLabel = attributeOptions.find((a) => a.key === opAttribute)?.label ?? opAttribute;
  const sentence =
    action === "stock"
      ? `Set stock status to ${STOCK_LABELS[stockTarget]}`
      : op === "set_local_value"
        ? `Set "${attrLabel}" to ${opValue}`
        : op === "remove_attribute"
          ? `Remove the attribute "${attrLabel}"`
          : `${OP_LABELS[op]} "${attrLabel}": ${opTerms.join(", ") || "(none)"}`;
  const isGlobal = !!config?.globals.some((g) => g.key === opAttribute);
  const opsForAttribute = isGlobal ? ["add_terms", "remove_terms", "set_terms", "remove_attribute"] : ["set_local_value", "remove_attribute"];

  const setCondition = (i: number, patch: Partial<Condition>) => setForm((f) => ({ ...f, conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  return (
    <s-page heading="Products">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <s-section heading="Find products">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div style={grid}>
            <Field label="Search name">{(id) => <input id={id} type="search" style={control} value={form.search} onChange={(e) => setForm({ ...form, search: e.target.value })} placeholder="Product name" />}</Field>
            <Field label="Collection">
              {(id) => (
                <select id={id} style={control} value={form.collectionId} onChange={(e) => setForm({ ...form, collectionId: e.target.value })}>
                  <option value="">Any collection</option>
                  {config?.collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Stock status">
              {(id) => (
                <select id={id} style={control} value={form.stockStatus} onChange={(e) => setForm({ ...form, stockStatus: e.target.value })}>
                  <option value="">Any</option>
                  <option value="instock">In stock</option>
                  <option value="outofstock">Out of stock</option>
                  <option value="onbackorder">On backorder (continue selling)</option>
                </select>
              )}
            </Field>
            <Field label="Product status">
              {(id) => (
                <select id={id} style={control} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="">Any</option>
                  <option value="ACTIVE">Active</option>
                  <option value="DRAFT">Draft</option>
                  <option value="ARCHIVED">Archived</option>
                  <option value="UNLISTED">Unlisted</option>
                </select>
              )}
            </Field>
            <Field label="Per page">
              {(id) => (
                <select id={id} style={control} value={form.perPage} onChange={(e) => setForm({ ...form, perPage: Number(e.target.value) })}>
                  {[25, 50, 100, 200].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <Field label="SKUs (one per line, or comma separated)" hint="Matches any variant's SKU exactly. Up to 500.">
              {(id) => <textarea id={id} rows={2} style={{ ...control, width: "100%" }} value={form.skus} onChange={(e) => setForm({ ...form, skus: e.target.value })} />}
            </Field>
          </div>

          <fieldset style={{ marginTop: 12, border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <legend style={{ fontWeight: 600 }}>Attribute conditions</legend>
            <p style={{ margin: "0 0 8px", fontSize: 13 }}>Products must match every condition.</p>
            {form.conditions.map((c, i) => (
              <div key={i} role="group" aria-label={`Condition ${i + 1}`} style={{ ...grid, alignItems: "end", marginBottom: 8 }}>
                <Field label={i ? "AND attribute" : "Attribute"}>
                  {(id) => (
                    <select id={id} style={control} value={c.attribute} onChange={(e) => setCondition(i, { attribute: e.target.value, value: "" })}>
                      <option value="">Any attribute</option>
                      {attributeOptions.map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.label}
                        </option>
                      ))}
                      {optionNames.map((n) => (
                        <option key={n} value={`option:${n}`}>
                          {n} (product option)
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Value">
                  {(id) =>
                    c.attribute.startsWith("option:") ? (
                      <input id={id} style={control} value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} placeholder="Any value" />
                    ) : (
                      <select id={id} style={control} value={c.value} disabled={!c.attribute} onChange={(e) => setCondition(i, { value: e.target.value })}>
                        <option value="">Any value</option>
                        {valuesFor(c.attribute).map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
                {i > 0 && (
                  <div>
                    <s-button tone="critical" variant="tertiary" onClick={() => setForm({ ...form, conditions: form.conditions.filter((_, j) => j !== i) })}>
                      Remove
                    </s-button>
                  </div>
                )}
              </div>
            ))}
            <s-button disabled={form.conditions.length >= (config?.maxConditions ?? 10)} onClick={() => setForm({ ...form, conditions: [...form.conditions, { attribute: "", value: "" }] })}>
              + Add condition
            </s-button>
            {form.conditions.length >= (config?.maxConditions ?? 10) && <span style={{ marginLeft: 8, fontSize: 12 }}>Up to {config?.maxConditions ?? 10} conditions.</span>}
          </fieldset>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <s-button variant="primary" loading={loading} onClick={search}>
              Find products
            </s-button>
            <s-button onClick={() => setForm(EMPTY)}>Clear filters</s-button>
          </div>
        </form>
      </s-section>

      <s-section heading="Results">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <s-button disabled={!rows.length} onClick={selectPage}>
            Select all on this page
          </s-button>
          <s-button disabled={!applied} onClick={() => setAllMatching(applied)}>
            Select all matching
          </s-button>
          <s-button onClick={clearSelection}>Clear selection</s-button>
          <span aria-live="polite" style={{ marginLeft: "auto" }}>
            <strong>{selectionSummary}</strong>
            {applied && <span> · {total !== null ? `${total.toLocaleString()} found` : "matches are confirmed page by page"}</span>}
          </span>
        </div>
        {allMatching && JSON.stringify(allMatching) !== JSON.stringify(applied) && (
          <s-banner tone="info">The selection is every product matching the filters in force when you chose Select all matching, not the filters shown now.</s-banner>
        )}

        {!applied ? (
          <s-paragraph>No search yet.</s-paragraph>
        ) : loading ? (
          <s-spinner accessibilityLabel="Searching" />
        ) : !rows.length ? (
          <s-paragraph>No products matched.</s-paragraph>
        ) : (
          <div style={tableWrap}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>
                    <span className="visually-hidden" style={{ position: "absolute", left: -9999 }}>
                      Select
                    </span>
                  </th>
                  <th style={th}>Product</th>
                  <th style={th}>SKU</th>
                  <th style={th}>Status</th>
                  <th style={th}>Stock</th>
                  <th style={th}>Inventory</th>
                  <th style={th}>Collections</th>
                  <th style={th}>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={!!allMatching || selected.has(r.id)} disabled={!!allMatching} onChange={() => toggle(r)} />
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {r.imageUrl ? <img src={r.imageUrl} alt="" width={32} height={32} style={{ objectFit: "cover", borderRadius: 4 }} /> : null}
                        <a href={`shopify:admin/products/${r.id.split("/").pop()}`} target="_top">
                          {r.name}
                        </a>
                      </div>
                      {r.multiVariant && <div style={{ fontSize: 12, color: "#616161" }}>{r.variants} variants</div>}
                    </td>
                    <td style={td}>{r.sku}</td>
                    <td style={td}>{r.status.toLowerCase()}</td>
                    <td style={td}>{STOCK_LABELS[r.stockStatus]}</td>
                    <td style={td}>{r.tracked ? r.inventory : "not tracked"}</td>
                    <td style={td}>
                      {r.collectionIds
                        .slice(0, 2)
                        .map((id) => config?.collections.find((c) => c.id === id)?.title ?? "")
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                    <td style={td}>
                      {r.options.map((o) => (
                        <div key={o.name}>
                          <em>{o.name}</em> (option): {o.values.join(", ")}
                        </div>
                      ))}
                      {r.attributes.map((a) => (
                        <div key={a.key}>
                          {a.key.split(".")[1]} ({a.kind}): {a.values.join(", ") || "—"}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {applied && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <s-button disabled={page <= 1 || loading} onClick={() => find(applied, cursors[cursors.length - 2], cursors.slice(0, -1))}>
              Previous
            </s-button>
            <span>Page {page}</span>
            <s-button disabled={!next || loading} onClick={() => find(applied, next, [...cursors, next])}>
              Next
            </s-button>
          </div>
        )}
      </s-section>

      <s-section heading="Bulk action">
        <div role="radiogroup" aria-label="Bulk action" style={{ display: "flex", gap: 16, marginBottom: 12 }}>
          <label>
            <input type="radio" name="action" checked={action === "stock"} onChange={() => setAction("stock")} /> Stock status
          </label>
          <label>
            <input type="radio" name="action" checked={action === "attributes"} onChange={() => setAction("attributes")} /> Attributes
          </label>
          <a href="/app/convert">Attribute conversion →</a>
        </div>

        {action === "stock" ? (
          <div style={grid}>
            <Field label="Set the selected products to" hint="Only the stock state changes. Quantities are never written. Products with variants and quantity-managed inventory are skipped and reported.">
              {(id) => (
                <select id={id} style={control} value={stockTarget} onChange={(e) => setStockTarget(e.target.value)}>
                  {Object.entries(STOCK_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        ) : (
          <div style={grid}>
            <Field label="Attribute">
              {(id) => (
                <select
                  id={id}
                  style={control}
                  value={opAttribute}
                  onChange={(e) => {
                    const key = e.target.value;
                    setOpAttribute(key);
                    setOpTerms([]);
                    setOp(config?.globals.some((g) => g.key === key) ? "add_terms" : "set_local_value");
                  }}
                >
                  <option value="">Choose…</option>
                  {attributeOptions.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Operation">
              {(id) => (
                <select id={id} style={control} value={op} onChange={(e) => setOp(e.target.value)} disabled={!opAttribute}>
                  {opsForAttribute.map((o) => (
                    <option key={o} value={o}>
                      {o === "set_local_value" ? "Set the value of a local attribute" : `${OP_LABELS[o]}${o === "remove_attribute" ? "" : " an attribute"}`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {["add_terms", "remove_terms", "set_terms"].includes(op) && isGlobal && (
              <Field label="Values" hint="Existing values only. This app never creates a new attribute or a new value.">
                {(id) => (
                  <select id={id} multiple size={6} style={control} value={opTerms} onChange={(e) => setOpTerms([...e.target.selectedOptions].map((o) => o.value))}>
                    {valuesFor(opAttribute).map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            {op === "set_local_value" && (
              <Field label="Value" hint="e.g. 112, or 112|114.3 for two values">
                {(id) => <input id={id} style={control} value={opValue} onChange={(e) => setOpValue(e.target.value)} />}
              </Field>
            )}
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <s-button variant="primary" loading={busy} disabled={!allMatching && !selected.size} onClick={openPreview}>
            Review change{count !== null ? ` for ${count} product${count === 1 ? "" : "s"}` : ""}
          </s-button>
        </div>
      </s-section>

      <Confirm open={!!preview} title="Review before changing products" confirmLabel="Apply change" destructive busy={busy} onConfirm={run} onCancel={() => setPreview(null)}>
        <p>
          <strong>You are about to modify {allMatching ? (total !== null ? `all ${total.toLocaleString()} matching products` : "every matching product") : `${selected.size} product${selected.size === 1 ? "" : "s"}`}.</strong>
        </p>
        <p>
          Operation: <strong>{sentence}</strong>
        </p>
        {allMatching && <p>Filters: {describeFilters(allMatching, config)}</p>}
        <p>Changes run in batches of 10. Every product is checked afterwards, and the run can be put back.</p>
        {preview && (
          <>
            <p>
              Preview of the first {preview.rows.length}: {preview.rows.filter((r) => r.status === "changed").length} would change, {preview.rows.filter((r) => r.status === "skipped").length} would be skipped, {preview.rows.filter((r) => r.status === "failed").length} have problems.
            </p>
            <div style={tableWrap}>
              <table style={table}>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={td}>
                        <StatusBadge status={r.status === "changed" ? "changed" : r.status} />
                      </td>
                      <td style={td}>
                        {r.sku || r.id.split("/").pop()} — {r.name}
                        <div style={{ fontSize: 12 }}>{r.message}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Confirm>
    </s-page>
  );
}

function describeFilters(f: Filters, config: Config | null) {
  const parts: string[] = [];
  if (f.search) parts.push(`name contains "${f.search}"`);
  if (f.skus.trim()) parts.push(`SKUs: ${f.skus.split(/[\n,]+/).filter(Boolean).length}`);
  if (f.collectionId) parts.push(`collection: ${config?.collections.find((c) => c.id === f.collectionId)?.title ?? f.collectionId}`);
  if (f.stockStatus) parts.push(`stock: ${STOCK_LABELS[f.stockStatus]}`);
  if (f.status) parts.push(`status: ${f.status.toLowerCase()}`);
  for (const c of f.conditions.filter((x) => x.attribute)) parts.push(`${c.attribute.replace(/^option:/, "")}${c.value ? ` = ${c.value}` : " is set"}`);
  return parts.join("; ") || "none (every product)";
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
