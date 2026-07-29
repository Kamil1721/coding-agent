/**
 * design-lane.test.ts — the §6.5 predicate, and the reason it is not a boolean.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is "NO KEY DEGRADES, IT DOES NOT BLOCK — and
 * degraded is NOT off". A two-valued predicate cannot express spec §6.5's own
 * sentence ("If false, DESIGN degrades — it does not block"), and collapsing the
 * two is exactly how a lane that COULD NOT generate becomes indistinguishable
 * from a lane that had NOTHING to generate. That indistinguishability is the trap
 * this whole phase is designed against.
 *
 * The second load-bearing assertion is "the OFF decision is PURE". `shortlistFor`
 * fills `allowedAgents`, which feeds the `PreToolUse` delegation boundary, and
 * `surface.ts` states the rule: a boundary that can await or fail is not a
 * boundary. `designLaneMode` now depends transitively on `designPreflight`, which
 * spawns `npx` — so the fact that the capability half can only choose between
 * `full` and `degraded`, never `off`, is what keeps the boundary total. It is
 * asserted here rather than argued in a comment.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DesignCapability } from "./design-capability.js";
import { designLaneMode, designSurfaceGate, visualIntent } from "./design-lane.js";

const WITH_KEY: DesignCapability = {
  imageScript: "/scripts/gemini-image.sh",
  key: { available: true, source: "GEMINI_API_KEY" },
  video: false,
};
const NO_KEY: DesignCapability = {
  imageScript: "/scripts/gemini-image.sh",
  key: { available: false, source: null },
  video: false,
};

function mode(surface: Parameters<typeof designLaneMode>[0]["surface"], ticketText: string, capability = WITH_KEY) {
  return designLaneMode({ surface, ticketText, capability, preflightOk: true });
}

test("a pure web-ui ticket runs DESIGN with no visual-intent words at all (spec §6.5)", () => {
  // "The `|| surface === "web-ui"` term is deliberate: for a pure web-UI ticket
  // the deliverable IS the visual, and the standing motion bar applies whether or
  // not the ticket says design."
  assert.equal(mode("web-ui", "a page listing the last ten builds"), "full");
});

test("fullstack requires EXPLICIT visual intent — the admin CRUD carve-out", () => {
  // "`fullstack` requires explicit visual intent, so an internal admin CRUD
  // screen does not pay for five mockups."
  assert.equal(mode("fullstack", "an internal admin screen with an api for editing rows"), "off");
  assert.equal(mode("fullstack", "an api plus a landing page; make the design feel considered"), "full");
});

test("a non-visual surface never runs DESIGN", () => {
  for (const surface of ["api", "cli", "library", "background-jobs"] as const) {
    assert.equal(mode(surface, "make it beautiful, a gorgeous design"), "off");
  }
});

test("NO KEY DEGRADES, IT DOES NOT BLOCK — and degraded is NOT off", () => {
  // The whole point of the three-valued return. Spec §6.5: taste-frontend-expert
  // still art-directs; the gate falls back to rule-based scoring. If this ever
  // returns "off", a zero-image lane and a never-ran lane become the same thing.
  assert.equal(mode("web-ui", "a portfolio", NO_KEY), "degraded");
  assert.notEqual(mode("web-ui", "a portfolio", NO_KEY), "off");
});

test("a missing image SCRIPT degrades too — a key with nothing to spend it on is not `full`", () => {
  // detectDesignCapability reports `imageScript: null` when the script is not on
  // disk. That is the same observable as a missing key — zero PNGs — and it has
  // to reach the same three-valued answer, or a `full` lane is claimed for a
  // machine that cannot invoke a generator at all.
  assert.equal(mode("web-ui", "a portfolio", { ...WITH_KEY, imageScript: null }), "degraded");
});

test("a failed preflight degrades too — a lane that cannot generate must say so up front", () => {
  assert.equal(
    designLaneMode({ surface: "web-ui", ticketText: "a portfolio", capability: WITH_KEY, preflightOk: false }),
    "degraded",
  );
});

test("the OFF decision is PURE — no capability, no preflight, nothing that can await", () => {
  // shortlistFor feeds a permission boundary and surface.ts forbids one that can
  // fail. Everything that decides whether the DESIGN agents are shortlisted has
  // to be answerable from these two arguments alone.
  assert.equal(designSurfaceGate("web-ui", "a page"), true);
  assert.equal(designSurfaceGate("cli", "make it beautiful"), false);
  assert.equal(designSurfaceGate("fullstack", "an api and an admin screen"), false);
  for (const capability of [WITH_KEY, NO_KEY]) {
    for (const preflightOk of [true, false]) {
      const off = designLaneMode({ surface: "cli", ticketText: "a beautiful cli", capability, preflightOk });
      assert.equal(off, "off", "no capability state may turn a non-visual surface on, or a visual one off");
      // BOTH DIRECTIONS, because the message above claims both and the `cli` arm
      // alone only demonstrates one of them: a capability state must not be able
      // to switch a visual surface OFF either, which is the direction that would
      // delete the degraded lane's art direction.
      const on = designLaneMode({ surface: "web-ui", ticketText: "a page", capability, preflightOk });
      assert.notEqual(on, "off", "a visual surface stays on whatever the capability says");
    }
  }
});

test("visualIntent reads intent, not incidental words", () => {
  assert.equal(visualIntent("make the design feel considered, not templated"), true);
  assert.equal(visualIntent("art direction and a strong visual identity"), true);
  assert.equal(visualIntent("fix the database migration for the designs table"), false);
  assert.equal(visualIntent("redesign the checkout"), true);
});

test("visualIntent matches WHOLE WORDS — a substring hit buys five paid image generations", () => {
  // surface.ts's rule, applied here: `includes("ui")` matches "build". The cost of
  // a false positive on this predicate is not a wrong label, it is a `fullstack`
  // ticket paying for five metered Gemini calls it never asked for.
  assert.equal(visualIntent("redesigned the schema"), false, "`design` must not match inside a longer word");
  assert.equal(visualIntent("the brands table needs an index"), false);
  assert.equal(visualIntent("emotional support for the parser"), false, "`motion` is inside `emotional`");
  assert.equal(visualIntent("MAKE THE DESIGN CONSIDERED"), true, "case is not intent");
});
