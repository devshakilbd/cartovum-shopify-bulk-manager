import { useEffect, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { api, control, ErrorBanner, Field, grid } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type Settings = {
  localNamespaces: string[];
  protectMultiVariantProducts: boolean;
  keepJobs: number;
  selectAllCap: number;
  convertWritesEnabled: boolean;
  convertAllowedStatuses: string[];
  convertAllowedIds: string[];
};

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [ids, setIds] = useState("");
  const [namespaces, setNamespaces] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<{ settings: Settings }>("config").then((c) => {
      setS(c.settings);
      setIds(c.settings.convertAllowedIds.map((i) => i.split("/").pop()).join(", "));
      setNamespaces(c.settings.localNamespaces.join(", "));
    }, (e) => setError(e.message));
  }, []);

  const save = async () => {
    if (!s) return;
    setError(null);
    setSaved(false);
    try {
      const r = await api<{ settings: Settings }>("settings", { ...s, convertAllowedIds: ids, localNamespaces: namespaces });
      setS(r.settings);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!s) return <s-page heading="Settings">{error ? <ErrorBanner error={error} /> : <s-spinner accessibilityLabel="Loading" />}</s-page>;
  const toggleStatus = (st: string) => setS({ ...s, convertAllowedStatuses: s.convertAllowedStatuses.includes(st) ? s.convertAllowedStatuses.filter((x) => x !== st) : [...s.convertAllowedStatuses, st] });

  return (
    <s-page heading="Settings">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {saved && <s-banner tone="success">Settings saved.</s-banner>}

      <s-section heading="Attributes">
        <div style={grid}>
          <Field label="Local attribute namespaces" hint="Free-text product metafields in these namespaces are local (typed) attributes. Comma separated. Shared (global) attributes are the product metafield definitions that have a fixed list of values.">
            {(id) => <input id={id} style={control} value={namespaces} onChange={(e) => setNamespaces(e.target.value)} />}
          </Field>
        </div>
        <label style={{ display: "block", marginTop: 12 }}>
          <input type="checkbox" checked={s.protectMultiVariantProducts} onChange={(e) => setS({ ...s, protectMultiVariantProducts: e.target.checked })} /> Leave products with variants alone (as v1.3.9 left variable products alone). Recommended.
        </label>
      </s-section>

      <s-section heading="Runs">
        <div style={grid}>
          <Field label="Runs kept in history" hint="Older runs are removed with their per-product log. A run still in progress is never removed.">
            {(id) => <input id={id} type="number" min={5} max={500} style={control} value={s.keepJobs} onChange={(e) => setS({ ...s, keepJobs: Number(e.target.value) })} />}
          </Field>
          <Field label="Most products in one run" hint="Select all matching stops at this many and says so.">
            {(id) => <input id={id} type="number" min={100} max={100000} style={control} value={s.selectAllCap} onChange={(e) => setS({ ...s, selectAllCap: Number(e.target.value) })} />}
          </Field>
        </div>
      </s-section>

      <s-section heading="Attribute conversion">
        <label style={{ display: "block" }}>
          <input type="checkbox" checked={s.convertWritesEnabled} onChange={(e) => setS({ ...s, convertWritesEnabled: e.target.checked })} /> Allow conversion to write to products. While off, only the dry run works and nothing is written.
        </label>
        <fieldset style={{ marginTop: 12, border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <legend style={{ fontWeight: 600 }}>Staged conversion: product statuses that may be converted</legend>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>None ticked means no status restriction.</p>
          {["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].map((st) => (
            <label key={st} style={{ marginRight: 16 }}>
              <input type="checkbox" checked={s.convertAllowedStatuses.includes(st)} onChange={() => toggleStatus(st)} /> {st.toLowerCase()}
            </label>
          ))}
        </fieldset>
        <div style={{ ...grid, marginTop: 12 }}>
          <Field label="Products also approved individually" hint="Product IDs, comma separated. They may be converted whatever their status.">
            {(id) => <input id={id} style={control} value={ids} onChange={(e) => setIds(e.target.value)} />}
          </Field>
        </div>
      </s-section>

      <s-section>
        <s-button variant="primary" onClick={save}>
          Save settings
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
