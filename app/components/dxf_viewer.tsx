// DxfCanvas.tsx
"use client"
import { useEffect, useRef, useState } from "react";
import { DxfViewer } from "dxf-viewer";
import * as THREE from "three";

type Props = {
  url: string;
  fonts?: string[];
  onReady?: (viewer: DxfViewer) => void;
};

export default function DxfCanvas({
  url,
  fonts = ["/fonts/Roboto.ttf"],
  onReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<DxfViewer | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Create the viewer once
  useEffect(() => {
    if (!containerRef.current) return;
    const viewer = new DxfViewer(containerRef.current, {
      clearColor: new THREE.Color("#fff"),
      autoResize: true,
      colorCorrection: true, 
    });
    viewerRef.current = viewer;
    return () => {
      viewer.Destroy();
      viewerRef.current = null;
    };
  }, []);

  // Load (or reload) the drawing whenever the URL changes
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let cancelled = false;
    setStatus("loading");

    viewer
      .Load({ url, fonts })
      .then(() => {
        if (cancelled) return;
        setStatus("ready");
        onReady?.(viewer);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("DXF load failed", err);
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

return (
  <div style={{ position: "fixed", inset: 0 }}>
    <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    {status !== "ready" && (
      <div style={{ position: "absolute", top: 8, left: 8, zIndex: 1 }}>
        {status === "loading" ? "Loading drawing…" : "Could not load drawing"}
      </div>
    )}
  </div>
);
}