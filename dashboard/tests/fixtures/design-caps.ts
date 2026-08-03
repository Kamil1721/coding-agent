/**
 * design-caps.ts — THE DESIGN PARK'S TWO CAPS, READ OFF THE SERVER THAT SENDS
 * THEM.
 *
 * WHY THIS FILE EXISTS, AND IT IS A MEASURED DEFECT RATHER THAN TIDINESS. Three
 * fixtures — `design-lock.unit.spec.ts`, `design-lock.browser.spec.ts` and the
 * server's own `cron/cron-report.test.ts` — each built their own
 * `DesignLockState` with `turnsMax: 4` written into it by hand. On 2026-08-03
 * `MAX_DESIGN_LOCK_TURNS` became 8 and `http.ts` started sending 8; all three
 * stayed GREEN, describing a wire shape that no longer exists. One of them even
 * asserted the panel's own sentence, "6 of 6 renders left · 4 of 4 turns left",
 * against a body the server does not write. A fixture that invents the number it
 * is testing cannot see the drift it is standing in.
 *
 * WHY IT IS TEXT AND NOT AN IMPORT. `dashboard/src` and `dashboard/server` are
 * separate TypeScript programs — the client's `tsconfig.json` excludes `server`
 * outright — and `design-prompt.ts` pulls `node:path` and the design lane's own
 * modules in at module scope, so it cannot enter this program at all.
 * `contract-parity.test.ts` and `document-intake.browser.spec.ts` already cross
 * this seam the same way: read the other package's source, anchor on the
 * declaration, and fail as "the declaration moved" rather than as a silently
 * wrong number.
 *
 * THE EXTRACTOR HAS A NEGATIVE CONTROL, in `design-lock.unit.spec.ts`. A parity
 * reader that has only ever been observed matching is the defect this repository
 * keeps finding: the control renames the declaration, and turns the value into an
 * expression this file cannot evaluate, and requires both to throw.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The server's constants file, from THIS file's own location.
 *
 * `__dirname` rather than `process.cwd()`: Playwright is started from wherever
 * the owner happens to be, and a cwd-relative path would either read the wrong
 * tree or throw for a reason that has nothing to do with the caps.
 */
export const DESIGN_PROMPT_SOURCE = join(__dirname, "..", "..", "server", "src", "design-prompt.ts");

/**
 * ONE `export const <NAME> = <integer>;` out of the server's source, or a THROW.
 *
 * NEVER A DEFAULT. A fallback here would restore exactly the defect this file
 * exists for — a number the client made up, agreeing with nothing — so a
 * declaration that moved, was renamed, or became an expression (`Number(
 * process.env.X ?? 4)`) stops the suite with the reason on the line.
 */
export function designCapIn(source: string, name: string): number {
  const match = new RegExp(String.raw`export const ${name} = (\d+);`, "u").exec(source);
  if (match === null) {
    throw new Error(
      `${name} was not found in server/src/design-prompt.ts as \`export const ${name} = <integer>;\` — ` +
        "the declaration moved, was renamed, or is no longer a literal this fixture can read. Fix the " +
        "anchor rather than hardcoding the number back into the specs.",
    );
  }
  return Number(match[1]);
}

function serverCap(name: string): number {
  return designCapIn(readFileSync(DESIGN_PROMPT_SOURCE, "utf8"), name);
}

/** `design-prompt.ts#MAX_DESIGN_LOCK_TURNS` — owner turns at the design park. */
export const MAX_DESIGN_LOCK_TURNS = serverCap("MAX_DESIGN_LOCK_TURNS");

/** `design-prompt.ts#MAX_DESIGN_ON_DEMAND_RENDERS` — on-demand stills for the run. */
export const MAX_DESIGN_ON_DEMAND_RENDERS = serverCap("MAX_DESIGN_ON_DEMAND_RENDERS");
