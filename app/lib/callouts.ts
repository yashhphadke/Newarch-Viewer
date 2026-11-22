/**
 * Finds the callouts (tags) on a sheet from the PDF's text.
 *
 * CAD-exported PDFs store each callout as separate text fragments, and fragments of
 * different callouts are interleaved in the file. So text is grouped by position:
 * fragments that share a direction and baseline and sit next to each other form a
 * line, and lines are then matched against the callout formats below.
 *
 * Pure functions: works on PDF.js text content, in the browser or in Node.
 */
import type { PDFPageProxy } from "pdfjs-dist";

// ---------------------------------------------------------------------------- types

export type CalloutKind = "plant" | "light" | "area";

export type Callout = {
  /** Unique within the document: "<page>-<index>". */
  id: string;
  kind: CalloutKind;
  /** Key used to link data and to find matching callouts, e.g. "S-27" or "L03". */
  code: string;
  /** Text as written on the sheet. */
  text: string;
  /** Planting only: bed number ("07"), plant count, spacing in mm. */
  bed?: string;
  /** Botanical name (planting) or area name (areas). */
  name?: string;
  quantity?: number;
  spacingMm?: number;
  /** Outline on the page, in PDF points with y pointing down (the viewer's coordinates). */
  polygon: [number, number][];
  /** Axis-aligned bounds of the polygon: [minX, minY, maxX, maxY]. */
  bbox: [number, number, number, number];
};

/** A run of text on one baseline, in a frame aligned with the text direction. */
type Line = {
  text: string;
  /** Direction of the text in degrees (0 = left to right). */
  angle: number;
  /** Unit vectors along and across the text, in PDF user space (y up). */
  dir: [number, number];
  up: [number, number];
  /** Position along the text (u) and of the baseline across it (v). */
  u0: number;
  u1: number;
  v: number;
  size: number;
  /** Where each character starts, so a match inside the line can be located. */
  charU: number[];
};

type TextItemLike = { str: string; transform: number[]; width: number };
type ViewportLike = { convertToViewportPoint(x: number, y: number): number[] };

// ---------------------------------------------------------------------------- formats

