"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * THE ONE THING THAT MAY NEVER HAPPEN IN THIS APP: A COMPONENT MOUNTED FROM
 * `RootLayout` THROWING.
 *
 * WHAT IT COST, MEASURED TWICE ON 2026-08-10. `supervisor-strip.tsx` reads a
 * body served by `GET /api/supervisor`. A 200 whose body was not a supervisor
 * reading made it dereference `snapshot.probe.wired`, which threw out of
 * `SupervisorStrip` -> `AppShell` -> `RootLayout` — and A THROWING RootLayout
 * RENDERS NOTHING AT ALL: no strip, no nav, no canvas, no error text, on every
 * route. 80 failed / 186 passed across 11 browser spec files, 77 of them
 * carrying that single line. The shape validator in `lib/supervisor.ts` closed
 * that hole. Then a second body — `lastDefectSignature` carrying an object —
 * reached `shortSignature()`, called `.slice` on it, and blanked every page
 * again from a different line. Two blank pages from two fields is not two bugs;
 * it is one missing structural guarantee.
 *
 * VALIDATION AND THIS BOUNDARY ARE NOT ALTERNATIVES, AND CHOOSING ONE IS HOW
 * BOTH FAILURES HAPPENED. Validation is what keeps the strip HONEST: a body it
 * cannot read produces the named `malformed` state, with the offending field in
 * the sentence, which is a legible answer the owner can act on. This boundary is
 * what keeps the strip CONTAINED: whatever else goes wrong — a field the
 * contract grows and nobody validates, an `Intl` option a future Chrome
 * rejects, a hook that throws after an upgrade, tomorrow's edit to a component
 * nobody re-audited — the blast radius is 30px of header instead of the whole
 * application. The first is a promise about data. The second is a promise about
 * code, and no amount of data validation can make it.
 *
 * WHY A CLIENT BOUNDARY IS ENOUGH HERE, STATED RATHER THAN ASSUMED. React error
 * boundaries do not catch throws during the SERVER render, so this would be a
 * false promise if the strip could throw there. It cannot, for a specific
 * reason: `useSupervisor` has no `fallbackData`, so on the server pass `data` is
 * `undefined`, the reading is arm 1 (`unreachable`, snapshot `null`), and not one
 * wire field is reachable. Every throw this guard exists for is post-hydration,
 * which is exactly what a client boundary covers.
 *
 * IT IS NOT A GENERIC "something went wrong" BOX. A boundary whose fallback says
 * nothing is this repository's signature defect with nicer markup: the owner
 * would come back after eight hours to a calm grey row that means the same thing
 * as a green one. The fallback NAMES the component, PRINTS the error, says the
 * row is not a reading, and says what to do about it.
 */

/** What the fallback says, as a pure function so the arm check can read it. */
export function guardFallbackLine(what: string, error: unknown): string {
  const message =
    error instanceof Error && error.message.trim() !== ""
      ? error.message.trim().slice(0, 200)
      : typeof error === "string" && error.trim() !== ""
        ? error.trim().slice(0, 200)
        : "it threw with no message";
  return `${what} stopped rendering (${message}). Nothing on this row is a reading. The rest of the page is unaffected; reload, and if it returns, the fault is in this panel and not in the run.`;
}

export interface RenderGuardArm {
  readonly armed: boolean;
  /** One line, printed pass or fail. Never blank. */
  readonly line: string;
}

/**
 * THE ARM CHECK FOR A COMPONENT WHOSE WHOLE JOB IS TO DO NOTHING.
 *
 * An error boundary that is never exercised is indistinguishable from one that
 * cannot catch, and this repository has twenty-two catalogued instances of a
 * check that can only observe success. The regression this actually has is
 * mechanical and it has happened to other codebases a thousand times: somebody
 * converts the class to a function component, or deletes the static because "the
 * `componentDidCatch` covers it", and the boundary silently stops catching
 * anything. Both are visible from here without throwing:
 *
 *   1. `getDerivedStateFromError` must EXIST and must map an error to a failed
 *      state — a function component cannot have it, so the conversion is caught.
 *   2. The state it produces must carry the error, not a boolean, because the
 *      fallback prints the message.
 *   3. `guardFallbackLine` must produce a non-empty line that CONTAINS the
 *      message and the component's name.
 *   4. THE NEGATIVE CONTROL: two different errors must produce two different
 *      lines. A fallback that has gone constant ("something went wrong") passes
 *      1-3 and fails this, which is the whole point of having it.
 *
 * It cannot prove React will route a throw here — only a browser can, and
 * `supervisor-strip.browser.spec.ts` does it with a real throw. It proves the
 * mechanism this file owns is present and discriminating, and it says BLIND when
 * it is not.
 */
