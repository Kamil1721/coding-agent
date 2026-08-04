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
 * A run PARKED IN THE PLAN PHASE, waiting on questions.
 *
 * WHY IT IS A THIRD RUN AND NOT A FLAG ON THE FIRST. There is no such run on this
 * machine and there cannot easily be one — the plan seat spends the owner's
 * subscription quota, and a park lasts twenty minutes. The state is real, the
 * server writes it today, and the only way a browser can be shown it is a
 * fixture. `RUN_ID` is measured for pixels by four other specs and must not
 * acquire a docked panel none of them expect.
 *
 * ITS CHAT ROWS ARE THE BYTES THE SERVER WOULD SEND: `questionText`'s
 * `PQ-n: sentence` block, and one prose row for the seat's plan. See
 * `run-fixture.ts`, which quotes the producing line for each one.
 */
export const PLAN_RUN_ID = "harness-plan-run";

/**
 * THE PAIR THAT DIFFERS ONLY IN STATUS — a live build and the same build after
 * it ended. Both are served from ONE event list in `build-run-fixture.ts`.
 *
 * WHY A FOURTH AND FIFTH RUN AND NOT A FLAG ON AN EXISTING ONE. Every run above
 * is NON-TERMINAL (`running`, `running`, `awaiting_input`), and that is not an
 * oversight in any of them — the flowing edge needs a live child, and a park
 * needs a run that is waiting. But it left the harness unable to reach the one
 * branch that matters most for replay: `use-run-stream.ts:819` closes the stream
 * on `isTerminalStatus`, so a terminal run renders from the REST snapshot ALONE.
 * Until these two ids existed, no browser spec in this repository could tell a
 * feature that survives a reload from one that only ever existed on the socket.
 *
 * `RUN_ID` could not be reused for it: four specs measure that run for pixels
 * and a terminal status would change its edges, its rims and its trace pane.
 */
export const BUILD_RUN_ID = "harness-build-run";
export const FINISHED_RUN_ID = "harness-finished-run";

/**
 * The build directory the harness's `next dev` uses.
 *
 * Next 16 locks its build directory and refuses to start a second dev server
 * against the same one. See the note in `next.config.ts`.
 */
export const TEST_DIST_DIR = ".next-test";
