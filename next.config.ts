import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy (SECURITY.md §5).
 * Scripts allow 'unsafe-inline' because Next.js injects inline bootstrap scripts;
 * a nonce-based policy is planned for Phase 10 hardening. Dev mode also needs
 * 'unsafe-eval' and websockets for hot reload.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Channel avatars come from YouTube's own image hosts (Phase 7); stock footage previews from Pexels (Phase 9).
  "img-src 'self' data: blob: https://yt3.ggpht.com https://yt3.googleusercontent.com https://images.pexels.com",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // Workers poll the internal API every couple of seconds; keep those out of the dev log.
  logging: { incomingRequests: { ignore: [/^\/api\/internal\//] } },
  experimental: {
    // Only validate "instant navigation" for segments that opt in with `export const instant = true`.
    // Our signed-in pages read the (deliberately uncached) session on every request — DECISIONS.md D-022.
    instantInsights: { validationLevel: "manual-warning" },
  },
  // Native/server-only packages that must not be bundled.
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
