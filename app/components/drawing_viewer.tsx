"use client";

import dynamic from "next/dynamic";
import type { DxfViewer } from "dxf-viewer";

const DxfCanvas = dynamic(() => import("./dxf_viewer"), {
  ssr: false,
  loading: () => <p>Loading viewer…</p>,
});

export default function DrawingViewer({ url }: { url: string }) {
  const handleReady = (viewer: DxfViewer) => {
  console.log("bounds", viewer.GetBounds());
  console.log("layers", [...viewer.GetLayers(true)].map(l => l.name));
  console.log("canvas", viewer.GetCanvas().width, viewer.GetCanvas().height);
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <DxfCanvas url={url} onReady={handleReady} />
    </div>
  );
}