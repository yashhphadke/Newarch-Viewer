"use client";

import type { Callout } from "../lib/callouts";
import { KIND_COLOURS } from "./callout_layer";

type Props = {
  callout: Callout;
  /** Every callout on the current page, to list the other ones with the same code. */
  pageCallouts: Callout[];
  pageNumber: number;
  onSelect: (callout: Callout) => void;
  onZoom: (callout: Callout) => void;
  onClose: () => void;
};

export const SIDEBAR_WIDTH = 360;

const KIND_LABELS: Record<Callout["kind"], string> = { plant: "Planting", light: "Lighting", area: "Area" };

/** Details of the clicked callout, and the other callouts with the same code on this sheet. */
export default function CalloutSidebar({ callout, pageCallouts, pageNumber, onSelect, onZoom, onClose }: Props) {
  const same = pageCallouts
    .filter((c) => c.code === callout.code)
    // Beds in number order; other tags top-to-bottom, left-to-right across the sheet.
    .sort((a, b) =>
      a.bed && b.bed
        ? Number(a.bed) - Number(b.bed)
        : Math.round(a.bbox[1] / 50) - Math.round(b.bbox[1] / 50) || a.bbox[0] - b.bbox[0],
    );
  const index = same.findIndex((c) => c.id === callout.id);
  // The same area code written with different names on this sheet (likely a drafting slip).
  const areaNames = callout.kind === "area" ? [...new Set(same.map((c) => c.name ?? "(no name)"))] : [];
  const colour = KIND_COLOURS[callout.kind];
  const step = (d: number) => {
    const next = same[(index + d + same.length) % same.length];
    onSelect(next);
    onZoom(next);
  };

  return (
    <aside style={panel} aria-label="Callout details">
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...chip, background: colour }}>{KIND_LABELS[callout.kind]}</span>
        <span style={{ color: "#64748b" }}>Sheet page {pageNumber}</span>
        <button onClick={onClose} style={closeBtn} aria-label="Close">
          ×
        </button>
      </header>

      {callout.kind === "plant" ? (
        <>
          <h2 style={title}>{callout.name}</h2>
          <dl style={facts}>
            <dt>Species code</dt>
            <dd style={mono}>{callout.code}</dd>
            <dt>Bed</dt>
            <dd style={mono}>{callout.bed}</dd>
            <dt>Quantity</dt>
            <dd>{callout.quantity !== undefined ? `${callout.quantity.toLocaleString()} plants` : "—"}</dd>
            <dt>Spacing</dt>
            <dd>{callout.spacingMm !== undefined ? `${callout.spacingMm} mm` : "—"}</dd>
          </dl>
        </>
      ) : callout.kind === "area" ? (
        <>
          <h2 style={title}>{callout.name ?? callout.code}</h2>
          <dl style={facts}>
            <dt>Area code</dt>
            <dd style={mono}>{callout.code}</dd>
            <dt>Labels on sheet</dt>
            <dd>{same.length}</dd>
          </dl>
          {areaNames.length > 1 && (
            <p style={warning}>
              {callout.code} is labelled with {areaNames.length} different names on this sheet:{" "}
              {areaNames.join(", ")}. Worth checking with the drawing&apos;s author.
            </p>
          )}
        </>
      ) : (
        <>
          <h2 style={{ ...title, ...mono }}>{callout.code}</h2>
          <dl style={facts}>
            <dt>Fixture code</dt>
            <dd style={mono}>{callout.code}</dd>
          </dl>
        </>
      )}

      <p style={raw}>
        On the sheet: <span style={mono}>{callout.text}</span>
      </p>

      <div style={actions}>
        <button style={button} onClick={() => onZoom(callout)}>
          Zoom to this
        </button>
      </div>

      {/* Other callouts with the same code on this sheet */}
      <section>
        <h3 style={subhead}>
          {callout.kind === "plant"
            ? `All beds of ${callout.code}`
            : callout.kind === "area"
              ? `All ${callout.code} labels on this sheet`
              : `All ${callout.code} on this sheet`}{" "}
          · {same.length}
        </h3>
        {callout.kind === "plant" ? (
          <ul style={list}>
            {same.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => {
                    onSelect(c);
                    onZoom(c);
                  }}
                  style={{ ...row, background: c.id === callout.id ? "#f1f5f9" : "transparent" }}
                >
                  <span style={mono}>Bed {c.bed}</span>
                  <span style={{ color: "#475569" }}>
                    {c.quantity !== undefined ? `${c.quantity.toLocaleString()} plants` : ""}
                    {c.spacingMm !== undefined ? ` @ ${c.spacingMm} mm` : ""}
                  </span>
                </button>
              </li>
            ))}
            <li style={total}>
              Total on this sheet:{" "}
              {same.reduce((n, c) => n + (c.quantity ?? 0), 0).toLocaleString()} plants
            </li>
          </ul>
        ) : callout.kind === "area" ? (
          <ul style={list}>
            {same.map((c, i) => (
              <li key={c.id}>
                <button
                  onClick={() => {
                    onSelect(c);
                    onZoom(c);
                  }}
                  style={{ ...row, background: c.id === callout.id ? "#f1f5f9" : "transparent" }}
                >
                  <span style={mono}>Label {i + 1}</span>
                  <span style={{ color: c.name === callout.name ? "#475569" : "#b45309" }}>{c.name ?? "(no name)"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div style={stepper}>
            <button style={button} onClick={() => step(-1)} disabled={same.length < 2} aria-label="Previous">
              ‹
            </button>
            <span>
              {index + 1} of {same.length}
            </span>
            <button style={button} onClick={() => step(1)} disabled={same.length < 2} aria-label="Next">
              ›
            </button>
          </div>
        )}
      </section>
    </aside>
  );
}

const panel: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  width: SIDEBAR_WIDTH,
  boxSizing: "border-box",
  padding: 16,
  overflowY: "auto",
  background: "#fff",
  borderLeft: "1px solid #e2e8f0",
  boxShadow: "-4px 0 16px rgba(0,0,0,.08)",
  font: "14px/1.45 system-ui, sans-serif",
  color: "#0f172a",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  zIndex: 2,
};
const chip: React.CSSProperties = { color: "#fff", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 600 };
const closeBtn: React.CSSProperties = {
  marginLeft: "auto",
  border: 0,
  background: "none",
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
  color: "#64748b",
};
const title: React.CSSProperties = { margin: 0, fontSize: 19, lineHeight: 1.25 };
const facts: React.CSSProperties = { display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0 };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const raw: React.CSSProperties = { margin: 0, fontSize: 12, color: "#64748b" };
const actions: React.CSSProperties = { display: "flex", gap: 8 };
const button: React.CSSProperties = {
  padding: "7px 12px",
  minWidth: 36,
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#fff",
  font: "inherit",
  cursor: "pointer",
};
const subhead: React.CSSProperties = { margin: "4px 0 6px", fontSize: 13, color: "#475569", fontWeight: 600 };
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const row: React.CSSProperties = {
  width: "100%",
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  padding: "7px 8px",
  border: 0,
  borderRadius: 6,
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
};
const total: React.CSSProperties = { padding: "8px 8px 0", borderTop: "1px solid #e2e8f0", marginTop: 4, color: "#475569" };
const stepper: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const warning: React.CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  borderRadius: 8,
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  color: "#92400e",
  fontSize: 13,
};