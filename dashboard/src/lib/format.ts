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

export function formatRelative(iso: string, nowMs: number): string {
  const ms = parseIso(iso);
  if (ms === null) return iso;
  const delta = nowMs - ms;
  if (delta < 0) return "just now";
  if (delta < 45_000) return "just now";
  return `${formatDuration(delta)} ago`;
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
