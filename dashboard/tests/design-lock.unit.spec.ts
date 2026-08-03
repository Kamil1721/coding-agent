/**
 * The two string facts the mockup cards rest on, neither of which is checkable
 * at runtime and both of which fail silently when wrong.
 *
 * FACT ONE: `designLock.locked` AND `designLock.mockups[].path` ARE DIFFERENT
 * PATHS TO THE SAME IMAGE. The orchestrator copies each design ref out of the
 * run's workspace into `results/screenshots/<runId>/design-<basename>`, because
 * that directory is the one `GET /api/runs/:id/screenshots/:file` serves; the
 * LOCK is taken on the workspace ref, because that is what the build agents and
 * the visual gate read. A `locked === shot.path` comparison therefore finds
 * nothing on a run that definitely locked something — no card is distinguished,
 * no error appears anywhere, and the page quietly says the opposite of the
 * record. That is the failure these tests exist for, and `PREFIX-ADD, NOT STRIP`
 * below is the half of it that a plausible implementation gets wrong.
 *
 * FACT TWO: A RESOLVED LOCK MUST NOT RENDER AS A PENDING ONE. `status` arrives
 * over SSE and `designLock` only on the next REST read, so the two disagree for
 * up to one poll interval every time a park ends — and `{awaiting: true,
 * locked: null}` is byte-identical to a lane that produced nothing to lock. The
 * phase derivation is the only thing keeping "a choice is being recorded" apart
 * from "there was nothing to choose".
 *
 * No browser: these are pure functions of their arguments.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import type { DesignDirectionState, DesignLockState, Screenshot } from "../src/lib/api-types";
import {
  MAX_DESIGN_LOCK_TURNS,
  MAX_DESIGN_ON_DEMAND_RENDERS,
  designCapIn,
} from "./fixtures/design-caps";
import {
  MOCKUP_LABEL,
  countOf,
  designLockPhase,
  directionsOf,
  groupReferences,
  isPublishedAs,
  lockedMockup,
  mockupSection,
  requestsOf,
  stageOf,
} from "../src/lib/mockups";

const WORKSPACE = "/Users/o/.dashboard/runs/run-7/workspace/design-refs";
const PUBLISHED = "/Users/o/.dashboard/results/screenshots/run-7";

function shot(file: string, section: string): Screenshot {
  return {
    path: `${PUBLISHED}/${file}`,
    label: `${MOCKUP_LABEL}${section}`,
    capturedAt: "2026-07-29T11:04:05.000Z",
  };
}

const MOCKUPS: readonly Screenshot[] = [
  shot("design-01-hero.png", "hero"),
  shot("design-02-work.png", "selected work"),
  shot("design-03-about.png", "about"),
];

function lock(overrides: Partial<DesignLockState>): DesignLockState {
  return {
    awaiting: false,
    mockups: MOCKUPS,
    locked: null,
    lockedBy: null,
    reason: null,
    directions: [],
    chosenDirection: null,
    chosenDirectionBy: null,
    stage: "none",
    turnsUsed: 0,
    // THE CAPS THE SERVER SENDS, NOT THE ONES THIS FILE REMEMBERS. `turnsMax: 4`
    // was written here by hand and stayed green through `MAX_DESIGN_LOCK_TURNS`
    // moving to 8 — a fixture inventing the number it is testing describes a wire
    // shape that no longer exists, and it is the reason the drift was invisible.
    turnsMax: MAX_DESIGN_LOCK_TURNS,
    rendersUsed: 0,
    rendersMax: MAX_DESIGN_ON_DEMAND_RENDERS,
    requests: [],
    ...overrides,
  };
}

/**
 * THE LOCK AS THE THREE RECORDED RUNS ACTUALLY SEND IT: five keys, none of the
 * nine added on 2026-08-03.
 *
 * THE ASSERTION IS A LIE THE TYPE TELLS, AND IT IS THE POINT. `lib/api.ts` casts
 * every response with `parsed as T` and validates nothing, so `DesignLockState`
 * describes a body no recorded run answers with. Every reader below is measured
 * against the real bytes rather than against a fixture that fills the gaps in;
 * without the cast this shape cannot even be written down, which is exactly how
 * the crash it guards against gets shipped.
 */
