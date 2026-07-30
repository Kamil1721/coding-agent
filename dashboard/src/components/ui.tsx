"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

/* ------------------------------------------------------------------ */
/* Lightbox — one image, big, over everything                          */
/* ------------------------------------------------------------------ */

/**
 * A full-screen image viewer.
 *
 * WHY IT EXISTS. The design mockups render at 156px tall with `object-cover`, which
 * is the right size for comparing five of them at a glance and useless for judging
 * one. The owner asked for the obvious thing: "when i click on these images they
 * should come up bigger in the middle of the screen im currently on ontop the the
 * canva and i can dismiss them by pressing x or outside of them."
 *
 * THREE WAYS OUT, and all three are conventions rather than inventions: the ×, a
 * click on the backdrop, and Escape. Escape was not asked for and is included
 * because a modal that traps a keyboard user is broken regardless of what was asked.
 *
 * `object-contain`, NOT `cover`. The card crops deliberately; this must not — a
 * viewer that crops the thing you opened it to see has no reason to exist.
 *
 * IT IS A PORTAL, AND THE FIRST VERSION WASN'T — corrected after measuring.
 *
 * That version said "not a portal, and that is a deliberate limit: `fixed inset-0`
 * with a high z-index escapes the canvas without one". `z-50` does not escape a
 * STACKING CONTEXT. This is rendered from a mockup card inside the run page's HUD
 * wrapper, which is `absolute … z-10`, so the backdrop's `z-50` was resolved WITHIN
 * that z-10 context and lost to the shell's `sticky top-0 z-20` header.
 *
 * Measured, not reasoned about: `elementFromPoint(15, 15)` returned the header's
 * div, so a click on the top strip never reached the backdrop and the image was drawn
 * under the nav. Clicks lower down closed it correctly, which is exactly the kind of
 * half-working that a spot check passes.
 *
 * `createPortal` to `document.body` puts it outside every app stacking context, so
 * `fixed inset-0` means the viewport and nothing can be painted over it. React state
 * and events still flow from the owning component — a portal moves the DOM node, not
 * the tree.
 */
export function Lightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
   * `document` IS NOT AVAILABLE DURING SSR. Next renders this component on the server
   * first, so the portal target has to be guarded — without the check the run page
   * throws `document is not defined` at build time.
   */
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // The backdrop IS the dismiss target. `onClick` here plus
      // `stopPropagation` on the figure is what makes "outside" mean outside.
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/90 p-6 backdrop-blur-sm"
    >
      <figure
        onClick={(event) => event.stopPropagation()}
        className="relative flex max-h-full max-w-full flex-col overflow-hidden rounded border border-line-strong bg-surface shadow-2xl"
      >
        <img
          src={src}
          alt={alt}
          className="block max-h-[calc(100vh-9rem)] max-w-[calc(100vw-6rem)] object-contain"
        />
        {caption !== undefined && caption !== "" && (
          <figcaption className="border-t border-line px-3 py-2 text-[12px] text-ink-dim">
            {caption}
          </figcaption>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-2 top-2 rounded-sm border border-line-strong bg-canvas/85 px-2 py-[2px] text-[13px] leading-none text-ink-dim backdrop-blur hover:text-ink"
        >
          ×
        </button>
      </figure>
    </div>,
    document.body,
  );
}
