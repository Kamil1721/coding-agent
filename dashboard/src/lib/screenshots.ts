import { API_BASE } from "./api";

/**
 * Turn a screenshot `path` into something an `<img>` can load.
 *
 * `RunDetail.screenshots[].path` is an ABSOLUTE HOST PATH — a browser cannot
 * open it. The backend serves captures at one additive route,
 * `GET /api/runs/:id/screenshots/:file`, where `:file` is a single segment
 * resolved inside that run's own screenshot directory (see the header of
 * `server/src/http.ts`). So the URL is derived from the run id plus the
 * basename rather than the path being used directly.
 *
 * Every branch is a guess that can be wrong, which is why the caller renders
 * the raw path on `onError` instead of leaving a broken image frame. Order:
 *
 *   - an absolute http(s) URL            -> used as-is
 *   - `NEXT_PUBLIC_SCREENSHOT_BASE_URL`  -> joined to it, if set
 *   - a root-relative URL ("/api/…png")  -> resolved against the API origin
 *   - an absolute host path + a run id   -> the additive screenshots route
 *   - anything else                      -> null, and only the path is shown
 */
const SCREENSHOT_BASE: string = (
  process.env["NEXT_PUBLIC_SCREENSHOT_BASE_URL"] ?? ""
).replace(/\/+$/, "");

/** Last path segment, for POSIX and Windows separators alike. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== undefined && part !== "") return part;
  }
  return "";
}

/** True for something that looks like a URL path rather than a host path. */
function looksLikeUrlPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !/^\/(Users|home|var|tmp|private|opt|mnt|Volumes)\//.test(path)
  );
}

export function screenshotSrc(runId: string, path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  if (SCREENSHOT_BASE !== "") {
    return `${SCREENSHOT_BASE}/${trimmed.replace(/^\/+/, "")}`;
  }

  if (looksLikeUrlPath(trimmed)) return `${API_BASE}${trimmed}`;

  const file = basename(trimmed);
  if (file === "" || runId === "") return null;
  return `${API_BASE}/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(file)}`;
}