const legacyLock = {
  awaiting: true,
  mockups: MOCKUPS,
  locked: null,
  lockedBy: null,
  reason: null,
} as DesignLockState;

/* ---- which card is the locked one -------------------------------- */

test("the published copy of a workspace ref is recognised as that ref", () => {
  expect(isPublishedAs(`${PUBLISHED}/design-02-work.png`, `${WORKSPACE}/02-work.png`)).toBe(true);
  // And not as a different ref that merely shares a directory.
  expect(isPublishedAs(`${PUBLISHED}/design-02-work.png`, `${WORKSPACE}/01-hero.png`)).toBe(false);
});

test("PREFIX-ADD, NOT STRIP: an UNPREFIXED file of the same name is not the copy", () => {
  // THE DISCRIMINATING CASE, and it took a failed negative control to find it.
  // Cutting `design-` off the published basename and comparing looks equivalent
  // to building the copy's name and comparing — and for every prefixed input it
  // provably IS: `p.slice(7) === ref` and `p === "design-" + ref` agree whenever
  // `p` starts with the prefix. They part company on a file that does NOT carry
  // it, and `results/screenshots/<runId>/` is a FLAT directory holding gate
  // captures beside the mockup copies. A gate capture named `hero.png`, sitting
  // next to the copy `design-hero.png` of a ref named `hero.png`, is a different
  // image of a different thing — and a strip-based reader badges it as the
  // locked design. That is the wrong claim, made silently, on the one panel
  // whose entire job is saying which design was built.
  expect(isPublishedAs(`${PUBLISHED}/hero.png`, `${WORKSPACE}/hero.png`)).toBe(false);

  // And the prefix is added ONCE, not searched for: a ref genuinely called
  // `design-hero.png` is published as `design-design-hero.png`. This line is
  // what an `endsWith`/`includes` implementation fails.
  const ref = `${WORKSPACE}/design-hero.png`;
  expect(isPublishedAs(`${PUBLISHED}/design-design-hero.png`, ref)).toBe(true);
  expect(isPublishedAs(`${PUBLISHED}/design-hero.png`, ref)).toBe(false);
});

test("an exact ref path still matches, for a caller that holds one", () => {
  expect(isPublishedAs(`${WORKSPACE}/01-hero.png`, `${WORKSPACE}/01-hero.png`)).toBe(true);
});

test("lockedMockup finds the card, and finds nothing rather than the wrong card", () => {
  const found = lockedMockup(lock({ locked: `${WORKSPACE}/02-work.png`, lockedBy: "owner" }));
  expect(found?.path).toBe(`${PUBLISHED}/design-02-work.png`);

  // A lock on a ref that was never published distinguishes NO card. The panel
  // says so in words; what it must never do is badge a neighbour.
  expect(lockedMockup(lock({ locked: `${WORKSPACE}/09-ghost.png`, lockedBy: "owner" }))).toBe(null);
  expect(lockedMockup(lock({ locked: null }))).toBe(null);
});

/* ---- which state the panel is in --------------------------------- */

test("parked right now is `pending` — the only phase that renders a button", () => {
  expect(designLockPhase("awaiting_input", lock({ awaiting: true }))).toBe("pending");
});

test("a recorded choice is `settled` even while a stale park record says otherwise", () => {
  // `settled` is tested FIRST inside the derivation, and this is why: the park
  // record and the lock live in the same file, so a reader that asked `awaiting`
  // first would repaint a locked run as still asking for a click.
  expect(
    designLockPhase("awaiting_input", lock({ awaiting: true, locked: `${WORKSPACE}/01-hero.png` })),
  ).toBe("settled");
  expect(designLockPhase("passed", lock({ locked: `${WORKSPACE}/01-hero.png` }))).toBe("settled");
});

test("the timeout's window is `closing`, NOT `unlocked` — they mean opposite things", () => {
  // The server locks automatically and moves the run to `queued`; that status
  // arrives over SSE while the lock record is still the cached one. Same bytes
  // as a lane that locked nothing, opposite meaning.
  expect(designLockPhase("queued", lock({ awaiting: true }))).toBe("closing");
  expect(designLockPhase("running", lock({ awaiting: true }))).toBe("closing");
  expect(designLockPhase("passed", lock({ awaiting: false }))).toBe("unlocked");
});

