"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useHealth } from "@/lib/hooks";
import { RenderGuard } from "./render-guard";
import { SupervisorStrip } from "./supervisor-strip";
import { Dot, cx } from "./ui";

/**
 * `Projects` SITS AFTER `Runs` BECAUSE IT IS DOWNSTREAM OF IT — a ticket becomes
 * a run becomes a folder, and the nav reads in that order.
 *
 * IT IS NOT A SHORTCUT TO SOMETHING ALREADY REACHABLE. A published folder was
 * findable only by remembering which run produced it and reading a path off that
 * run's Verdict tab; the whole point of the index is coming back a week later
 * without the run id, and a route the owner has to type by hand does not do
 * that.
 */
const NAV: readonly { readonly href: string; readonly label: string }[] = [
  { href: "/", label: "New ticket" },
  { href: "/runs", label: "Runs" },
  { href: "/projects", label: "Projects" },
];

function NavLink({ href, label }: { href: string; label: string }): ReactNode {
  const pathname = usePathname();
  const active =
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "rounded-sm px-2 py-1 text-[12.5px] transition-colors",
        active
          ? "bg-surface-raised text-ink"
          : "text-ink-dim hover:bg-surface-raised hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}

/**
 * Compact auth read-out in the top bar. Detail and fix commands live on the
 * new-ticket screen.
 *
 * THE `codex` DOT WAS REMOVED HERE ON 2026-07-30. It read `claude · codex` and
 * sat, amber, on every screen — reporting a login the owner has no reason to
 * perform, for a provider `/api/models` stopped offering when Codex was scoped out
 * (spec section 14). `/api/health` still carries `codexAuth`; nothing renders it.
 */
function AuthGlance(): ReactNode {
  const { data, error } = useHealth();

  if (error !== undefined && data === undefined) {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
        <Dot tone="neutral" />
        API unreachable
      </span>
    );
  }
  if (data === undefined) {
    return <span className="text-[11.5px] text-ink-faint">checking auth…</span>;
  }

  const entries = [{ name: "claude", ok: data.claudeAuth === "ok" }] as const;

  return (
    <div className="flex items-center gap-3">
      {entries.map((entry) => (
        <span
          key={entry.name}
          className="flex items-center gap-1.5 text-[11.5px] text-ink-dim"
          title={
            entry.ok
              ? `${entry.name} subscription auth present`
              : `${entry.name} subscription auth missing`
          }
        >
          <Dot tone={entry.ok ? "pass" : "warn"} />
          {entry.name}
        </span>
      ))}
    </div>
  );
}

/**
 * WHICH ROUTES GET THE 1440px CAP, AND WHY THE RUN VIEW DOES NOT.
 *
 * `main` used to cap every route at 1440px and centre it. On a 2000px window that
 * is a 1440px canvas with 280px of dead gutter down each side — measured, not
 * guessed — and the owner's verdict was "make the canvas actually full screen not
 * cut off on the sides".
 *
 * The cap could not simply be deleted: it is what stops the NEW TICKET screen
 * becoming a 2000px-wide textarea, and `/runs` is a list that wants it too. So the
 * escape is scoped to the one route whose content is a viewport-filling graph.
 *
 * `/runs/<id>` ONLY, not `/runs`. The regex takes exactly one path segment after
 * `/runs`, so the list keeps the cap and the run view loses it.
 *
 * THE PREVIOUS ATTEMPT AT THIS LIVED IN THE PAGE and could not work. The run page
 * cancels `main`'s PADDING with `-mx-4 -mt-4`, which is 16px; nothing a child can
 * do cancels a `max-width` on its parent. That is why the gutters survived a
 * redesign whose whole stated purpose was a fullscreen canvas.
 */
function isFullBleed(pathname: string): boolean {
  return /^\/runs\/[^/]+$/.test(pathname);
}

