/**
 * surface.test.ts — the ticket-surface classifier (Phase 1 Task 5, spec 6.5).
 *
 * WHAT THIS PROTECTS. `shortlistFor(surface)` is what fills `allowedAgents`, and
 * `allowedAgents` is the delegation boundary. So a misclassification is not a
 * cosmetic routing miss: it decides which specialists the build is permitted to
 * reach at all, and the failure is SILENT in one direction. Too narrow a surface
 * means the orchestrator asks for an agent, `canUseTool` denies it, and the lane
 * produces nothing — indistinguishable from a lane that had nothing to do.
 *
 * That asymmetry is why the last test here is as load-bearing as the first: an
 * unrecognisable ticket must fall back to `fullstack`, the WIDEST lane set, never
 * to a narrow one and never to an error.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shortlistFor } from "./agent-shortlist.js";
import { classifySurface } from "./surface.js";

test("worked cases from the spec", () => {
  assert.equal(classifySurface("Build me a CLI that renames files by EXIF date"), "cli");
  assert.equal(classifySurface("Portfolio site for a photographer, should feel expensive"), "web-ui");
  assert.equal(classifySurface("Add a webhook endpoint that writes to Postgres"), "api");
  assert.equal(classifySurface("A scheduled trigger.dev task that syncs hourly"), "background-jobs");
  assert.equal(classifySurface("Publish an npm package that parses ISO dates"), "library");
});

test("first match wins, most specific first", () => {
  // Names both a page and an endpoint -> fullstack, not web-ui.
  assert.equal(classifySurface("a dashboard page plus a REST endpoint for it"), "fullstack");
  // Names trigger.dev AND a page -> background-jobs is more specific.
  assert.equal(classifySurface("a trigger.dev cron that updates the landing page"), "background-jobs");
});

test("an unrecognisable ticket falls back to the widest lane set, never to nothing", () => {
  assert.equal(classifySurface("make it better"), "fullstack");
});

test("the api/web-ui pair resolves BOTH ways to fullstack, not just one", () => {
  // The `!webSignal` guard on the api branch and the `!apiSignal` guard on the
  // web-ui branch are two separate conditions. Guard only one and the both-case
  // falls through to whichever branch is still unguarded — which compiles, reads
  // fine, and quietly returns the narrower surface. Ordering the ticket's clauses
  // the other way round is what catches that.
  assert.equal(classifySurface("a REST endpoint plus a dashboard page for it"), "fullstack");
  assert.equal(classifySurface("a Next.js landing page backed by a GraphQL API"), "fullstack");
});

test("classification never throws and never returns something outside the union", () => {
  // It runs on FREE-FORM OWNER INPUT typed into a web form. Empty, huge,
  // punctuation-only and regex-shaped strings all reach it.
  const surfaces = new Set(["web-ui", "fullstack", "api", "cli", "library", "background-jobs"]);
  for (const t of ["", "   ", "\n\n", "(.*)+$", "?".repeat(5000), "CLI".repeat(2000)]) {
    const s = classifySurface(t);
    assert.ok(surfaces.has(s), `"${t.slice(0, 12)}…" -> ${s}`);
  }
});

test("every surface it can return yields a usable shortlist", () => {
  // The classifier and the shortlist are one mechanism: the only reason to name a
  // surface is to hand it to `shortlistFor`. A surface that classified cleanly but
  // produced an unusable set would be a boundary bug wearing a routing bug's face.
  for (const ticket of [
    "Build me a CLI that renames files by EXIF date",
    "Portfolio site for a photographer, should feel expensive",
    "Add a webhook endpoint that writes to Postgres",
    "A scheduled trigger.dev task that syncs hourly",
    "Publish an npm package that parses ISO dates",
    "make it better",
  ]) {
    const n = shortlistFor(classifySurface(ticket)).length;
    assert.ok(n >= 8 && n <= 30, `"${ticket}": ${String(n)} agents is outside 8..30`);
  }
});

test("the fallback is the WIDEST set, not merely a set", () => {
  // "Never to nothing" is the stated rule, but a fallback that is narrower than
  // some other surface would still under-delegate silently. `fullstack` must
  // dominate every other surface's shortlist.
  const fallback = new Set(shortlistFor(classifySurface("make it better")));
  for (const surface of ["web-ui", "api", "cli", "library", "background-jobs"] as const) {
    for (const agent of shortlistFor(surface)) {
      assert.ok(fallback.has(agent), `fallback is missing ${agent}, shortlisted for ${surface}`);
    }
  }
});

test("case and punctuation do not decide the surface", () => {
  assert.equal(classifySurface("BUILD ME A CLI THAT RENAMES FILES"), "cli");
  assert.equal(classifySurface("build me a cli that renames files"), "cli");
});

test("an incidental job or terminal word does not strip a page ticket of its frontend agents", () => {
  // THE ASYMMETRY, AS AN INVARIANT RATHER THAN A COMMENT. `background-jobs` and
  // `cli` drop all three frontend build agents AND the whole DESIGN lane. So a
  // signal list containing ordinary English — "schedule", "daily", "recurring",
  // "worker", "queue", "npx" — silently routes a ticket whose deliverable is a
  // PAGE to a shortlist with nobody in it who can write one. The keyword lists
  // are tuned against this test, not against a dictionary.
  for (const ticket of [
    "a booking site where users schedule appointments",
    "a landing page with a daily rotating quote",
    "a pricing page for recurring subscriptions",
    "add a service worker for offline support to the marketing site",
    "a print queue UI",
    "scaffold with npx create-next-app, then build the marketing page",
  ]) {
    assert.ok(
      shortlistFor(classifySurface(ticket)).includes("nextjs-developer"),
      `"${ticket}" -> ${classifySurface(ticket)}, which has no frontend build agent`,
    );
  }
});

test("a ticket with no real signal falls back, and 'the rest' is not an API", () => {
  // `rest` is an ordinary English word before it is a protocol.
  assert.equal(classifySurface("tighten the copy, the rest stays as-is"), "fullstack");
});

test("a word that merely CONTAINS a keyword is not a match", () => {
  // "cli" inside "client", "api" inside "rapidly". Substring matching here would
  // route a plain web ticket to a shortlist with no frontend agents in it.
  assert.equal(classifySurface("a client-facing marketing page, built rapidly"), "web-ui");
});
