"use client";

import { memo, useState } from "react";
import type { Callout, CalloutKind } from "../lib/callouts";

export const KIND_COLOURS: Record<CalloutKind, string> = {
  plant: "#15803d",
  light: "#b45309",
  area: "#1d4ed8",
};

type Props = {
  callouts: Callout[];
  /** Page size in PDF points. */
  width: number;
  height: number;
  selectedId: string | null;
  /** Callouts with this code are highlighted too (e.g. every bed of the same species). */
  selectedCode: string | null;
  onSelect: (callout: Callout) => void;
};

/**
 * Clickable outlines over the sheet's callouts. Drawn in PDF points, inside the viewer's
 * overlay layer, so it pans and zooms with the page.
 */
function CalloutLayer({ callouts, width, height, selectedId, selectedCode, onSelect }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", overflow: "visible" }}
    >
      {callouts.map((c) => {
        const colour = KIND_COLOURS[c.kind];
        const selected = c.id === selectedId;
        const related = !selected && c.code === selectedCode;
        const hover = c.id === hoverId;
        return (
          <polygon
            key={c.id}
            data-callout={c.id}
            points={c.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
            fill={colour}
            fillOpacity={selected ? 0.3 : related ? 0.16 : hover ? 0.12 : 0}
            stroke={colour}
            strokeOpacity={selected || related || hover ? 1 : 0.45}
            strokeWidth={selected ? 2.5 : related || hover ? 1.75 : 1}
            vectorEffect="non-scaling-stroke" // same line width at every zoom
            strokeLinejoin="round"
            style={{ pointerEvents: "all", cursor: "pointer" }}
            onPointerEnter={() => setHoverId(c.id)}
            onPointerLeave={() => setHoverId((h) => (h === c.id ? null : h))}
            onClick={() => onSelect(c)}
          >
            <title>
              {c.kind === "plant" ? `${c.code}-${c.bed} ${c.name}` : c.name ? `${c.code} - ${c.name}` : c.code}
            </title>
          </polygon>
        );
      })}
    </svg>
  );
}

export default memo(CalloutLayer);