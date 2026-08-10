/**
 * "253h 36m ago" — the run list's own words for a run from ten days ago.
 *
 * `formatRelative` handed everything to `formatDuration`, whose largest unit is
 * the hour, so any age past a day came out as a three-digit hour count. That is
 * not a rounding complaint: nobody reads 253 hours as "a week and a half", and
 * `/projects` had already given up and dated its rows absolutely, saying so in
 * its own comment.
 *
 * WHAT IS PINNED HERE. The three rungs, and the boundaries between them, from
 * FIXED instants — `nowMs` is a parameter of the function under test, so
 * nothing in this file depends on the wall clock and nothing can flake at
 * midnight. `formatDuration` is asserted alongside, unchanged, because the
 * cheapest way to "fix" this would have been to add days to IT and quietly
 * restate every run duration in the app.
 *
 * THE LAST RUNG IS LOCALE-DEPENDENT AND IS ASSERTED AS SUCH. It renders through
 * `toLocaleDateString`, so the token ORDER is the runner's business, not this
 * suite's. What is asserted is that both the day and the month are present and
 * that the string is no longer relative — which is the actual claim — rather
 * than a literal that would pin the harness's locale.
 */

import { expect, test } from "@playwright/test";

import { formatDuration, formatRelative } from "@/lib/format";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A fixed "now", so every case below is arithmetic and not a clock read. */
const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

test("under a day is unchanged, and still says how long", () => {
  expect(formatRelative(at(0), NOW)).toBe("just now");
  expect(formatRelative(at(30 * SECOND), NOW)).toBe("just now");
  expect(formatRelative(at(2 * MINUTE + 12 * SECOND), NOW)).toBe("2m 12s ago");
  expect(formatRelative(at(5 * HOUR + 12 * MINUTE), NOW)).toBe("5h 12m ago");
  // The last minute before the day rung.
  expect(formatRelative(at(DAY - MINUTE), NOW)).toBe("23h 59m ago");
});

test("a day or more counts days, not three-digit hours", () => {
  /*
   * THE CASE FROM THE MACHINE. 253h 36m is what the run list printed; it is
   * 10 days 13 hours, and the assertion below is the whole point of the change.
   */
  expect(formatDuration(253 * HOUR + 36 * MINUTE)).toBe("253h 36m");
  expect(formatRelative(at(253 * HOUR + 36 * MINUTE), NOW)).not.toContain("253h");

  expect(formatRelative(at(DAY), NOW)).toBe("1d 00h ago");
  expect(formatRelative(at(3 * DAY + 4 * HOUR), NOW)).toBe("3d 04h ago");
  expect(formatRelative(at(6 * DAY + 23 * HOUR), NOW)).toBe("6d 23h ago");
});

test("a week or more is a date, because nobody counts past seven", () => {
  const tenDays = formatRelative(at(10 * DAY + 13 * HOUR), NOW);
  expect(tenDays).not.toContain("ago");
  // 2026-08-09 minus 10 days is the 30th of July.
  expect(tenDays).toContain("30");
  expect(tenDays).toContain("Jul");
  // Same year, so no year token.
  expect(tenDays).not.toContain("2026");

  // A different year says which one.
  const lastYear = formatRelative(at(300 * DAY), NOW);
  expect(lastYear).toContain("2025");
});

test("`formatDuration` is untouched — a run that took hours still says hours", () => {
  expect(formatDuration(43 * MINUTE + 2 * SECOND)).toBe("43m 02s");
  expect(formatDuration(HOUR + 4 * MINUTE)).toBe("1h 04m");
  expect(formatDuration(61 * HOUR + 12 * MINUTE)).toBe("61h 12m");
});
