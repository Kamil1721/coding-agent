/**
 * surface.ts — what kind of thing is this ticket asking for?
 *
 * WHY THIS MODULE EXISTS. `shortlistFor(surface)` fills `BuildRequest.allowedAgents`,
 * and that array IS the delegation boundary (`agent-shortlist.ts`, and the
 * `PreToolUse` hook in `builders/delegation-hook.ts` — NOT `canUseTool`, which
 * probe A measured is asked about no tool at all when the model delegates). So
 * this file does not merely route: it decides which specialists a build is
 * PERMITTED to START. It does not bound how much work each one receives; that is
 * why `SendMessage` is denied outright in the same hook.
 *
 * THE FAILURE IS ASYMMETRIC, AND THAT SHAPES EVERY DECISION BELOW.
 *   Too WIDE  — the orchestrator sees a few specialists it has no use for. It
 *               ignores them. Cost: a slightly noisier search space.
 *   Too NARROW — the orchestrator asks for a specialist, the hook denies it,
 *               and the lane produces nothing. Nothing reports this, because a
 *               lane that produced no output is indistinguishable from a lane
 *               that had nothing to do.
 * One of those is visible and cheap; the other is silent. So every uncertain case
 * resolves WIDER, and the fallback is `fullstack` — the widest set there is.
 *
 * WHY KEYWORDS AND NOT A MODEL. Classification runs before the build session
 * exists, on the path that builds a permission boundary. A boundary that awaits a
 * model call has a failure mode (timeout, quota, refusal) and a boundary with a
 * failure mode is not a boundary. Spec 6.5 asks for "a pure function of the
 * classification, testable without running a build"; this is the input half of
 * that. It is deliberately dumb and deliberately total.
 *
 * SCOPE. Spec 6.5 also defines additive `traits` (`db`, `container`, `auth`,
 * `existing-ui`, `python`) and the `visualIntent()` / `geminiKeyAvailable()` terms
 * that gate the DESIGN lane. None of those are Phase 1: nothing consumes a trait
 * yet, and `designLaneRuns()` in `agent-shortlist.ts` gates on surface alone until
 * Phase 2b gives DESIGN something to degrade. Surface is what `allowedAgents`
 * needs today, so surface is what this file provides.
 *
 * NO `mobile` MEMBER. Spec 11 item 8 records this as a known gap: every native
 * agent was dropped from the shortlist, so a `mobile` surface would classify
 * tickets into a lane set with no build agent in it — the silent-narrowing failure
 * above, by construction. It is added when `expo-react-native-expert` is
 * re-admitted, not before.
 */

import type { Surface } from "./agent-shortlist.js";

/**
 * Match a whole word (or an exact multi-word phrase), never a substring.
 *
 * `text.includes("cli")` matches "client" and "clip"; `includes("api")` matches
 * "rapidly" and "capital". Both mistakes route a plain web ticket to a shortlist
 * with no frontend agent in it, which then fails silently. The boundaries are
 * hand-rolled rather than `\b` because several patterns end in `.` or `-`
 * (`trigger.dev`, `command-line`) where `\b` behaves in ways that are easy to get
 * subtly wrong; `(?<![a-z0-9])`/`(?![a-z0-9])` says exactly what is meant.
 *
 * Called on FREE-FORM OWNER INPUT typed into a web form, so every pattern here is
 * a literal — the input is never compiled as a regex.
 */