/**
 * THE LISTS TAKE THE WINDOW TOO — 2026-08-09, and it is a different argument
 * from the run view's, which is why it is a second predicate rather than a
 * widened regex.
 *
 * WHAT WAS LEFT. Fixing the canvas's gutters scoped the escape to `/runs/<id>`
 * and left `/runs` and `/projects` capped, measured at 2000px as
 * `main {x: 280, width: 1440}` — 280px of dead ground down each side of a table.
 * The guard that held the cap in place said, correctly, that deleting it
 * outright "would also have handed the new-ticket form the full 2000px, which
 * is worse than the bug — a 2000px-wide textarea".
 *
 * SO THE CAP IS KEPT WHERE IT IS DOING WORK AND DROPPED WHERE IT IS NOT, and
 * the line between them is what the cap is FOR. A `max-width` on a page of
 * prose or a form protects the MEASURE: past about ninety characters the eye
 * loses the start of the next line. Neither list has a measure to protect.
 * `/runs` is a six-column table whose every column is `whitespace-nowrap` or a
 * badge except ONE — the ticket title, which is `min-w-0 … truncate`. Every
 * pixel the cap was withholding therefore goes to the single field that is
 * being cut off, and nothing else on the row moves. `/projects` is the same
 * shape: a fixed status column, a fixed control column, and a path that is
 * shortened from the left when it does not fit.
 *
 * `/` KEEPS THE CAP, and that is the whole of the original guard's point. It is
 * a ticket composer — a textarea and prose — and it is the one screen here where
 * width costs readability.
 */
