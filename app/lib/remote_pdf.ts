/**
 * Remote PDF hosts the viewer can open, served through this app.
 *
 * Used in two places:
 *   - next.config.ts turns each entry into a rewrite: /external/<name>/... -> <origin>/...
 *   - viewerUrlFor() converts a full remote URL into that local path for the viewer.
 *
 * The rewrite passes paths and query strings through byte for byte, so double-encoded
 * file names (".../2032-HOABL%2520BICHOLIM...pdf") and Azure SAS tokens
 * ("?sv=...&sig=...") reach the remote host exactly as given, and Content-Length and
 * byte-range (206) responses come back intact for fast partial loading.
 */
export const REMOTE_PDF_HOSTS: Record<string, string> = {
  thecvf: "https://openaccess.thecvf.com",
  nhub: "https://nhub.blob.core.windows.net", // Azure Blob Storage
};

/**
 * Converts a remote PDF URL into the local path the viewer should load, or returns
 * null if its host isn't listed above.
 *
 *   viewerUrlFor("https://nhub.blob.core.windows.net/entity-attachments/.../X.pdf")
 *   -> "/external/nhub/entity-attachments/.../X.pdf"
 */
export function viewerUrlFor(remoteUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  for (const [name, origin] of Object.entries(REMOTE_PDF_HOSTS)) {
    if (url.origin === new URL(origin).origin) {
      // pathname and search keep their percent-encoding exactly as written.
      return `/external/${name}${url.pathname}${url.search}`;
    }
  }
  return null;
}

/** Short display name for a PDF link: its file name, decoded. */
export function fileNameOf(url: string): string {
  try {
    let name = new URL(url).pathname.split("/").pop() || url;
    // Names can be encoded more than once ("%2520" -> "%20" -> " ").
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(name); i++) name = decodeURIComponent(name);
    return name;
  } catch {
    return url;
  }
}