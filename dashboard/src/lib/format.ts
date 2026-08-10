/**
 * Formatting helpers.
 *
 * Every one of these is only ever called on wire data, and wire data is never
 * present during the server prerender (SWR has no `fallbackData`), so
 * locale- and timezone-dependent output cannot cause a hydration mismatch.
 */

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return Math.round(value).toLocaleString();
}

/** Compact token counts: 1.24M, 18.3k, 942. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return "n/a";
  return `${(fraction * 100).toFixed(digits)}%`;
}

function parseIso(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function formatClock(iso: string): string {
  const ms = parseIso(iso);
  if (ms === null) return iso;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatTimeOnly(iso: string): string {
  const ms = parseIso(iso);
  if (ms === null) return iso;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** `1h 04m`, `4m 12s`, `9.2s`, `340ms`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `4m 12s` between two instants, or null if either is unparseable. */
export function elapsedBetween(
  startedAt: string,
  endedAt: string | null,
  nowMs: number,
): number | null {
  const start = parseIso(startedAt);
  if (start === null) return null;
  const end = endedAt === null ? nowMs : parseIso(endedAt);
  if (end === null) return null;
  return Math.max(0, end - start);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Past this, a relative age stops being a useful way to say when. */
const CALENDAR_AFTER_MS = 7 * DAY_MS;

/**
 * How long ago, in the largest unit that is still a number a reader can hold.
 *
 * WHAT THIS FIXES. It used to hand everything to `formatDuration`, whose top
 * rung is hours, so the run list printed **"253h 36m ago"** — a real string off
 * this machine, and one nobody can read as "ten and a half days" without doing
 * arithmetic. `/projects` had already worked around it in prose ("`formatRelative`
 * tops out in hours — the one real folder here reads '69h 55m ago'") and dated
 * its rows absolutely instead. That workaround stays correct on its own terms
 * and is now a choice rather than a forced move.
 *
 * THREE RUNGS, AND THE LAST ONE STOPS BEING RELATIVE ON PURPOSE:
 *
 *   under a day    — unchanged. `formatDuration` already reads well here
 *     ("43m 02s ago", "5h 12m ago") and this is the range the dashboard is
 *     actually watched in.
 *   under a week   — days and hours: "10d 13h ago". Still countable at a
 *     glance, and it is the range where "how long has it been" is the question.
 *   a week or more — the DATE. Past seven days nobody converts "23d ago" into
 *     a day of the week; they want to know it was the 30th. The year is added
 *     only when it differs from today's, so the common case stays two tokens.
 *
 * `formatDuration` IS DELIBERATELY NOT CHANGED. It also formats how long a run
 * TOOK, where hours are the right ceiling and a run measured in days is a
 * pathology worth seeing as `61h 12m` rather than smoothed into `2d 13h`.
 */
export function formatRelative(iso: string, nowMs: number): string {
  const ms = parseIso(iso);
  if (ms === null) return iso;
  const delta = nowMs - ms;
  // A clock skew between the server's stamp and the browser's is not an event.
  if (delta < 0) return "just now";
  if (delta < 45_000) return "just now";
  if (delta < DAY_MS) return `${formatDuration(delta)} ago`;

  if (delta < CALENDAR_AFTER_MS) {
    const days = Math.floor(delta / DAY_MS);
    const hours = Math.floor((delta % DAY_MS) / HOUR_MS);
    return `${String(days)}d ${String(hours).padStart(2, "0")}h ago`;
  }

  const then = new Date(ms);
  const sameYear = then.getFullYear() === new Date(nowMs).getFullYear();
  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** `2h 14m 03s` — for a retry-after countdown, which can be hours. */
export function formatCountdown(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "now";
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** First non-empty line, trimmed and capped — used as a ticket title fallback. */
export function firstLine(text: string, max = 90): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Shorten a long filesystem path from the left: `…/results/run-7/artifact`. */
export function shortenPath(path: string, max = 64): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - (max - 1))}`;
}
