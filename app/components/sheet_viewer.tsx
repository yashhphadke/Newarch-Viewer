"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
// The "legacy" build includes polyfills for browsers that lack the newest JavaScript
// features (e.g. older Safari on site iPads). The modern build fails there.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

// PDF.js parses the file in a web worker so the page stays responsive.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type Props = {
  url: string;
  /** Page to open first (1-based). */
  initialPage?: number;
  /** Called whenever the visible page changes, with the page itself (e.g. to read its text). */
  onPageChange?: (pageNumber: number, numPages: number, page: PDFPageProxy) => void;
  /** Drawn on top of the page in PDF units (points, y down), e.g. callout boxes. */
  children?: (page: { pageNumber: number; width: number; height: number }) => ReactNode;
  /** Zoom to this area of the page (PDF units). Change `key` to zoom again. */
  focus?: { bbox: [number, number, number, number]; key: number } | null;
  /** Width covered on the right (e.g. by a sidebar); `focus` centres in the space left. */
  insetRight?: number;
};

/** Screen position = pdfPoint * scale + offset. */
type View = { scale: number; x: number; y: number };

const MAX_BASE_PIXELS = 14_000_000; // keeps the base image under browser canvas limits
const MAX_ZOOM = 40; // screen pixels per PDF point
const DETAIL_DELAY_MS = 180; // wait this long after the last pan/zoom before sharpening
/**
 * Render the sharp layer only once the screen needs this much more detail than the base
 * image has. The margin stops it flickering on and off right at the threshold.
 */
const SHARPEN_MARGIN = 1.15;
/**
 * Parsed drawing data is kept only for pages this close to the current one (1 = the
 * previous and next page). Everything further away is released: for these CAD sheets
 * that is about 50 MB per page, and without this memory grows with every page visited.
 */
const KEEP_PARSED_WITHIN = 1;

/**
 * How many recently viewed page images to keep, so going back to them is instant.
 * Each one is about 56 MB, so tablets and low-memory devices keep one, others two.
 */
function imageCacheSize(): number {
  const touch = window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 1;
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory; // Chrome/Edge only
  if (touch || (memoryGB !== undefined && memoryGB <= 4)) return 1;
  return 2;
}

// ---------------------------------------------------------------------------- loading

/**
 * Opens a PDF, downloading only the parts that are needed.
 *
 * PDF.js fetches the file in byte ranges: the index first, then the data of each page
 * when that page is viewed. A 40-sheet set no longer has to download completely before
 * page 1 appears. Pages still appear in one step, because each page is rendered off
 * screen before it is shown (see renderPage).
 *
 * The server must support HTTP range requests (Next's public/ folder and S3 do). If the
 * PDF is on another domain, that server must also allow and expose the range headers
 * (Accept-Ranges, Content-Range, Content-Length) via CORS. If range requests are not
 * supported, PDF.js falls back to downloading the whole file.
 */