/** "S-27-07 : PHYLLANTHUS MYRTIFOLIUS"  ->  species S-27, bed 07, botanical name. */
const PLANT_NAME = /^([A-Z]{1,3}-\d{1,3})-(\d{1,3})\s*:?\s*([A-Z][A-Z .'()-]+)$/;
/** "220 no.@ 200"  ->  220 plants at 200 mm spacing. */
const PLANT_QTY = /^(\d+)\s*no\.?\s*@\s*(\d+)$/i;
/**
 * Lighting fixture codes: "L03". Codes are matched word by word, because a label can
 * share its baseline with other text ("L03 SLOPE"), sit next to another code
 * ("L03 L04"), or be drawn twice on top of itself, which extracts as "L11L11".
 */
const LIGHT_WORD = /^(?:L\d{2})+$/;
const LIGHT_CODE = /L\d{2}/g;
/**
 * Area labels on layout plans: "08A01 - ENVELOPING PLANTATION", or the code alone.
 * The code is two digits, a letter, two digits. Drawing references such as "1C03"
 * (one digit) and the sheet number in the title block don't match.
 */
const AREA_LABEL = /^(\d{2}[A-Z]\d{2})(?:\s*[-–:]\s*(.+))?$/;

// ---------------------------------------------------------------------------- geometry

const deg = (rad: number) => (rad * 180) / Math.PI;
const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];

/** Smallest difference between two directions, in degrees. */
function angleDiff(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Groups text fragments into lines along each text direction. */
export function buildLines(items: TextItemLike[]): Line[] {
  type Frag = { str: string; angle: number; dir: [number, number]; up: [number, number]; u0: number; u1: number; v: number; size: number };

  const frags: Frag[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue; // spacers carry no text
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(a, b) || Math.hypot(c, d);
    if (!size) continue;
    const dir: [number, number] = [a / Math.hypot(a, b), b / Math.hypot(a, b)];
    const up: [number, number] = [-dir[1], dir[0]];
    const u0 = dot([e, f], dir);
    frags.push({ str: it.str, angle: deg(Math.atan2(b, a)), dir, up, u0, u1: u0 + it.width, v: dot([e, f], up), size });
  }

  // Bucket by direction, then sort each bucket by baseline and position along the text.
  const buckets: Frag[][] = [];
  for (const fr of frags) {
    const bucket = buckets.find((bk) => angleDiff(bk[0].angle, fr.angle) < 2);
    if (bucket) bucket.push(fr);
    else buckets.push([fr]);
  }

  const lines: Line[] = [];
  for (const bucket of buckets) {
    // Re-project everything onto the bucket's own frame so values are comparable.
    const { dir, up, angle } = bucket[0];
    for (const fr of bucket) {
      const shift = fr.u1 - fr.u0;
      const p: [number, number] = [fr.u0 * fr.dir[0] - fr.v * fr.dir[1], fr.u0 * fr.dir[1] + fr.v * fr.dir[0]];
      fr.u0 = dot(p, dir);
      fr.u1 = fr.u0 + shift;
      fr.v = dot(p, up);
    }
    bucket.sort((x, y) => x.v - y.v || x.u0 - y.u0);

    // Split into baselines (fragments within 30% of the font size of each other).
    const rows: Frag[][] = [];
    for (const fr of bucket) {
      const row = rows.find((r) => Math.abs(r[0].v - fr.v) < 0.3 * Math.max(r[0].size, fr.size));
      if (row) row.push(fr);
      else rows.push([fr]);
    }

    // Within a baseline, join neighbours; a big gap starts a new line.
    for (const row of rows) {
      row.sort((x, y) => x.u0 - y.u0);
      let cur: Line | null = null;
      for (const fr of row) {
        const gap = cur ? fr.u0 - cur.u1 : Infinity;
        // Text at a very different size belongs to another label, even when it overlaps
        // (a tiny "SLOPE" arrow label drawn across an "L03" would otherwise read "L03SLOPE").
        const sizeJump = cur ? Math.max(cur.size, fr.size) / Math.min(cur.size, fr.size) > 1.6 : false;
        if (!cur || sizeJump || gap > 1.5 * Math.max(cur.size, fr.size)) {
          cur = { text: "", angle, dir, up, u0: fr.u0, u1: fr.u0, v: fr.v, size: fr.size, charU: [] };
          lines.push(cur);
        } else if (gap > 0.2 * fr.size) {
          cur.text += " ";
          cur.charU.push(cur.u1);
        }
        const step = (fr.u1 - fr.u0) / fr.str.length;
        for (let k = 0; k < fr.str.length; k++) cur.charU.push(fr.u0 + k * step);
        cur.text += fr.str;
        cur.u1 = Math.max(cur.u1, fr.u1);
        cur.size = Math.max(cur.size, fr.size);
      }
    }
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, " ").trim();
  return lines;
}

/** Outline of a region given in a line's frame, converted to viewer coordinates. */
function outline(
  frame: Pick<Line, "dir" | "up">,
  u0: number,
  u1: number,
  vBottom: number,
  vTop: number,
  viewport: ViewportLike,
): Pick<Callout, "polygon" | "bbox"> {
  const corner = (u: number, v: number): [number, number] => {
    const x = u * frame.dir[0] + v * frame.up[0];
    const y = u * frame.dir[1] + v * frame.up[1];
    const [px, py] = viewport.convertToViewportPoint(x, y);
    return [px, py];
  };
  const polygon = [corner(u0, vBottom), corner(u1, vBottom), corner(u1, vTop), corner(u0, vTop)];
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { polygon, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

// ---------------------------------------------------------------------------- matching

/** Planting callouts: a name line with its quantity line just below it. */
function plantCallouts(lines: Line[], viewport: ViewportLike) {
  const out: Omit<Callout, "id">[] = [];
  const used = new Set<Line>();

  for (const nameLine of lines) {
    const m = PLANT_NAME.exec(nameLine.text);
    if (!m) continue;

    // The quantity line: same direction, one line below, overlapping along the text.
    let qty: { line: Line; q: RegExpExecArray } | null = null;
    let best = Infinity;
    for (const l of lines) {
      if (l === nameLine || used.has(l) || angleDiff(l.angle, nameLine.angle) > 2) continue;
      const below = (nameLine.v - l.v) / nameLine.size;
      if (below < 0.6 || below > 2.5) continue;
      if (l.u1 < nameLine.u0 - nameLine.size || l.u0 > nameLine.u1 + nameLine.size) continue;
      const q = PLANT_QTY.exec(l.text);
      if (q && below < best) {
        best = below;
        qty = { line: l, q };
      }
    }
    if (qty) used.add(qty.line);

    const s = nameLine.size;
    const u0 = Math.min(nameLine.u0, qty?.line.u0 ?? Infinity) - 0.3 * s;
    const u1 = Math.max(nameLine.u1, qty?.line.u1 ?? -Infinity) + 0.3 * s;
    const vBottom = (qty ? qty.line.v : nameLine.v) - 0.4 * s;
    const vTop = nameLine.v + 1.0 * s;

    out.push({
      kind: "plant",
      code: m[1],
      bed: m[2],
      name: m[3].trim(),
      quantity: qty ? Number(qty.q[1]) : undefined,
      spacingMm: qty ? Number(qty.q[2]) : undefined,
      text: qty ? `${nameLine.text} / ${qty.line.text}` : nameLine.text,
      ...outline(nameLine, u0, u1, vBottom, vTop, viewport),
    });
  }
  return out;
}

/** Area labels: the area code, optionally followed by the area's name, on one line. */
function areaCallouts(lines: Line[], viewport: ViewportLike) {
  const out: Omit<Callout, "id">[] = [];
  for (const l of lines) {
    const m = AREA_LABEL.exec(l.text);
    if (!m) continue;
    const s = l.size;
    out.push({
      kind: "area",
      code: m[1],
      name: m[2]?.trim() || undefined,
      text: l.text,
      ...outline(l, l.u0 - 0.3 * s, l.u1 + 0.3 * s, l.v - 0.4 * s, l.v + 1.0 * s, viewport),
    });
  }
  return out;
}

/** Lighting callouts: a short fixture code next to each light. */
function lightCallouts(lines: Line[], viewport: ViewportLike) {
  const out: Omit<Callout, "id">[] = [];
  for (const l of lines) {
    const s = l.size;
    for (const word of l.text.matchAll(/\S+/g)) {
      if (!LIGHT_WORD.test(word[0])) continue;
      let prev: { code: string; u1: number } | null = null;
      for (const m of word[0].matchAll(LIGHT_CODE)) {
        const code = m[0];
        const at = word.index + m.index; // character position within the line
        const u0 = l.charU[at] ?? l.u0;
        const u1 = l.charU[at + code.length] ?? l.u1;
        // The same code starting where the previous one ends (or overlapping it) is one
        // label drawn twice on top of itself: keep a single tag for it.
        if (prev && prev.code === code && u0 <= prev.u1 + 0.2 * s) continue;
        prev = { code, u1 };
        out.push({ kind: "light", code, text: code, ...outline(l, u0 - 0.3 * s, u1 + 0.3 * s, l.v - 0.4 * s, l.v + 1.0 * s, viewport) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- entry points

/** Callouts from already-loaded text content (useful for tests and servers). */
export function calloutsFromText(
  items: TextItemLike[],
  viewport: ViewportLike,
  pageNumber: number,
): Callout[] {
  const lines = buildLines(items);
  const found = [
    ...plantCallouts(lines, viewport),
    ...lightCallouts(lines, viewport),
    ...areaCallouts(lines, viewport),
  ];
  return found.map((c, i) => ({ id: `${pageNumber}-${i}`, ...c }));
}

/** Reads a page's text and returns its callouts, in the viewer's coordinates. */
export async function extractCallouts(page: PDFPageProxy): Promise<Callout[]> {
  const content = await page.getTextContent();
  const items = content.items.filter((i): i is TextItemLike & typeof i => "str" in i);
  return calloutsFromText(items, page.getViewport({ scale: 1 }), page.pageNumber);
}