test("stage B is `expanding`, which is NOT `unlocked`", () => {
  // Between the direction choice and the hero lock the record reads
  // `{awaiting:false, locked:null}` for the whole of stage B — a full
  // per-section render, minutes long — and that shape used to derive
  // `unlocked`, whose panel copy is "The DESIGN lane finished without a design
  // to lock". `stage` is the only field that tells the two apart.
  expect(
    designLockPhase("queued", lock({ stage: "expanding", chosenDirection: "terminal-grid" })),
  ).toBe("expanding");
  // And a locked run is still `settled` whatever the stage says: the lock is the
  // fact with evidence behind it.
  expect(
    designLockPhase("passed", lock({ stage: "expanding", locked: `${WORKSPACE}/01-hero.png` })),
  ).toBe("settled");
});

/* ---- the nine fields no recorded run sends ----------------------- */

test("a five-key lock from a recorded run reads as a pre-canvass run, not a crash", () => {
  // `lock.directions.length` on this body is a TypeError inside a render, which
  // is a blank run page rather than a failed assertion. These three readers are
  // what every consumer goes through.
  expect(directionsOf(legacyLock)).toEqual([]);
  expect(requestsOf(legacyLock)).toEqual([]);
  expect(stageOf(legacyLock)).toBe("none");
  expect(designLockPhase("awaiting_input", legacyLock)).toBe("pending");
});

test("an absent counter reads 0, never `unlimited`", () => {
  // A falsy absent cap that read as "no limit" would draw a live ask box on a
  // park that has no renders left, and the owner would find out by being
  // refused — which is the whole failure the caps are on screen to prevent.
  expect(countOf(legacyLock.rendersMax)).toBe(0);
  expect(countOf(3)).toBe(3);
  expect(countOf(null)).toBe(0);
});

/* ---- the caps, read off the server rather than remembered -------- */

test("THE CAPS COME FROM THE SERVER'S SOURCE, and the extractor is proved to fail", () => {
  /*
   * WHAT WENT WRONG WITHOUT THIS. Every fixture in this suite built its own lock
   * with `turnsMax: 4` in it. The server moved `MAX_DESIGN_LOCK_TURNS` to 8 and
   * `http.ts` began sending 8; nothing here went red, and the browser spec next
   * door asserted the panel's sentence — "4 of 4 turns left" — against a body no
   * run answers with. The value is now read off `server/src/design-prompt.ts`.
   *
   * AND A READER THAT HAS ONLY EVER BEEN OBSERVED MATCHING IS NOT A CHECK. The
   * three mutations below are applied to in-memory copies of the real source, and
   * each must throw: a renamed declaration, a value that is no longer a literal,
   * and a declaration that is not exported at all. Without them, an anchor that
   * silently stopped matching would take a default nobody notices.
   */
  const real = readFileSync(join(__dirname, "..", "server", "src", "design-prompt.ts"), "utf8");
  expect(designCapIn(real, "MAX_DESIGN_LOCK_TURNS")).toBe(MAX_DESIGN_LOCK_TURNS);
  expect(MAX_DESIGN_LOCK_TURNS).toBeGreaterThan(0);
  // The server's own invariant, which the panel's arithmetic depends on: every
  // render also spends a turn, so a turn cap at or below the render cap would
  // make `rendersMax` a number the owner is told and cannot reach.
  expect(MAX_DESIGN_LOCK_TURNS).toBeGreaterThan(MAX_DESIGN_ON_DEMAND_RENDERS);

  expect(() => designCapIn(real.replace("MAX_DESIGN_LOCK_TURNS = ", "MAX_DESIGN_PARK_TURNS = "), "MAX_DESIGN_LOCK_TURNS")).toThrow(
    /was not found/,
  );
  expect(() =>
    designCapIn(
      real.replace(
        `MAX_DESIGN_LOCK_TURNS = ${String(MAX_DESIGN_LOCK_TURNS)};`,
        'MAX_DESIGN_LOCK_TURNS = Number(process.env["DASHBOARD_DESIGN_TURNS"] ?? 4);',
      ),
      "MAX_DESIGN_LOCK_TURNS",
    ),
  ).toThrow(/was not found/);
  expect(() => designCapIn(real.replace("export const MAX_DESIGN_LOCK_TURNS", "const MAX_DESIGN_LOCK_TURNS"), "MAX_DESIGN_LOCK_TURNS")).toThrow(
    /was not found/,
  );
});

