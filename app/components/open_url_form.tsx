"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { REMOTE_PDF_HOSTS, fileNameOf, viewerUrlFor } from "../lib/remote_pdf";

const RECENT_KEY = "sheet-viewer:recent";
const MAX_RECENT = 5;

function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return []; // storage blocked or corrupt: just show no history
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* storage unavailable: history is a convenience only */
  }
}

/** Paste a PDF link, check it, and open it in the viewer. */
export default function OpenUrlForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  /**
   * False until the page's JavaScript is running (a split second in production, longer
   * in dev). Until then the box and button stay disabled: anything typed earlier would
   * be wiped when React takes over the input, and Enter would submit the form the
   * plain-HTML way, reloading the page.
   */
  const [ready, setReady] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRecent(loadRecent());
    setReady(true);
  }, []);

  // Focus the box once it can be typed in.
  useEffect(() => {
    if (ready) inputRef.current?.focus();
  }, [ready]);

  const open = (raw: string) => {
    const link = raw.trim();
    if (!link) return setError("Paste a link to a PDF first.");

    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return setError("That doesn't look like a web address. It should start with https://");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return setError("Only http(s) links can be opened.");
    }
    if (!viewerUrlFor(link)) {
      return setError(
        `Files from ${url.hostname} can't be opened yet. Ask a developer to add this host to app/lib/remote_pdf.ts.`,
      );
    }

    setError(null);
    const next = [link, ...recent.filter((r) => r !== link)];
    saveRecent(next);
    setRecent(next.slice(0, MAX_RECENT));
    // The link travels encoded in the address, so the viewer page can be bookmarked or shared.
    router.push(`/view?src=${encodeURIComponent(link)}`);
  };

  return (
    <main style={page}>
      <div style={card}>
        <h1 style={title}>Open a drawing</h1>
        <p style={lead}>Paste the link to a PDF drawing set to view it with clickable callouts.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            open(value);
          }}
          style={form}
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder={ready ? "https://nhub.blob.core.windows.net/…/drawing.pdf" : "Loading…"}
            disabled={!ready}
            aria-label="PDF link"
            aria-invalid={!!error}
            aria-describedby={error ? "url-error" : undefined}
            spellCheck={false}
            style={{ ...input, borderColor: error ? "#dc2626" : "#cbd5e1" }}
          />
          <button type="submit" disabled={!ready} style={{ ...primary, opacity: ready ? 1 : 0.6 }}>
            Open
          </button>
        </form>
        {error && (
          <p id="url-error" role="alert" style={errorText}>
            {error}
          </p>
        )}

        <p style={hint}>
          Links from: {Object.values(REMOTE_PDF_HOSTS).map((o) => new URL(o).hostname).join(", ")}
        </p>

        {recent.length > 0 && (
          <section style={{ marginTop: 24 }}>
            <h2 style={subhead}>Recently opened</h2>
            <ul style={list}>
              {recent.map((r) => (
                <li key={r}>
                  <button type="button" onClick={() => open(r)} style={recentRow} title={r}>
                    <span style={recentName}>{fileNameOf(r)}</span>
                    <span style={recentHost}>{(() => { try { return new URL(r).hostname; } catch { return ""; } })()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  boxSizing: "border-box",
  background: "#f1f5f9",
  font: "15px/1.5 system-ui, sans-serif",
  color: "#0f172a",
};
const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 640,
  padding: 28,
  boxSizing: "border-box",
  background: "#fff",
  borderRadius: 14,
  boxShadow: "0 4px 24px rgba(15,23,42,.08)",
};
const title: React.CSSProperties = { margin: "0 0 4px", fontSize: 24 };
const lead: React.CSSProperties = { margin: "0 0 18px", color: "#475569" };
const form: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };
const input: React.CSSProperties = {
  flex: "1 1 320px",
  minWidth: 0,
  padding: "11px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 10,
  font: "inherit",
  fontSize: 14,
};
const primary: React.CSSProperties = {
  padding: "11px 22px",
  border: 0,
  borderRadius: 10,
  background: "#15803d",
  color: "#fff",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};
const errorText: React.CSSProperties = { margin: "10px 0 0", color: "#b91c1c", fontSize: 14 };
const hint: React.CSSProperties = { margin: "12px 0 0", color: "#64748b", fontSize: 13 };
const subhead: React.CSSProperties = { margin: "0 0 6px", fontSize: 13, color: "#475569", fontWeight: 600 };
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const recentRow: React.CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  padding: "8px 10px",
  border: 0,
  borderRadius: 8,
  background: "transparent",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
};
const recentName: React.CSSProperties = { fontSize: 14, wordBreak: "break-all" };
const recentHost: React.CSSProperties = { fontSize: 12, color: "#64748b" };