function isWideList(pathname: string): boolean {
  return pathname === "/runs" || pathname === "/projects";
}

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const fullBleed = isFullBleed(pathname);
  /** No cap, but still padded and still scrolling with the document. */
  const wide = isWideList(pathname);
  const capped = !fullBleed && !wide;

  return (
    /*
     * TWO SHELL MODES, and the difference is where the scrollbar lives.
     *
     * Normally the document scrolls: `min-h-full` lets `main` grow past the
     * viewport and the page scrolls as one. That is correct for a form or a list.
     *
     * Full bleed pins the shell to exactly one viewport (`h-dvh`, `overflow-hidden`)
     * and gives `main` `flex-1 min-h-0`, so the canvas simply fills what the header
     * and footer leave. `min-h-0` is load-bearing: without it a flex child refuses
     * to shrink below its content and the footer gets pushed off-screen.
     *
     * THIS REPLACES AN ARITHMETIC THAT WAS NEVER GUARDED. The page used to take
     * `100dvh - var(--run-chrome)` where `--run-chrome: 100px` was a MEASURED fudge
     * ("94px still produced a 1px document overflow"), and globals.css claimed
     * `run-canvas.browser.spec.ts` went red if it drifted. That file does not exist.
     * Flex fill needs no constant, so there is no number left to drift.
     */
    <div
      className={cx(
        "flex flex-col",
        fullBleed
          ? "h-dvh overflow-hidden"
          : "min-h-full overflow-x-clip sm:overflow-x-visible",
      )}
    >
      <header className="sticky top-0 z-20 shrink-0 border-b border-line bg-canvas/95 backdrop-blur">
        {/*
          * The header and footer carry their OWN cap, separate from `main`'s. Left
          * alone on a full-bleed route they inset the nav to 1440px while the canvas
          * below ran edge to edge — visible in the first screenshot of the fix as a
          * header that looked misaligned against its own page. So the bleed carries
          * through all three boxes or none of them.
          */}
        <div
          className={cx(
            "flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:h-11 sm:flex-nowrap sm:gap-y-0 sm:py-0",
            capped ? "mx-auto max-w-[1440px]" : "",
          )}
        >
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight text-ink">
              agent console
            </span>
            <span className="rounded-sm border border-line-strong px-1 py-[1px] font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
              local
            </span>
          </Link>
          <nav className="order-3 flex basis-full items-center gap-1 sm:order-none sm:basis-auto">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>
          <div className="ml-auto shrink-0">
            <AuthGlance />
          </div>
        </div>

        {/*
          * THE SUPERVISOR STRIP IS A SECOND HEADER ROW, ON EVERY ROUTE.
          *
          * ALWAYS MOUNTED, deliberately. The question it answers — "is the loop
          * moving" — is the one the owner has after eight hours away, and it
          * must not be reachable only from a screen he would have to know to
          * open. DESIGN §7.6.2 puts it here for that reason.
          *
          * IT TAKES ITS OWN ROW RATHER THAN SHARING THE NAV'S, and the nav row
          * is `h-11` with a nav, a wordmark and the auth glance already in it.
          * Seven fields plus three controls in the remainder would truncate to
          * the point of being unreadable at 1440px, which is the width every
          * screenshot of this app is taken at.
          *
          * THE COST IS 30px OFF THE CANVAS AND IT IS PAID BY FLEX, NOT BY
          * ARITHMETIC. On `/runs/<id>` the shell is `h-dvh overflow-hidden` and
          * `main` is `flex-1 min-h-0`, so a taller header simply leaves the
          * canvas 30px less and nothing overflows. There is no `--run-chrome`
          * constant to update, because the fix that deleted it is what makes
          * this row free. `supervisor-strip.browser.spec.ts` asserts the run
          * view still has no scrollbar in either axis, no clipped node, and a
          * fit scale above 0.7 at 2000px with the strip mounted.
          *
          * It carries the SAME cap as the nav row: on a full-bleed route a
          * capped strip would inset against an edge-to-edge canvas, which is
          * the misalignment the header cap fix already dealt with once.
          */}
        <div
          className={cx(
            "min-w-0 w-full border-t border-line px-4",
            capped ? "mx-auto max-w-[1440px]" : "",
          )}
        >
          {/*
            * THE ONLY ERROR BOUNDARY IN THIS APP, AND IT IS HERE BECAUSE THIS IS
            * THE ONE PLACE A THROW COSTS EVERYTHING. Every other component in
            * the tree is a child of `main` on ONE route; this row is mounted
            * from `RootLayout` on EVERY route, and React unwinds a throw to the
            * nearest boundary — with none, that is the root, which renders
            * nothing: no nav, no canvas, no error text, on every page. Measured
            * twice on 2026-08-10 from two different fields of one API body.
            *
            * IT WRAPS THE STRIP AND NOTHING ELSE, DELIBERATELY. Wrapping
            * `{children}` would swallow page-level throws that specs in this
            * suite deliberately provoke and that Next's own overlay reports in
            * dev — a boundary that hides a bug is worse than the blank page,
            * because the blank page at least gets fixed. See `render-guard.tsx`
            * for why validation in `lib/supervisor.ts` does not remove the need
            * for this, and for the arm check that proves it can still catch.
            */}
          <RenderGuard what="the supervisor strip">
            <SupervisorStrip />
          </RenderGuard>
        </div>
      </header>

      <main
        className={cx(
          "w-full flex-1",
          fullBleed
            ? // No cap, no padding, and allowed to shrink so the canvas can own
              // exactly the space between header and footer.
              "min-h-0"
            : // A list keeps the page's padding and loses only the cap; a form
              // keeps both. See `isWideList`.
              cx("px-4 py-4", capped && "mx-auto max-w-[1440px]"),
        )}
      >
        {children}
      </main>

      {/*
        * THE FOOTER IS GONE — 2026-07-30, at the owner's request.
        *
        * It read "Bound to 127.0.0.1. Single user. Not reachable off-machine. · Work
        * is produced by an autonomous AI agent, not a human." — on every screen,
        * forever, to an audience of exactly one person who runs the server himself.
        * Both sentences are the kind of disclosure a PUBLISHED tool owes strangers.
        * This one has no strangers: "there is no point in this bar at the bottom this
        * is only used by me".
        *
        * NEITHER FACT IS LOST WHERE IT MATTERS. The bind is enforced in code — the
        * process exits 2 if `DASHBOARD_HOST` is anything but `127.0.0.1` — and stated
        * in the README, which is where someone who has not run it yet looks. The AI
        * provenance is on every artefact the run produces, not just on this chrome.
        *
        * Removing it also gives the canvas its ~34px back, which on the run route is
        * pure graph.
        */}
    </div>
  );
}
