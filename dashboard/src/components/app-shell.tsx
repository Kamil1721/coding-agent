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

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-11 w-full max-w-[1440px] items-center gap-4 px-4">
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

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4">{children}</main>

      <footer className="border-t border-line px-4 py-2">
        <div className="mx-auto flex w-full max-w-[1440px] items-center gap-3 text-[11px] text-ink-faint">
          <span>Bound to 127.0.0.1. Single user. Not reachable off-machine.</span>
          <span aria-hidden="true">·</span>
          <span>
            Work is produced by an autonomous AI agent, not a human.
          </span>
        </div>
      </footer>
    </div>
  );
}
