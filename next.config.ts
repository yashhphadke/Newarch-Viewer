import type { NextConfig } from "next";
import { REMOTE_PDF_HOSTS } from "./app/lib/remote_pdf";

/**
 * Remote PDFs are served through this app so the viewer can open them: the browser
 * can't load most files from other websites directly (CORS). Each host listed in
 * app/lib/remote_pdf.ts becomes a rewrite, /external/<name>/... -> <origin>/..., so only
 * those hosts can be reached: there is no open "fetch any URL" endpoint.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    return Object.entries(REMOTE_PDF_HOSTS).map(([name, origin]) => ({
      source: `/external/${name}/:path*`,
      destination: `${origin}/:path*`,
    }));
  },
};

export default nextConfig;