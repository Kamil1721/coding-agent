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

import { expect, test } from "@playwright/test";

import type { DesignLockState, Screenshot } from "../src/lib/api-types";
import {
  MOCKUP_LABEL,
  designLockPhase,
  isPublishedAs,
  lockedMockup,
  mockupSection,
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
    ...overrides,
  };
}

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

/* ---- the label is the only place a section reaches the browser ---- */

test("the section is read off the label, and an unknown label survives whole", () => {
  expect(mockupSection(`${MOCKUP_LABEL}selected work`)).toBe("selected work");
  // FAILS SOFT. Nothing on the wire carries this prefix, so a server-side rename
  // cannot be detected here — it must degrade to showing the whole label rather
  // than to showing an empty card title.
  expect(mockupSection("gate capture — home at 1440")).toBe("gate capture — home at 1440");
  expect(mockupSection(MOCKUP_LABEL)).toBe(MOCKUP_LABEL);
});