test("the fixtures in this file carry the caps the server sends", () => {
  // The binding above buys nothing if a fixture goes back to a literal. This is
  // the one assertion that fails when it does.
  expect(lock({}).turnsMax).toBe(MAX_DESIGN_LOCK_TURNS);
  expect(lock({}).rendersMax).toBe(MAX_DESIGN_ON_DEMAND_RENDERS);
});

test("an unknown stage reads `none` rather than being trusted", () => {
  // Wire values are cast, not validated. `none` is the branch that renders the
  // pre-canvass panel, which is the safe reading of a value this build has never
  // heard of.
  expect(stageOf({ ...lock({}), stage: "brand-new-stage" } as unknown as DesignLockState)).toBe(
    "none",
  );
});

/* ---- three kinds of reference under one old heading -------------- */

test("references group by what each still IS, and an old run keeps one group", () => {
  const chosenShots = [MOCKUPS[0], MOCKUPS[1]].filter((shot): shot is Screenshot => shot !== undefined);
  const discardedShots = [MOCKUPS[2]].filter((shot): shot is Screenshot => shot !== undefined);
  const requestedShot = shot("design-04-req-contact.png", "contact");

  const directions: readonly DesignDirectionState[] = [
    {
      slug: "kept",
      name: "Kept",
      distinction: "the one that was built",
      discarded: false,
      mockups: chosenShots.map((entry) => entry.path),
      notes: null,
    },
    {
      slug: "dropped",
      name: "Dropped",
      distinction: "offered and not built",
      discarded: true,
      mockups: discardedShots.map((entry) => entry.path),
      notes: null,
    },
  ];

  const grouped = groupReferences(
    [...chosenShots, ...discardedShots, requestedShot],
    lock({
      mockups: [...MOCKUPS, requestedShot],
      directions,
      chosenDirection: "kept",
      requests: [
        {
          at: "2026-08-03T10:00:00.000Z",
          section: "contact",
          direction: "kept",
          outcome: "rendered",
          detail: "",
          mockup: requestedShot.path,
        },
      ],
    }),
  );

  expect(grouped.built.map((entry) => entry.path)).toEqual(chosenShots.map((entry) => entry.path));
  // THE CLAIM THIS SPLIT EXISTS TO STOP. A discarded direction under the heading
  // "the mockups the run was built to" says the run was made to a design it was
  // never graded against.
  expect(grouped.offered.map((entry) => entry.path)).toEqual(
    discardedShots.map((entry) => entry.path),
  );
  expect(grouped.requested.map((entry) => entry.path)).toEqual([requestedShot.path]);
  expect(grouped.ungrouped).toEqual([]);

  // AND THE OLD RUNS: no directions, so everything stays in the one group whose
  // heading is the original sentence, word for word.
  const legacy = groupReferences(MOCKUPS, legacyLock);
  expect(legacy.ungrouped).toEqual(MOCKUPS);
  expect(legacy.built).toEqual([]);
  expect(legacy.offered).toEqual([]);
  expect(legacy.requested).toEqual([]);
});

/* ---- the label is the only place a section reaches the browser ---- */

test("the section is read off the label, and an unknown label survives whole", () => {
  expect(mockupSection(`${MOCKUP_LABEL}selected work`)).toBe("selected work");
  // FAILS SOFT. Nothing on the wire carries this prefix, so a server-side rename
  // cannot be detected here — it must degrade to showing the whole label rather
  // than to showing an empty card title.
  expect(mockupSection("gate capture — home at 1440")).toBe("gate capture — home at 1440");
  expect(mockupSection(MOCKUP_LABEL)).toBe(MOCKUP_LABEL);
});
