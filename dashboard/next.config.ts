import type { NextConfig } from "next";

/**
 * Optional reverse proxy to a backend that runs OUT OF PROCESS.
 *
 * The HTTP API (`/api/runs`, `/api/models`, `/api/health`, ...) is owned by
 * another module. Two deployments are supported without changing a line of UI
 * code:
 *
 *   1. The backend is a separate local process — the actual arrangement here:
 *      `server/` binds 127.0.0.1:4176. Nothing needs configuring.
 *      `DASHBOARD_API_ORIGIN` overrides the destination AT BUILD TIME.
 *
 *   2. The backend ships as Route Handlers inside THIS app
 *      (`src/app/api/**`). Those win automatically and the rewrite goes
 *      unused; nothing needs configuring for that case either.
 *
 * The array form of `rewrites()` is `afterFiles`, so it runs AFTER filesystem
 * routes. If the backend agent adds real Route Handlers they win automatically
 * and this rewrite becomes inert — the two cannot collide. This app
 * deliberately contains no `src/app/api` directory and no `middleware.ts` for
 * exactly that reason: either would shadow the other module's handlers.
 *
 * If the rewrite ever buffers the SSE stream on `/api/runs/:id/events`, set
 * `NEXT_PUBLIC_API_BASE_URL` to the backend origin instead. That moves `fetch`
 * AND `EventSource` off the rewrite together — see `src/lib/api.ts`, the single
 * place either value is read.
 */
/**
 * Matches `DEFAULT_PORT` in `server/src/http.ts`, which binds 127.0.0.1 only.
 *
 * The rewrite is registered UNCONDITIONALLY, and that is deliberate. Next
 * evaluates `rewrites()` at BUILD time and bakes the result into
 * `routes-manifest.json`; `next start` never re-reads it. A build with the
 * variable unset therefore produced `afterFiles: []` and every `/api/*`
 * request 404'd in production while working fine in dev — a trap that only
 * appears after the build. A hardcoded loopback default makes the common case
 * work with no environment at all. Overriding the port means rebuilding, and
 * that is now the only surprising part rather than the default being broken.
 */
const DEFAULT_API_ORIGIN = "http://127.0.0.1:4176";

const apiOrigin = (
  process.env["DASHBOARD_API_ORIGIN"] ?? DEFAULT_API_ORIGIN
).replace(/\/+$/, "");

/**
 * A SECOND DEV SERVER NEEDS A SECOND BUILD DIRECTORY, and that is the only
 * reason this line exists.
 *
 * `npm test` boots its own `next dev` (see `playwright.config.ts`). Next 16
 * takes a lock inside the build directory and refuses to start a second dev
 * server against the same one — observed verbatim, with the owner's own server
 * already up on 4319: `⨯ Another next dev server is already running.` A test
 * suite that can only run when nobody is developing is a test suite that stops
 * being run, so the harness sets `NEXT_TEST_DIST_DIR=.next-test` and the two
 * servers stop sharing state entirely. Unset — every other invocation, `dev`,
 * `build`, `start` — this is exactly `.next`.
 */
const distDir = process.env["NEXT_TEST_DIST_DIR"] ?? ".next";

const nextConfig: NextConfig = {
  distDir,

  // The dashboard is a single-user local tool. It must never be reachable
  // off-machine: both subscription providers forbid making the account
  // available to anyone else. Loopback binding is enforced by `-H 127.0.0.1`
  // in the `dev`/`start` scripts; these headers are belt-and-braces for the
  // case where something else ends up fronting the app.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },

  rewrites: async () => [
    { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
  ],
};

export default nextConfig;
