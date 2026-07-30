"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useHealth } from "@/lib/hooks";
import { Dot, cx } from "./ui";

const NAV: readonly { readonly href: string; readonly label: string }[] = [
  { href: "/", label: "New ticket" },
  { href: "/runs", label: "Runs" },
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

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const fullBleed = isFullBleed(pathname);

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
        fullBleed ? "h-dvh overflow-hidden" : "min-h-full",
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
            "flex h-11 w-full items-center gap-4 px-4",
            fullBleed ? "" : "mx-auto max-w-[1440px]",
          )}
        >
          <Link href="/" className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight text-ink">
              agent console
            </span>
            <span className="rounded-sm border border-line-strong px-1 py-[1px] font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
              local
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>
          <div className="ml-auto">
            <AuthGlance />
          </div>
        </div>
      </header>

      <main
        className={cx(
          "w-full flex-1",
          fullBleed
            ? // No cap, no padding, and allowed to shrink so the canvas can own
              // exactly the space between header and footer.
              "min-h-0"
            : "mx-auto max-w-[1440px] px-4 py-4",
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
