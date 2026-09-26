import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Small shared pieces for the screens. Form controls are native elements with real labels (keyboard and
 * screen-reader friendly, no reliance on custom-element events); layout and actions use Polaris web components.
 */

export class ApiError extends Error {}

/** Calls the app's own API. App Bridge adds the session token to same-origin fetches. */
export async function api<T = Record<string, unknown>>(name: string, body?: unknown, query = ""): Promise<T> {
  const res = await fetch(`/app/api/${name}${query}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "The server sent an unreadable reply." }));
  if (!res.ok || data.error) throw new ApiError(data.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
export const control: CSSProperties = {
  font: "inherit",
  padding: "6px 8px",
  border: "1px solid #8a8a8a",
  borderRadius: 8,
  background: "#fff",
  maxWidth: "100%",
  boxSizing: "border-box",
};
export const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };
export const tableWrap: CSSProperties = { overflowX: "auto", maxWidth: "100%" };
export const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
export const th: CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee", verticalAlign: "top" };

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div style={field}>
      <label htmlFor={id} style={{ fontWeight: 600, fontSize: 13 }}>
        {label}
      </label>
      {children(id)}
      {hint && <span style={{ fontSize: 12, color: "#616161" }}>{hint}</span>}
    </div>
  );
}

const TONES = { changed: "success", skipped: "warning", failed: "critical" } as const;
export function StatusBadge({ status }: { status: string }) {
  return <s-badge tone={(TONES as Record<string, "success" | "warning" | "critical">)[status] ?? "neutral"}>{status}</s-badge>;
}

export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert">
      <s-banner tone="critical" heading="That did not work" dismissible={!!onDismiss} onDismiss={onDismiss}>
        {error}
      </s-banner>
    </div>
  );
}

/** An accessible confirmation dialog: focus moves in, Escape cancels, focus returns on close. */
export function Confirm({ open, title, children, confirmLabel, destructive, busy, onConfirm, onCancel }: { open: boolean; title: string; children: ReactNode; confirmLabel: string; destructive?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      style={{ maxWidth: 720, width: "calc(100% - 32px)", border: "none", borderRadius: 12, padding: 0, boxShadow: "0 8px 32px rgba(0,0,0,.25)" }}
    >
      <div style={{ padding: 16, borderBottom: "1px solid #eee" }}>
        <h2 id="confirm-title" style={{ margin: 0, fontSize: 16 }}>
          {title}
        </h2>
      </div>
      <div style={{ padding: 16, maxHeight: "60vh", overflowY: "auto" }}>{children}</div>
      <div style={{ padding: 16, borderTop: "1px solid #eee", display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <s-button onClick={onCancel}>Cancel</s-button>
        <s-button variant="primary" tone={destructive ? "critical" : "auto"} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </s-button>
      </div>
    </dialog>
  );
}

/** Polls a loader-free endpoint while `active` is true. */
export function usePoll<T>(fn: () => Promise<T>, active: boolean, ms = 1500) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => fn().then(setData, (e: Error) => setError(e.message)), [fn]);
  useEffect(() => {
    run();
    if (!active) return;
    const t = setInterval(run, ms);
    return () => clearInterval(t);
  }, [run, active, ms]);
  return { data, error, refresh: run };
}

export const when = (d: string | Date | null) => (d ? new Date(d).toLocaleString() : "—");

export const OP_LABELS: Record<string, string> = {
  add_terms: "Add values to",
  remove_terms: "Remove values from",
  set_terms: "Replace the values of",
  remove_attribute: "Remove the attribute",
  set_local_value: "Set the value of",
};
export const STOCK_LABELS: Record<string, string> = { instock: "In stock", outofstock: "Out of stock", onbackorder: "On backorder (continue selling)" };
