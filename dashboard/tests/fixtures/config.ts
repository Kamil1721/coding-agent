/**
 * The harness's two ports and the one run id it serves.
 *
 * DELIBERATELY NOT THE DEV PORTS. `npm run dev` binds 4319 and the real backend
 * binds 4176; a suite that reuses either would either refuse to start while
 * someone is developing or — much worse — silently measure the OWNER'S running
 * app instead of the tree under test. Both numbers below are the harness's
 * alone, and `playwright.config.ts` starts both processes itself.
 */
export const APP_PORT = 4322;
export const API_PORT = 4177;

export const APP_ORIGIN = `http://127.0.0.1:${String(APP_PORT)}`;
export const API_ORIGIN = `http://127.0.0.1:${String(API_PORT)}`;

/** The run the style and layout specs open. Served entirely by `api-server.ts`. */
export const RUN_ID = "harness-canvas-run";

/**
 * The same graph, served with a stream that REPLAYS FROM ZERO the way the real
 * `/events` endpoint does. Separate from `RUN_ID` so the specs that measure
 * pixels never have a stream moving the canvas underneath them.
 */
export const REPLAY_RUN_ID = "harness-replay-run";

/**
 * The build directory the harness's `next dev` uses.
 *
 * Next 16 locks its build directory and refuses to start a second dev server
 * against the same one. See the note in `next.config.ts`.
 */
export const TEST_DIST_DIR = ".next-test";
