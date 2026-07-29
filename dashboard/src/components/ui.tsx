"use client";

import { useCallback, useState, type ReactNode } from "react";

import { TONE_BADGE, TONE_DOT, TONE_TEXT, type Tone } from "@/lib/presentation";
import { shortenPath } from "@/lib/format";

export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

/* ------------------------------------------------------------------ */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): ReactNode {
  return (
    <section
      className={cx(
        "rounded border border-line bg-surface",
        className,
      )}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-3 py-2">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
                {title}
              </h2>
            )}
            {subtitle !== undefined && (
              <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{subtitle}</p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          )}
        </header>
      )}
      <div className={cx("px-3 py-2.5", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

export function Badge({
  tone,
  children,
  className,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-[1px] text-[11px] font-medium leading-[18px] whitespace-nowrap",
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block size-[6px] shrink-0 rounded-full",
        TONE_DOT[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "default" | "danger" | "ghost";

const BUTTON_VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "border-accent/50 bg-accent/15 text-accent hover:bg-accent/25 hover:border-accent/70",
  default:
    "border-line-strong bg-surface-raised text-ink hover:border-ink-faint hover:bg-line",
  danger:
    "border-fail/40 bg-fail-dim text-fail hover:border-fail/70 hover:bg-fail/20",
  ghost: "border-transparent bg-transparent text-ink-dim hover:text-ink hover:bg-surface-raised",
};

export function Button({
  variant = "default",
  type = "button",
  disabled = false,
  onClick,
  children,
  className,
  title,
}: {
  variant?: ButtonVariant;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  title?: string;
}): ReactNode {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[12px] font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:bg-surface-raised",
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */

export function Field({
  label,
  value,
  mono = false,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: Tone;
  hint?: string;
}): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </dt>
      <dd
        title={hint}
        className={cx(
          "mt-0.5 truncate text-[13px]",
          mono && "numeric",
          // Looked up, never interpolated: Tailwind cannot see a class that is
          // built by string concatenation, and the colour would silently vanish.
          tone === undefined ? "text-ink" : TONE_TEXT[tone],
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function CopyButton({
  value,
  label = "copy",
}: {
  value: string;
  label?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = useCallback((): void => {
    // `navigator.clipboard` is unavailable on a non-secure origin in some
    // browsers; 127.0.0.1 counts as secure, but the failure path still has to
    // be honest rather than silently doing nothing.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-sm border border-line-strong px-1.5 py-[1px] text-[10px] text-ink-faint transition-colors hover:border-ink-faint hover:text-ink"
    >
      {copied ? "copied" : label}
    </button>
  );
}

export function MonoPath({
  path,
  max = 64,
  copyable = true,
}: {
  path: string;
  max?: number;
  copyable?: boolean;
}): ReactNode {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <code
        title={path}
        className="min-w-0 truncate rounded-sm bg-canvas px-1.5 py-[2px] font-mono text-[11px] text-ink-dim"
      >
        {shortenPath(path, max)}
      </code>
      {copyable && <CopyButton value={path} />}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export function Notice({
  tone,
  title,
  children,
  actions,
}: {
  tone: Tone;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  const border: Readonly<Record<Tone, string>> = {
    pass: "border-pass/40 bg-pass-dim/60",
    fail: "border-fail/50 bg-fail-dim/70",
    warn: "border-warn/45 bg-warn-dim/60",
    info: "border-info/40 bg-info-dim/60",
    accent: "border-accent/40 bg-accent-dim/30",
    neutral: "border-line-strong bg-surface-raised",
  };
  return (
    <div className={cx("rounded border px-3 py-2.5", border[tone])}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">{title}</p>
          {children !== undefined && (
            <div className="mt-1 text-[12px] leading-relaxed text-ink-dim">{children}</div>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="px-1 py-6 text-center text-[12px] text-ink-faint">{children}</p>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {Array.from({ length: rows }, (_unused, index) => (
        <div
          key={index}
          className="h-3.5 animate-pulse rounded-sm bg-surface-raised"
          style={{ width: `${100 - index * 11}%` }}
        />
      ))}
    </div>
  );
}

/**
 * A command the owner is meant to paste into a terminal. Never a generic
 * "authentication failed" — the exact string that fixes it.
 */
export function CommandLine({ command }: { command: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-line-strong bg-canvas px-1.5 py-[2px]">
      <span aria-hidden="true" className="font-mono text-[11px] text-ink-faint">
        $
      </span>
      <code className="font-mono text-[11.5px] text-ink">{command}</code>
      <CopyButton value={command} />
    </span>
  );
}
