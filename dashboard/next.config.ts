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

  experimental: {
    // A live POST /api/runs performs scorer readiness, then site capture and
    // motion capture sequentially. Their named slow-success bounds approach
    // five minutes, so Next's 30,000 ms proxy default cannot carry the request.
    // Six minutes keeps the wait finite while leaving headroom for overhead.
    // Next applies this value to every external rewrite, so an accepted-but-
    // silent API request also takes up to six minutes to fail. That is the
    // narrow recovery trade-off until run intake acknowledges before capture.
    proxyTimeout: 360_000,
  },

  /**
   * THE PREVIEW LINK IS A DIRECTORY URL, AND NEXT USED TO EAT ITS TRAILING SLASH.
   *
   * `GET /api/runs/:id/preview/` is a directory: the backend reads `index.html`
   * out of it and every relative asset in that document resolves against it. A
   * request that arrives WITHOUT the slash gets a 302 that puts one back
   * (`server/src/http.ts`, `servePreview`), because from the slashless address
   * `styles.css` resolves to `/api/runs/:id/styles.css`, one segment too high.
   *
   * Next's default canonicalisation does the exact opposite: it 308s
   * `/anything/` to `/anything`. The two rules pointed at each other and the
   * owner's preview link was an infinite redirect loop for 104 commits — nine
   * hops of 308/302 and then `net::ERR_TOO_MANY_REDIRECTS` on a blank white
   * page. `server/src/preview-through-next.test.ts` reproduces it with a real
   * Next in the path and prints the chain.
   *
   * IT TAKES BOTH LINES BELOW, AND EACH ALONE STILL LOOPS. That was measured, on
   * this Next (16.2.12), before either was written:
   *
   *   1. `skipTrailingSlashRedirect` removes the 308 — `redirects: []` in
   *      `routes-manifest.json` — and the route STILL loops, because
   *      `path-to-regexp` compiles the source `/api/:path*` to
   *      `^/api(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$`, where the trailing
   *      slash is matched by `(?:/)?` OUTSIDE the capture and is therefore
   *      dropped from `:path`. The REWRITE itself strips the slash, the backend
   *      302s it back on, and the slash form now redirects to ITSELF forever.
   *   2. `/api/:path(.*)` compiles to `^/api(?:/(.*))(?:/)?$`, whose capture is
   *      greedy and DOES include the trailing slash — but on its own the 308
   *      still fires first, so the loop is unchanged.
   *
   * `trailingSlash: true` was measured too and fails the same way as (1).
   *
   * WHAT SKIPPING THE REDIRECT COSTS, stated because it is wider than `/api/*`:
   * Next stops canonicalising PAGE urls as well, so `/runs` and `/runs/` both
   * answer 200 and neither redirects to the other. For a loopback single-user
   * tool that already sends `X-Robots-Tag: noindex` there is no duplicate-URL
   * problem to have; measured across `/`, `/runs`, `/runs/`, `/runs/<id>`,
   * `/runs/<id>/`, `/projects`, `/projects/` — all 200 — and `/nope` still 404.
   */
  skipTrailingSlashRedirect: true,

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

  /*
   * `:path(.*)` AND NOT `:path*` — see `skipTrailingSlashRedirect` above for the
   * loop this half closes.
   *
   * WHAT MAKES A REVERT TO `:path*` RED is the HOP COUNT in
   * `server/src/preview-through-next.test.ts`, and only that: reverted, the
   * slash form 302s to ITSELF nine times. Stated because two other tests in that
   * file look like they guard this line and do not — they pass under either
   * source and are guards against a FUTURE change of shape rather than proof
   * about this one:
   *
   *   - a preview asset called `poster frame.png`, linked as
   *     `/assets/poster%20frame.png`. `:path(.*)` substitutes the remainder
   *     verbatim where `:path*` re-encodes per segment; both spellings happened
   *     to resolve when measured.
   *   - the SSE stream at `/api/runs/:id/events`, which still delivers an event
   *     emitted after the response headers in about a millisecond.
   */
  rewrites: async () => [
    { source: "/api/:path(.*)", destination: `${apiOrigin}/api/:path` },
  ],
};

export default nextConfig;
