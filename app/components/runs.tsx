import { Link } from "react-router";
import { OP_LABELS, STOCK_LABELS, table, tableWrap, td, th, when } from "./ui";

export type RunSummary = {
  id: string;
  type: string;
  status: string;
  params: Record<string, unknown>;
  selectionMode: string;
  userLabel: string;
  total: number;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
  message: string;
  capped: boolean;
  revertOf: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export function describeRun(r: RunSummary): string {
  const p = r.params as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (r.type) {
    case "stock":
      return `Set stock status to ${STOCK_LABELS[p.stockStatus] ?? p.stockStatus}`;
    case "attributes": {
      const op = p.op ?? {};
      if (op.op === "set_local_value") return `Set ${op.label} to ${op.value}`;
      if (op.op === "remove_attribute") return `Remove the attribute ${op.label}`;
      return `${OP_LABELS[op.op] ?? op.op} ${op.label}: ${(op.terms ?? []).join(", ") || "(none)"}`;
    }
    case "convert":
      return "Convert typed attributes to shared attributes";
    case "revert":
      return `Put back a ${p.kind} run`;
    case "dryrun":
      return "Conversion dry run (changes nothing)";
  }
  return r.type;
}

export function RunsTable({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) return <s-paragraph>Nothing has been run yet.</s-paragraph>;
  return (
    <div style={tableWrap}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>When</th>
            <th style={th}>What</th>
            <th style={th}>Selection</th>
            <th style={th}>Result</th>
            <th style={th}>By</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td style={td}>{when(r.createdAt)}</td>
              <td style={td}>
                <Link to={`/app/runs/${r.id}`}>{describeRun(r)}</Link>
              </td>
              <td style={td}>{r.type === "dryrun" ? "whole catalogue" : r.selectionMode === "ALL_MATCHING" ? "all matching" : `${r.total} selected`}</td>
              <td style={td}>{r.type === "dryrun" ? `${r.total} with typed attributes` : `${r.changed} changed, ${r.skipped} skipped, ${r.failed} failed`}</td>
              <td style={td}>{r.userLabel}</td>
              <td style={td}>{r.revertedAt ? "put back" : r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