function mentions(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const literal = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${literal}(?![a-z0-9])`, "u").test(text);
  });
}

/**
 * A recurring job or worker. Checked FIRST because it is the most specific claim a
 * ticket can make: "a trigger.dev cron that updates the landing page" is a job
 * that happens to touch a page, not a page.
 *
 * `webhook` is deliberately NOT here. It reads like a job word, but a webhook is
 * an inbound HTTP endpoint — it belongs to `api`, and putting it here would
 * classify "a webhook endpoint that writes to Postgres" as background-jobs and
 * hand the build no API specialist.
 *
 * NEITHER ARE `schedule`, `daily`, `recurring`, `worker`, `queue` or `ingest`,
 * and their absence is the whole tuning principle of this file. THIS SURFACE
 * DROPS ALL THREE FRONTEND BUILD AGENTS AND THE ENTIRE DESIGN LANE. Those six
 * are ordinary English that turns up constantly in web tickets — "a booking site
 * where users schedule appointments", "a landing page with a daily rotating
 * quote", "a service worker for offline support", "a print queue UI" — and each
 * one would route a ticket whose deliverable is a PAGE to a shortlist with
 * nobody in it who can write one. Every signal kept below either names a
 * technology (`cron`, `trigger.dev`, `etl`) or is a compound that cannot be
 * incidental (`background job`, `job queue`, `every night`). Pinned by "an
 * incidental job or terminal word does not strip a page ticket of its frontend
 * agents" in surface.test.ts.
 */
const BACKGROUND_JOBS = [
  "cron",
  "crontab",
  "trigger.dev",
  "triggerdev",
  "scheduled",
  "scheduler",
  "background job",
  "background jobs",
  "background task",
  "batch job",
  "job queue",
  "message queue",
  "pub/sub",
  "poller",
  "polling",
  "nightly",
  "hourly",
  "every hour",
  "every night",
  "etl",
] as const;

/**
 * A program run from a terminal.
 *
 * Also drops the frontend agents, so the same rule applies: `npx` is NOT a
 * signal. "Scaffold with npx create-next-app, then build the marketing page" is
 * a web ticket that happens to name a runner.
 */
const CLI = [
  "cli",
  "clis",
  "command-line",
  "command line",
  "commandline",
  "terminal app",
  "terminal tool",
  "tui",
  "shell script",
  "bash script",
  "argv",
  "stdin",
] as const;

/**
 * Something published for another program to import.
 *
 * A bare `library` is NOT a signal, on purpose. `library` is checked before `api`
 * and `web-ui`, so "a library website" or "a component library page" would land on
 * the narrow set and lose every frontend agent. The signals here all state
 * distribution, which is what actually distinguishes a library from any other pile
 * of code.
 *
 * A bare `sdk` is not one either, for the same reason: "a dashboard for the
 * Stripe SDK" is a dashboard. The compounds below say the SDK is the
 * DELIVERABLE rather than a dependency.
 */
const LIBRARY = [
  "npm package",
  "npm module",
  "node package",
  "publish to npm",
  "published to npm",
  "an sdk",
  "sdk for",
  "client sdk",
  "typescript sdk",
  "javascript sdk",
  "python sdk",
  "reusable package",
  "reusable module",
  "typescript library",
  "javascript library",
  "python package",
  "pypi",
] as const;

/**
 * A service reached over the network by something that is not a browser page.
 *
 * `rest` alone is an ordinary English word before it is a protocol — "tighten
 * the copy, the rest stays as-is" must fall through to the fallback, not
 * classify as a backend service. The compounds carry the protocol reading.
 */
const API = [
  "api",
  "apis",
  "rest api",
  "rest endpoint",
  "rest endpoints",
  "restful",
  "endpoint",
  "endpoints",
  "webhook",
  "webhooks",
  "graphql",
  "grpc",
  "openapi",
  "microservice",
  "microservices",
  "backend service",
  "route handler",
  "http service",
  "web service",
  "server that",
] as const;

/** Something a person looks at in a browser. */
const WEB_UI = [
  "page",
  "pages",
  "site",
  "website",
  "web app",
  "webapp",
  "landing",
  "portfolio",
  "ui",
  "frontend",
  "front-end",
  "front end",
  "dashboard",
  "component",
  "components",
  "layout",
  "responsive",
  "css",
  "tailwind",
  "react",
  "next.js",
  "nextjs",
  "hero section",
  "marketing page",
  "screen",
  "screens",
] as const;

/**
 * Classify a ticket into a `Surface`. Pure, synchronous, total.
 *
 * Check order is spec 6.5 verbatim: background-jobs -> cli -> library -> api ->
 * web-ui -> fullstack, most specific first, first match wins.
 *
 * THE ONE PLACE THE ORDER ALONE IS NOT ENOUGH is `api` versus `web-ui`. A ticket
 * naming both a page and an endpoint is a fullstack ticket, and a strict reading of
 * the order would return `api` for it — the narrow set, with no frontend agent, on
 * a ticket that explicitly asked for a page. So both branches carry the other's
 * negation. BOTH negations are load-bearing: guard only `api`, and the both-case
 * falls through to an unguarded `web-ui` branch and returns `web-ui` instead. That
 * would compile, read fine, and quietly drop the backend lane.
 *
 * Resolving the both-case to `fullstack` costs nothing in capability:
 * `shortlistFor("fullstack")` is a strict superset of both `api`'s and `web-ui`'s
 * (it keeps all 11 build agents and runs the DESIGN lane).
 */
export function classifySurface(ticketText: string): Surface {
  // Lowercased once. The classifier reads free text; case is never a signal, and
  // the alternative is 100 patterns each carrying an /i.
  const text = ticketText.toLowerCase();

  if (mentions(text, BACKGROUND_JOBS)) return "background-jobs";
  if (mentions(text, CLI)) return "cli";
  if (mentions(text, LIBRARY)) return "library";

  const isApi = mentions(text, API);
  const isWeb = mentions(text, WEB_UI);

  if (isApi && !isWeb) return "api";
  if (isWeb && !isApi) return "web-ui";

  // Both, or neither. Both IS fullstack. Neither means the ticket said nothing
  // this function recognises — "make it better" — and the rule there is the widest
  // set, never the narrowest and never an error, because under-delegation is the
  // failure nobody sees.
  return "fullstack";
}
