import Link from "next/link";
import type { Metadata } from "next";
import PlantingSheet from "../components/planting_sheet";
import { fileNameOf, viewerUrlFor } from "../lib/remote_pdf";

type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** The original PDF link, from /view?src=<link>. */
async function sourceOf(searchParams: Props["searchParams"]): Promise<string | null> {
  const src = (await searchParams).src;
  return typeof src === "string" && src.trim() ? src.trim() : null;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const src = await sourceOf(searchParams);
  return { title: src ? `${fileNameOf(src)} · Sheet viewer` : "Sheet viewer" };
}

/** Viewer page: /view?src=<PDF link>. */
export default async function ViewPage({ searchParams }: Props) {
  const src = await sourceOf(searchParams);
  const url = src ? viewerUrlFor(src) : null;

  if (!url) {
    return (
      <main style={problem}>
        <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Can&apos;t open this drawing</h1>
        <p style={{ margin: "0 0 16px", color: "#475569" }}>
          {src
            ? "Files from this website aren't set up for the viewer yet."
            : "No drawing link was given."}
        </p>
        <Link href="/" style={backLink}>
          ← Open a different link
        </Link>
      </main>
    );
  }

  return (
    <>
      <PlantingSheet url={url} />
      <Link href="/" style={homeButton} title="Open a different link">
        ← Open another
      </Link>
    </>
  );
}

const problem: React.CSSProperties = {
  maxWidth: 520,
  margin: "15vh auto 0",
  padding: 24,
  font: "15px/1.5 system-ui, sans-serif",
  color: "#0f172a",
};
const backLink: React.CSSProperties = { color: "#15803d", fontWeight: 600 };
const homeButton: React.CSSProperties = {
  position: "fixed",
  left: 16,
  bottom: 16,
  zIndex: 3,
  padding: "8px 12px",
  borderRadius: 10,
  background: "#fff",
  boxShadow: "0 2px 10px rgba(0,0,0,.15)",
  font: "13px system-ui, sans-serif",
  color: "#0f172a",
  textDecoration: "none",
};