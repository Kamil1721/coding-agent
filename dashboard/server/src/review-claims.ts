/**
 * Pure, host-side claim vocabulary shared by planning and Context7 review.
 *
 * The planning model may name a package and an expected version. It may not
 * author an MCP query: the host turns these bounded fields into the fixed,
 * non-sensitive query purpose used by the review runner.
 */

const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const WILDCARD_VERSION = /^v?\d+\.(?:[xX*]|\d+\.[xX*])$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

export function isSupportedReviewVersionRange(value: string): boolean {
  const range = value.trim();
  if (/^v?\d+$/u.test(range) || WILDCARD_VERSION.test(range) || EXACT_VERSION.test(range)) return true;
  if (!range.startsWith("^") && !range.startsWith("~")) return false;
  return /^v?\d+\.\d+\.\d+$/u.test(range.slice(1));
}

export function isReviewPackageName(value: string): boolean {
  return value === value.trim() && PACKAGE.test(value);
}

function versionFrom(value: string): string | null {
  const version = value.trim();
  return isSupportedReviewVersionRange(version) ? version : null;
}

/** Package-manifest versions use the same bounded vocabulary as planner rows. */
export function reviewVersionOrNull(raw: string): string | null {
  return versionFrom(raw);
}
