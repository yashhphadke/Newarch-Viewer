"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PDFPageProxy } from "pdfjs-dist";
import { extractCallouts, type Callout } from "../lib/callouts";
import CalloutLayer from "./callout_layer";
import CalloutSidebar, { SIDEBAR_WIDTH } from "./callout_sidebar";

// PDF.js uses browser-only APIs (canvas, DOMMatrix, workers), so skip server rendering.
const SheetViewer = dynamic(() => import("./sheet_viewer"), {
  ssr: false,
  loading: () => <p style={{ padding: 12, font: "14px system-ui" }}>Loading viewer…</p>,
});

/** A sheet set with clickable callouts and a details sidebar. */
export default function PlantingSheet({ url }: { url: string }) {
  /** Callouts per page, extracted the first time each page is shown. */
  const calloutsByPage = useRef(new Map<number, Callout[]>());
  const [page, setPage] = useState<{ number: number; callouts: Callout[] | null }>({ number: 0, callouts: null });
  const [selected, setSelected] = useState<Callout | null>(null);
  const [focus, setFocus] = useState<{ bbox: Callout["bbox"]; key: number } | null>(null);

  // A different file: forget everything extracted from the previous one.
  useEffect(() => {
    calloutsByPage.current.clear();
    setPage({ number: 0, callouts: null });
    setSelected(null);
  }, [url]);

  const onPageChange = useCallback((pageNumber: number, _numPages: number, pdfPage: PDFPageProxy) => {
    setSelected(null); // a callout belongs to one page
    const known = calloutsByPage.current.get(pageNumber);
    setPage({ number: pageNumber, callouts: known ?? null });
    if (known) return;

    extractCallouts(pdfPage)
      .then((found) => {
        calloutsByPage.current.set(pageNumber, found);
        // Only update if the user is still on that page.
        setPage((p) => (p.number === pageNumber ? { number: pageNumber, callouts: found } : p));
      })
      .catch((err) => console.error(`Could not read callouts on page ${pageNumber}`, err));
  }, []);

  const zoomTo = useCallback((c: Callout) => setFocus({ bbox: c.bbox, key: Date.now() }), []);

  // Escape closes the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const callouts = page.callouts ?? [];
  const counts = { plant: 0, light: 0, area: 0 };
  for (const c of callouts) counts[c.kind]++;

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <SheetViewer
        url={url}
        onPageChange={onPageChange}
        focus={focus}
        insetRight={selected ? SIDEBAR_WIDTH : 0}
      >
        {(shown) =>
          shown.pageNumber === page.number && callouts.length > 0 ? (
            <CalloutLayer
              callouts={callouts}
              width={shown.width}
              height={shown.height}
              selectedId={selected?.id ?? null}
              selectedCode={selected?.code ?? null}
              onSelect={setSelected}
            />
          ) : null
        }
      </SheetViewer>

      {/* What was found on this page */}
      {!selected && page.number > 0 && (
        <div style={badge}>
          {page.callouts === null
            ? "Finding callouts…"
            : callouts.length === 0
              ? "No callouts found on this page"
              : [
                  counts.plant && `${counts.plant} planting callouts`,
                  counts.light && `${counts.light} lighting tags`,
                  counts.area && `${counts.area} area labels`,
                ]
                  .filter(Boolean)
                  .join(" · ") + " · click one for details"}
        </div>
      )}

      {selected && (
        <CalloutSidebar
          callout={selected}
          pageCallouts={callouts}
          pageNumber={page.number}
          onSelect={setSelected}
          onZoom={zoomTo}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

const badge: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(255,255,255,.92)",
  boxShadow: "0 1px 4px rgba(0,0,0,.12)",
  font: "13px system-ui",
  color: "#334155",
  pointerEvents: "none",
};