export function armRenderGuard(): RenderGuardArm {
  const failures: string[] = [];

  const derive = RenderGuard.getDerivedStateFromError;
  if (typeof derive !== "function") {
    failures.push(
      "RenderGuard has no static getDerivedStateFromError, so React will not route a throw to it",
    );
  } else {
    const derived = derive(new Error("arm check"));
    if (derived.error === null) {
      failures.push("getDerivedStateFromError produced a state with no error on it");
    }
  }

  const first = guardFallbackLine("the arm check", new Error("first fault"));
  const second = guardFallbackLine("the arm check", new Error("second fault"));
  if (first.trim() === "") failures.push("the fallback line is blank");
  if (!first.includes("first fault")) failures.push("the fallback line does not print the error");
  if (!first.includes("the arm check")) {
    failures.push("the fallback line does not name the component that failed");
  }
  if (first === second) {
    failures.push("two different errors produce the same line, so the fallback has gone constant");
  }

  return failures.length === 0
    ? {
        armed: true,
        line: "ARM CHECK: render guard routes a throw to a failed state and prints two different faults differently",
      }
    : {
        armed: false,
        line: `ARM CHECK FAILED — THE RENDER GUARD CANNOT CATCH: ${failures.join("; ")}`,
      };
}

interface GuardState {
  readonly error: unknown;
}

export class RenderGuard extends Component<
  { readonly what: string; readonly children: ReactNode },
  GuardState
> {
  override state: GuardState = { error: null };

  private armReported = false;

  static getDerivedStateFromError(error: unknown): GuardState {
    return { error };
  }

  /*
   * THE THROW IS LOGGED AS WELL AS RENDERED. The fallback is one line in a 30px
   * row; the stack is what a debugger needs at 3am, and `console.error` is the
   * channel the browser specs already read for the strip's own arm line.
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `RENDER GUARD CAUGHT: ${guardFallbackLine(this.props.what, error)}${info.componentStack ?? ""}`,
    );
  }

  override componentDidMount(): void {
    if (this.armReported) return;
    this.armReported = true;
    const arm = armRenderGuard();
    if (arm.armed) {
      console.info(arm.line);
    } else {
      console.error(arm.line);
    }
  }

  override render(): ReactNode {
    const arm = armRenderGuard();
    if (this.state.error === null) {
      /*
       * ARMED AND QUIET IS STILL REPORTED IN THE DOM, because a guard whose only
       * evidence is a console line is a guard nobody has seen working. `data-arm`
       * is what the browser spec reads, and it is the cheapest possible way for
       * the alarm below to be reachable rather than theoretical.
       */
      return (
        <div data-testid="render-guard" data-guard="ok" data-arm={arm.armed ? "true" : "false"}>
          {!arm.armed && (
            <p
              data-testid="render-guard-alarm"
              className="border-t border-fail/40 bg-fail-dim px-1 py-1 text-[11px] font-medium text-fail"
            >
              {arm.line}
            </p>
          )}
          {this.props.children}
        </div>
      );
    }

    return (
      <div
        data-testid="render-guard"
        data-guard="failed"
        data-arm={arm.armed ? "true" : "false"}
        /*
         * THE SAME 30px THE STRIP WAS BUDGETED. On `/runs/<id>` the shell is
         * `h-dvh overflow-hidden` with the canvas as a `flex-1 min-h-0` child, so
         * a fallback taller than the row it replaces would shrink the graph — a
         * failure in the header must not resize the thing the owner is watching.
         */
        className="flex h-[30px] w-full items-center gap-2 overflow-hidden text-[11.5px] text-warn"
      >
        <span className="shrink-0 rounded-sm border border-warn/40 bg-warn-dim px-1.5 py-[1px] font-mono text-[11px] uppercase tracking-[0.08em]">
          panel failed
        </span>
        <span data-testid="render-guard-line" className="min-w-0 flex-1 truncate">
          {guardFallbackLine(this.props.what, this.state.error)}
        </span>
      </div>
    );
  }
}