export async function loadDocument(url: string, signal?: AbortSignal): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    url,
    // Fetch on demand: byte ranges on (the default), and both streaming and
    // background pre-fetching off. With either of those on, PDF.js would keep
    // downloading the rest of the file even though nobody is looking at it.
    disableStream: true,
    disableAutoFetch: true,
    // Fewer, larger requests: heavy CAD pages need hundreds of KB each, and the
    // 64 KB default would turn that into dozens of round trips.
    rangeChunkSize: 1 << 20, // 1 MB
    // Font data PDF.js needs to draw non-embedded fonts (e.g. Symbol) correctly.
    // Copy node_modules/pdfjs-dist/standard_fonts to public/pdfjs/standard_fonts.
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
  const abort = () => void task.destroy();
  signal?.addEventListener("abort", abort);
  try {
    return await task.promise;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** One page, fully rendered off screen. */
export type RenderedPage = {
  page: PDFPageProxy;
  image: HTMLCanvasElement;
  /** Page size in PDF points. */
  width: number;
  height: number;
  /** Image pixels per PDF point: how far the base image can be magnified before it blurs. */
  pxPerPt: number;
};

/**
 * Renders one page in its entirety into an off-screen canvas.
 *
 * PDF.js paints a page in chunks over many frames, so drawing straight into a visible
 * canvas makes it appear layer by layer. The promise resolves only once the image is
 * complete, so the caller can put it on screen in one step.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  signal?.throwIfAborted();

  const { width, height } = page.getViewport({ scale: 1 });
  // As sharp as browser canvas limits allow (about 4,450 x 3,140 px for an A1 sheet).
  const pxPerPt = Math.min(4, Math.sqrt(MAX_BASE_PIXELS / (width * height)));

  const image = document.createElement("canvas");
  image.width = Math.floor(width * pxPerPt);
  image.height = Math.floor(height * pxPerPt);
  // Don't call getContext() here: a canvas keeps the options of its first getContext
  // call. PDF.js asks for { alpha: false, willReadFrequently: true }, which keeps this
  // ~56 MB image in ordinary memory. A plain getContext("2d") would put it in GPU
  // memory, where the browser discards it under pressure (blank pages on iPads).
  // With alpha: false PDF.js also paints the white paper background itself.

  const task = page.render({ canvas: image, viewport: page.getViewport({ scale: pxPerPt }) });
  const abort = () => task.cancel();
  signal?.addEventListener("abort", abort);
  try {
    await task.promise;
  } catch (err) {
    image.width = image.height = 0; // don't leave a half-drawn 56 MB canvas behind
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  return { page, image, width, height, pxPerPt };
}

/** Frees a page image's pixels right away instead of waiting for garbage collection. */
function releaseImage(r: RenderedPage) {
  r.image.width = r.image.height = 0;
}

// ---------------------------------------------------------------------------- viewer

/** A page image kept after leaving it, with the view the user had on it. */
type CachedPage = { rendered: RenderedPage; view: View; minScale: number };

export default function SheetViewer({
  url,
  initialPage = 1,
  onPageChange,
  children,
  focus,
  insetRight = 0,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Same transform as the stage, but above the sharp layer, so overlays stay visible. */
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Holds the current page's canvas. Pages are swapped by replacing the canvas element. */
  const baseHostRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);

  const pageRef = useRef<PDFPageProxy | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const minScaleRef = useRef(0.1);
  /** Base image pixels per PDF point for the page on screen. */
  const basePxPerPtRef = useRef(1);
  const detailTaskRef = useRef<RenderTask | null>(null);
  const detailTimerRef = useRef<number | undefined>(undefined);

  /** The page on screen. */
  const currentRef = useRef<RenderedPage | null>(null);
  /** Recently viewed pages, oldest first (a Map keeps insertion order). */
  const imageCacheRef = useRef(new Map<number, CachedPage>());
  /** Pages whose drawing data PDF.js may still hold, so far ones can be released. */
  const parsedPagesRef = useRef(new Set<number>());

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  /** The page the user asked for. */
  const [pageNumber, setPageNumber] = useState(initialPage);
  /** The page actually on screen (lags behind pageNumber while the next one renders). */
  const [shown, setShown] = useState<{ pageNumber: number; width: number; height: number } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pageBusy, setPageBusy] = useState(false);
  const [zoomLabel, setZoomLabel] = useState("");
  const [pageInput, setPageInput] = useState(String(initialPage));
  /** Bumped to re-render the current page, e.g. after the browser discarded its canvas. */
  const [renderNonce, setRenderNonce] = useState(0);

  // ---------------------------------------------------------------- rendering

  /** Re-render just the visible area at full screen resolution. */
  const renderDetail = useCallback(async () => {
    const page = pageRef.current;
    const container = containerRef.current;
    const detail = detailRef.current;
    if (!page || !container || !detail) return;

    detailTaskRef.current?.cancel();
    const view = { ...viewRef.current };
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;

    // Render off-screen first so the visible layer never shows a half-drawn frame.
    const scratch = document.createElement("canvas");
    scratch.width = Math.round(w * dpr);
    scratch.height = Math.round(h * dpr);
    const task = page.render({
      canvas: scratch,
      viewport: page.getViewport({ scale: view.scale * dpr }),
      transform: [1, 0, 0, 1, view.x * dpr, view.y * dpr],
    });
    detailTaskRef.current = task;

    try {
      await task.promise;
    } catch {
      return; // cancelled because the view or page changed
    }
    const v = viewRef.current;
    if (page !== pageRef.current || v.scale !== view.scale || v.x !== view.x || v.y !== view.y) return;

    detail.width = scratch.width;
    detail.height = scratch.height;
    detail.style.width = `${w}px`;
    detail.style.height = `${h}px`;
    detail.getContext("2d")!.drawImage(scratch, 0, 0);
    detail.style.opacity = "1";
  }, []);

  /**
   * Apply the current view: move the base image now and, only if the base image is no
   * longer sharp enough at this zoom, render a sharp layer after a pause.
   */
  const applyView = useCallback(() => {
    const { scale, x, y } = viewRef.current;
    const transform = `translate(${x}px, ${y}px) scale(${scale})`;
    if (stageRef.current) stageRef.current.style.transform = transform;
    if (overlayRef.current) overlayRef.current.style.transform = transform;
    setZoomLabel(`${Math.round((scale / minScaleRef.current) * 100)}%`);

    if (detailRef.current) detailRef.current.style.opacity = "0";
    detailTaskRef.current?.cancel();
    window.clearTimeout(detailTimerRef.current);

    // Screen pixels per PDF point right now, versus what the base image holds.
    // At "fit" an A1 base image is about 4x sharper than the screen, so no extra
    // render is needed until well past 100% zoom.
    const screenPxPerPt = scale * (window.devicePixelRatio || 1);
    if (screenPxPerPt <= basePxPerPtRef.current * SHARPEN_MARGIN) return;

    detailTimerRef.current = window.setTimeout(renderDetail, DETAIL_DELAY_MS);
  }, [renderDetail]);

  const fit = useCallback(() => {
    const container = containerRef.current;
    const page = pageRef.current;
    if (!container || !page) return;
    const vp = page.getViewport({ scale: 1 });
    const pad = 16;
    const scale = Math.min(
      (container.clientWidth - pad * 2) / vp.width,
      (container.clientHeight - pad * 2) / vp.height,
    );
    minScaleRef.current = scale;
    viewRef.current = {
      scale,
      x: (container.clientWidth - vp.width * scale) / 2,
      y: (container.clientHeight - vp.height * scale) / 2,
    };
    applyView();
  }, [applyView]);

  /** Zoom by `factor` keeping the screen point (cx, cy) fixed under the cursor. */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const v = viewRef.current;
      const scale = Math.min(MAX_ZOOM, Math.max(minScaleRef.current * 0.5, v.scale * factor));
      const k = scale / v.scale;
      viewRef.current = { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      applyView();
    },
    [applyView],
  );

  // ---------------------------------------------------------------- memory: image cache and parsed data

  /** Drop every kept page image (new document, or unmount). */
  const clearImageCache = useCallback(() => {
    for (const { rendered } of imageCacheRef.current.values()) releaseImage(rendered);
    imageCacheRef.current.clear();
  }, []);

  /** Keep the page being left, so going back to it is instant. Oldest ones are dropped. */
  const keepLeavingPage = useCallback((leaving: RenderedPage) => {
    const cache = imageCacheRef.current;
    const n = leaving.page.pageNumber;
    cache.delete(n); // re-insert as most recent
    cache.set(n, { rendered: leaving, view: { ...viewRef.current }, minScale: minScaleRef.current });
    const limit = imageCacheSize();
    while (cache.size > limit) {
      const [oldest, entry] = cache.entries().next().value!;
      cache.delete(oldest);
      releaseImage(entry.rendered);
    }
  }, []);

  /**
   * Tell PDF.js to release parsed drawing data for pages far from the current one.
   * Their downloaded bytes stay cached, so coming back only costs a re-parse.
   */
  const releaseFarPages = useCallback((d: PDFDocumentProxy, current: number) => {
    for (const n of [...parsedPagesRef.current]) {
      if (Math.abs(n - current) <= KEEP_PARSED_WITHIN) continue;
      d.getPage(n)
        .then((p) => {
          // cleanup() returns false while the page is still drawing; it then
          // releases the data itself once that drawing finishes.
          p.cleanup();
          parsedPagesRef.current.delete(n);
        })
        .catch(() => {});
    }
  }, []);

  // ---------------------------------------------------------------- load the document (once per URL)

  useEffect(() => {
    const controller = new AbortController();
    let loaded: PDFDocumentProxy | null = null;
    setStatus("loading");
    setDoc(null);
    setShown(null);
    setPageNumber(initialPage);

    loadDocument(url, controller.signal)
      .then((d) => {
        loaded = d;
        setNumPages(d.numPages);
        setPageNumber((p) => Math.min(Math.max(1, p), d.numPages));
        setDoc(d);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.error("PDF load failed", err);
          setStatus("error");
        }
      });

    return () => {
      controller.abort();
      clearImageCache();
      if (currentRef.current) releaseImage(currentRef.current);
      currentRef.current = null;
      parsedPagesRef.current.clear();
      void loaded?.destroy();
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- show the current page

  useEffect(() => {
    if (!doc) return;
    const controller = new AbortController();
    setPageInput(String(pageNumber));

    /** Put a finished page on screen in one step and remember what was there before. */
    const show = (r: RenderedPage, restore?: { view: View; minScale: number }) => {
      detailTaskRef.current?.cancel();
      window.clearTimeout(detailTimerRef.current);
      if (detailRef.current) detailRef.current.style.opacity = "0";

      const leaving = currentRef.current;
      const sameView = leaving?.page.pageNumber === pageNumber; // a re-render of this page

      // Swap the finished canvas in whole: no copy, no partial frame ever visible.
      Object.assign(r.image.style, {
        display: "block",
        width: `${r.width}px`, // CSS size in PDF points; the stage scales it
        height: `${r.height}px`,
        boxShadow: "0 1px 6px rgba(0,0,0,.2)",
      });
      baseHostRef.current!.replaceChildren(r.image);
      currentRef.current = r;
      pageRef.current = r.page;
      basePxPerPtRef.current = r.pxPerPt;

      if (leaving && leaving !== r) {
        if (sameView) releaseImage(leaving); // the old copy of this same page
        else keepLeavingPage(leaving); // keep it so going back is instant
      }

      setShown({ pageNumber, width: r.width, height: r.height });
      setStatus("ready");
      setPageBusy(false);

      if (restore) {
        // Back to a kept page: reopen exactly where the user left it.
        viewRef.current = { ...restore.view };
        minScaleRef.current = restore.minScale;
        applyView();
      } else if (!sameView) {
        fit(); // a newly drawn page opens fitted
      }
      onPageChange?.(pageNumber, doc.numPages, r.page);
      releaseFarPages(doc, pageNumber);
    };

    // 1. Kept image? Show it straight away, no drawing needed.
    const cached = imageCacheRef.current.get(pageNumber);
    if (cached && currentRef.current?.page.pageNumber !== pageNumber) {
      imageCacheRef.current.delete(pageNumber);
      show(cached.rendered, cached);
      return;
    }

    // 2. Otherwise draw it off screen; the old page stays visible until it's done.
    setPageBusy(true);
    parsedPagesRef.current.add(pageNumber);
    renderPage(doc, pageNumber, controller.signal)
      .then((r) => {
        // Safety net: if the browser ever discards this canvas's pixels to free memory,
        // it fires "contextrestored" with a blank canvas. Redraw it if it's on screen;
        // if it's only kept for later, forget it so it gets redrawn when needed.
        r.image.addEventListener("contextrestored", () => {
          if (currentRef.current === r) setRenderNonce((n) => n + 1);
          else imageCacheRef.current.delete(r.page.pageNumber);
        });
        show(r);
      })
      .catch((err) => {
        if (controller.signal.aborted) return; // user moved on to another page
        console.error(`Page ${pageNumber} failed to render`, err);
        setPageBusy(false);
        setStatus((s) => (s === "ready" ? s : "error"));
      });

    return () => controller.abort();
  }, [doc, pageNumber, renderNonce, fit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom to an area when asked (e.g. a callout chosen in the sidebar).
  useEffect(() => {
    const container = containerRef.current;
    if (!focus || !container || !pageRef.current) return;
    const [x0, y0, x1, y1] = focus.bbox;
    const w = Math.max(x1 - x0, 1);
    const h = Math.max(y1 - y0, 1);
    const availW = Math.max(container.clientWidth - insetRight, 100);
    const availH = container.clientHeight;
    // Show the area with plenty of context around it, between "fit" and 8x fit.
    const target = Math.min(availW / (w * 5), availH / (h * 10));
    const scale = Math.min(MAX_ZOOM, minScaleRef.current * 8, Math.max(minScaleRef.current, target));
    viewRef.current = {
      scale,
      x: availW / 2 - ((x0 + x1) / 2) * scale,
      y: availH / 2 - ((y0 + y1) / 2) * scale,
    };
    applyView();
  }, [focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = useCallback(
    (n: number) => {
      if (!numPages) return;
      setPageNumber(Math.min(Math.max(1, Math.round(n)), numPages));
    },
    [numPages],
  );

  // ---------------------------------------------------------------- pan and zoom (the wheel never changes page)

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    // Mouse wheel / trackpad: zoom around the cursor (trackpad pinch arrives as ctrl+wheel).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(Math.exp(-e.deltaY * speed), p.x, p.y);
    };

    // Pointer drag to pan; two fingers to pinch-zoom.
    //
    // A press only becomes a pan once the pointer has moved a few pixels. Until then it
    // isn't captured, so a still tap on an overlay element (a callout) reaches it as a
    // normal click. Once captured, the click lands on the container, so a drag that
    // starts on a callout pans without selecting it.
    const DRAG_START_PX = 5;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let dragging = false;

    const startDrag = () => {
      dragging = true;
      for (const id of pointers.keys()) el.setPointerCapture(id);
    };

    const onDown = (e: PointerEvent) => {
      // Presses on the toolbars are clicks, not pans. Capturing them would redirect the
      // click away from the button, so leave them alone.
      if ((e.target as Element).closest("[data-controls]")) return;
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) dragging = false;
      if (pointers.size === 2) {
        startDrag(); // a second finger is always a pinch
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      if (!dragging) {
        if (Math.hypot(p.x - prev.x, p.y - prev.y) < DRAG_START_PX) return; // still a tap
        startDrag();
      }
      pointers.set(e.pointerId, p);

      if (pointers.size === 1) {
        const v = viewRef.current;
        viewRef.current = { ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y };
        applyView();
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) zoomAt(dist / pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinchDist = dist;
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
    const onDouble = (e: MouseEvent) => {
      if ((e.target as Element).closest("[data-controls]")) return; // fast clicks on ‹ › aren't zooms
      const p = local(e);
      zoomAt(2, p.x, p.y);
    };
    const onResize = new ResizeObserver(() => pageRef.current && fit());

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("dblclick", onDouble);
    onResize.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("dblclick", onDouble);
      onResize.disconnect();
    };
  }, [applyView, zoomAt, fit]);

  const zoomCentre = (factor: number) => {
    const el = containerRef.current;
    if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  };

  const commitPageInput = () => {
    const n = Number(pageInput);
    if (Number.isFinite(n) && n >= 1) goTo(n);
    else setPageInput(String(pageNumber));
  };

  // ---------------------------------------------------------------- markup

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "#e5e7eb",
        touchAction: "none", // we handle pan and pinch ourselves
        cursor: "grab",
        userSelect: "none",
      }}
    >
      {/* The current page, moved and scaled with CSS while interacting. */}
      <div
        ref={stageRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          willChange: "transform",
          visibility: status === "ready" ? "visible" : "hidden", // no empty page while loading
        }}
      >
        <div ref={baseHostRef} />
      </div>

      {/* Sharp re-render of just the visible area, shown once movement stops. */}
      <canvas
        ref={detailRef}
        style={{ position: "absolute", left: 0, top: 0, opacity: 0, pointerEvents: "none" }}
      />

      {/* Overlays (e.g. callouts), above the sharp layer, moved with the page. */}
      <div
        ref={overlayRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          // No will-change here: it would freeze the outlines at their unzoomed
          // resolution, so they'd blur when zoomed in. They're light to redraw.
          pointerEvents: "none", // only the overlay's own shapes take clicks
          visibility: status === "ready" ? "visible" : "hidden",
        }}
      >
        {shown && children?.(shown)}
      </div>

      {status !== "ready" && (
        <div style={notice}>{status === "loading" ? "Loading sheet…" : "Could not load the sheet"}</div>
      )}
      {status === "ready" && pageBusy && <div style={notice}>Loading page {pageNumber}…</div>}

      {/* Page switcher: buttons and a number box only. */}
      {numPages > 1 && (
        <div data-controls style={{ ...toolbar, left: "50%", right: "auto", transform: "translateX(-50%)" }}>
          <button style={btn} onClick={() => goTo(pageNumber - 1)} disabled={pageNumber <= 1} aria-label="Previous page">
            ‹
          </button>
          <span>Page</span>
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onBlur={commitPageInput}
            onKeyDown={(e) => e.key === "Enter" && commitPageInput()}
            inputMode="numeric"
            aria-label="Page number"
            style={pageBox}
          />
          <span>of {numPages}</span>
          <button style={btn} onClick={() => goTo(pageNumber + 1)} disabled={pageNumber >= numPages} aria-label="Next page">
            ›
          </button>
        </div>
      )}

      <div data-controls style={toolbar}>
        <button style={btn} onClick={() => zoomCentre(1 / 1.5)} aria-label="Zoom out">−</button>
        <span style={{ minWidth: 52, textAlign: "center" }}>{zoomLabel}</span>
        <button style={btn} onClick={() => zoomCentre(1.5)} aria-label="Zoom in">+</button>
        <button style={btn} onClick={fit}>Fit</button>
      </div>
    </div>
  );
}

const notice: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(255,255,255,.9)",
  font: "14px system-ui",
  color: "#334155",
};

const toolbar: React.CSSProperties = {
  position: "absolute",
  right: 16,
  bottom: 16,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: 6,
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 2px 10px rgba(0,0,0,.15)",
  font: "13px system-ui",
  color: "#0f172a",
  cursor: "default",
};

const btn: React.CSSProperties = {
  minWidth: 32,
  height: 32,
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#fff",
  font: "inherit",
  fontSize: 16,
  cursor: "pointer",
};

const pageBox: React.CSSProperties = {
  width: 40,
  height: 30,
  textAlign: "center",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  font: "inherit",
};