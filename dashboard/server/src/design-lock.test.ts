import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesignManifest } from "./design-manifest.js";
import {
  DEFAULT_DESIGN_LOCK_TIMEOUT_MIN,
  DESIGN_LOCK_RECORD_FILE,
  chooseDirection,
  chosenMockupRef,
  designLockExpired,
  designLockPolicy,
  designLockTimeoutMin,
  directionForMockup,
  emptyDesignLockRecord,
  fallbackChoice,
  fallbackDirectionChoice,
  lockManifest,
  publishedMockupPath,
  readChoiceFile,
  readDesignLock,
  readDirectionChoiceFile,
  writeDesignLock,
} from "./design-lock.js";
import { DESIGN_DIRECTION_CHOICE_FILE } from "./design-prompt.js";

const WS = "/runs/r1/workspace";
const A = `${WS}/design-refs/01-hero.png`;
const B = `${WS}/design-refs/02-work.png`;
const AT = "2026-07-29T10:00:00.000Z";

const MANIFEST: DesignManifest = {
  version: 1,
  refs: [
    { path: A, section: "hero", aspect: "21:9", intent: "opening", direction: null, origin: null },
    { path: B, section: "work", aspect: "16:9", intent: "projects", direction: null, origin: null },
  ],
  directions: [],
  chosenDirection: null,
  directionChoice: null,
  lockedMockup: null,
  lockedBy: null,
  lockedReason: null,
  lockedAt: null,
};

test("RULE 2: a non-interactive request defaults to auto — a cron run never parks", () => {
  // "A scheduled run that parks forever waiting for a click is the exact failure
  // unattended operation exists to avoid."
  assert.equal(designLockPolicy(undefined, false), "auto");
  assert.equal(designLockPolicy(null, false), "auto");
  assert.equal(designLockPolicy("ask", false), "ask", "an EXPLICIT ask is still honoured");
  assert.equal(designLockPolicy(undefined, true), "ask", "an interactive request may pause");
  assert.equal(designLockPolicy("nonsense", false), "auto", "an unknown value is not an error, it is auto");
});

test("RULE 1: the timeout is finite, configurable, and never zero or infinite", () => {
  assert.equal(designLockTimeoutMin({}), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "5" }), 5);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "-1" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "nope" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
});

test("RULE 1: expiry is computed from the park time, so a server restart cannot make a park infinite", () => {
  assert.equal(designLockExpired(AT, "2026-07-29T10:29:00.000Z", 30), false);
  assert.equal(designLockExpired(AT, "2026-07-29T10:31:00.000Z", 30), true);
  assert.equal(designLockExpired("not a date", "2026-07-29T10:31:00.000Z", 30), true, "an unreadable park time expires");
});

test("RULE 4: a lock without a chooser and a reason cannot be constructed", () => {
  const locked = lockManifest(MANIFEST, { path: A, by: "owner", reason: "the type is doing the work", at: AT });
  assert.equal(locked.ok, true);
  assert.ok(locked.ok && locked.manifest.lockedMockup === A);
  assert.ok(locked.ok && locked.manifest.lockedBy === "owner");
  assert.ok(locked.ok && locked.manifest.lockedReason === "the type is doing the work");
  assert.ok(locked.ok && locked.manifest.lockedAt === AT);

  const empty = lockManifest(MANIFEST, { path: A, by: "owner", reason: "   ", at: AT });
  assert.equal(empty.ok, false, "an unattended run must be explainable after the fact");
});

test("a chosen path that is not one of the refs is REFUSED", () => {
  // The path arrives from an HTTP body and from an agent-written file. Either
  // could name ~/.gemini/api_key, and the locked path is injected into every
  // build prompt and Read by the visual gate.
  const forged = lockManifest(MANIFEST, { path: `${WS}/design-refs/99.png`, by: "owner", reason: "x", at: AT });
  assert.equal(forged.ok, false);
  assert.match(String(!forged.ok && forged.error), /not one of/iu);
  assert.equal(lockManifest(MANIFEST, { path: "/etc/passwd", by: "owner", reason: "x", at: AT }).ok, false);
});

/* -------------------------------------------------------------------------
 * THE TRANSLATION THAT MAKES A CLICK LOCKABLE
 *
 * `lockManifest` accepts a workspace ref by exact equality, and the only mockup
 * path any client can send is the PUBLISHED COPY (`designLock.mockups[].path`,
 * which is what the screenshot route serves). `chosenMockupRef` is the one
 * mapping between them, and everything below is about the two directions it must
 * NOT be loose in.
 * ---------------------------------------------------------------------- */

const SHOTS = "/results/screenshots/r1";

test("a click on a published card resolves to the ref, and THAT is what locks", () => {
  const published = `${SHOTS}/design-02-work.png`;
  assert.equal(publishedMockupPath(SHOTS, B), published, "this is the path #recordDesignMockups writes");
  assert.notEqual(published, B, "the two strings differ, which is why a translation has to exist at all");

  const ref = chosenMockupRef(MANIFEST, SHOTS, published);
  assert.equal(ref, B);
  const locked = lockManifest(MANIFEST, { path: ref, by: "owner", reason: "chosen", at: AT });
  assert.equal(locked.ok, true, "the published copy the wire carries now reaches a lock");
  // AND THE LOCK IS ON THE WORKSPACE REF, not the served copy: that is the path
  // the build agents and the visual gate `Read`.
  assert.ok(locked.ok && locked.manifest.lockedMockup === B);
});

test("a ref passes through unchanged — the host's own choosers are not translated", () => {
  // `readChoiceFile`, `fallbackChoice` and `reconcileOnBoot` all produce refs.
  assert.equal(chosenMockupRef(MANIFEST, SHOTS, A), A);
  assert.equal(chosenMockupRef(MANIFEST, SHOTS, B), B);
});

test("a path that is NEITHER survives unchanged, so lockManifest still refuses it", () => {
  // THE SECURITY PROPERTY. The locked path is injected into every build prompt
  // and `Read` by the visual gate, so an arbitrary path must never become the
  // gate's reference. The translation maps one exact string to one exact string;
  // it may not become a substring or basename match.
  for (const forged of [
    "/etc/passwd",
    `${SHOTS}/design-99-nope.png`,
    // THE NEAR MISS, and it is the case that separates this exact-path rule from
    // the client's basename-only `isPublishedAs`: the right file name in a
    // directory this run never published into.
    "/tmp/design-01-hero.png",
    // A prefix that was added twice, and a ref path with the prefix stripped off:
    // neither is a real card.
    `${SHOTS}/design-design-01-hero.png`,
    `${WS}/design-refs/01-hero.png.bak`,
  ]) {
    assert.equal(chosenMockupRef(MANIFEST, SHOTS, forged), forged, `${forged} must not be translated into a ref`);
    const attempt = lockManifest(MANIFEST, { path: chosenMockupRef(MANIFEST, SHOTS, forged), by: "owner", reason: "x", at: AT });
    assert.equal(attempt.ok, false, `${forged} must not be lockable`);
    assert.match(String(!attempt.ok && attempt.error), /not one of/iu);
  }
});

test("PREFIX-ADD, NEVER PREFIX-STRIP: a ref that is itself named design-… maps to its own copy", () => {
  // A ref genuinely called `design-hero.png` is published as
  // `design-design-hero.png`. Stripping one prefix off a click would send the
  // owner's choice to whichever sibling shares the shortened name — here, a
  // second ref that really is called `hero.png`.
  const plain = `${WS}/design-refs/hero.png`;
  const prefixed = `${WS}/design-refs/design-hero.png`;
  const manifest: DesignManifest = {
    ...MANIFEST,
    refs: [
      { path: plain, section: "hero", aspect: "21:9", intent: "opening", direction: null, origin: null },
      { path: prefixed, section: "hero, second take", aspect: "21:9", intent: "opening", direction: null, origin: null },
    ],
  };
  assert.equal(chosenMockupRef(manifest, SHOTS, `${SHOTS}/design-hero.png`), plain);
  assert.equal(chosenMockupRef(manifest, SHOTS, `${SHOTS}/design-design-hero.png`), prefixed);
});

test("locking twice is refused — a run has one chosen design", () => {
  const first = lockManifest(MANIFEST, { path: A, by: "owner", reason: "x", at: AT });
  assert.ok(first.ok);
  const second = lockManifest(first.manifest, { path: B, by: "ui-designer", reason: "y", at: AT });
  assert.equal(second.ok, false, "the gate would then grade against a reference the build never saw");
});

test("RULE 3: the choice file is read as ui-designer's, and validated against the manifest", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-"));
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: B, reason: "denser grid" }), "utf8");
  const attempt = readChoiceFile(refsDir, MANIFEST, AT);
  assert.equal(attempt?.path, B);
  assert.equal(attempt?.by, "ui-designer");
  assert.match(String(attempt?.reason), /denser grid/u);
});

test("RULE 3: a choice file naming a path outside the manifest yields NO attempt", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-bad-"));
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: "/etc/passwd", reason: "x" }), "utf8");
  assert.equal(readChoiceFile(refsDir, MANIFEST, AT), null);
});

test("the OWNER'S OWN attached image cannot become the lock, by any of the three doors", () => {
  /*
   * ADDED 2026-08-05 WITH `owner-reference.ts`, AND IT ASSERTS THE REFUSAL RATHER
   * THAN THE PERMISSION. His image is now a second referent for grading — a
   * QUALITY criterion in `visual-criteria.ts` points at it — and the obvious next
   * step, "so let him lock it", is the one that must not be taken. The refs test
   * cannot tell a path the HOST wrote from a path an AGENT wrote into the
   * manifest; by the time either reaches `lockManifest` both are strings.
   * Widening it for his image widens it for every agent-authored path in the same
   * edit, and `lockedMockup` is `Read` by the visual gate and injected into every
   * build prompt.
   *
   * ALL THREE ENTRY POINTS, because each is a separate way in: the HTTP click
   * (`chosenMockupRef` then `lockManifest`), the agent-written `choice.json`
   * (`readChoiceFile`), and a direct host call.
   */
  const owned = "/runs/r1/references/reference-1.png";

  assert.equal(lockManifest(MANIFEST, { path: owned, by: "owner", reason: "this is my design", at: AT }).ok, false);
  assert.equal(chosenMockupRef(MANIFEST, SHOTS, owned), owned, "no translation invents a ref out of it");
  assert.equal(lockManifest(MANIFEST, { path: chosenMockupRef(MANIFEST, SHOTS, owned), by: "owner", reason: "x", at: AT }).ok, false);

  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-owner-"));
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: owned, reason: "the owner sent it" }), "utf8");
  assert.equal(readChoiceFile(refsDir, MANIFEST, AT), null, "an agent may not nominate it either");

  // AND THE REFUSAL IS NOT AN ACCIDENT OF THE STRING: the same path published as
  // a mockup card, which is the shape the wire actually carries, is refused too.
  assert.equal(lockManifest(MANIFEST, { path: publishedMockupPath(SHOTS, owned), by: "owner", reason: "x", at: AT }).ok, false);
});

test("RULE 5: the lock record round-trips, and a park's clock is on DISK", () => {
  // The timeout has to survive a dashboard restart, and a timer does not. The
  // park time is written down so `reconcileOnBoot` can ask how long it has been.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-"));
  const record = { ...emptyDesignLockRecord(AT), awaiting: true };
  writeDesignLock(dir, record);
  assert.deepEqual(readDesignLock(dir), record);
  assert.equal(readDesignLock(mkdtempSync(join(tmpdir(), "design-lock-empty-"))), null);
});

test("RULE 5: a RESOLVED lock round-trips — the path, the chooser and the reason all survive the disk", () => {
  // The parked record above is all nulls, so it cannot see a `writeDesignLock`
  // that drops the three fields that matter. This is the record Task 10 writes
  // once a lock is applied (`{awaiting: false, parkedAt: attempt.at, locked:
  // attempt.path, lockedBy: attempt.by, reason: attempt.reason}`), and `locked`
  // is the gate's input — rule 5 is exactly the claim that it is written down.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-resolved-"));
  const record = { ...emptyDesignLockRecord(AT), locked: B, lockedBy: "ui-designer" as const, reason: "denser grid" };
  writeDesignLock(dir, record);
  assert.deepEqual(readDesignLock(dir), record);
  assert.equal(readDesignLock(dir)?.locked, B, "the gate's input is the field that must not be dropped");
  assert.equal(readDesignLock(dir)?.lockedBy, "ui-designer", "RULE 4: who made it, still there after the disk");
  assert.equal(readDesignLock(dir)?.reason, "denser grid", "RULE 4: and why");
});

test("RULE 4: when the chooser produced nothing, the fallback is RECORDED AS a fallback", () => {
  // Recording it as "ui-designer" would be a lie about provenance; recording
  // nothing would leave an unattended run unexplainable.
  const attempt = fallbackChoice(MANIFEST, AT, "ui-designer wrote no choice.json");
  assert.equal(attempt?.by, "fallback");
  assert.equal(attempt?.path, A, "first by manifest order, stated rather than dressed up as a judgement");
  assert.match(String(attempt?.reason), /wrote no choice\.json/u);
  assert.equal(fallbackChoice({ ...MANIFEST, refs: [] }, AT, "x"), null, "no refs, no lock — never an invented one");
});

/* ---- RULE 1, executed rather than asserted about ------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

type TimeoutOutcome =
  | { readonly kind: "locked"; readonly manifest: DesignManifest }
  | { readonly kind: "no-lock"; readonly why: string }
  | { readonly kind: "never-fired" };

/**
 * The park, run against a real clock.
 *
 * The body of the timer is the sequence Task 10's `resume(runId, null)` runs on
 * expiry, in its order: `readChoiceFile(...) ?? fallbackChoice(...)`, then
 * `lockManifest`. The delay is the expression its `#parkForDesignLock` schedules,
 * `designLockTimeoutMin(env) * 60_000`.
 *
 * THE WATCHDOG IS THE POINT. Without it a park that never expires would hang the
 * test until the runner's own timeout and report as an infrastructure problem;
 * with it, "the park never ended" is an assertion that fails by name — which is
 * the only observable rule 1 actually cares about.
 */
function resolveParkOnTimeout(delayMs: number, refsDir: string, watchdogMs: number): Promise<TimeoutOutcome> {
  return new Promise<TimeoutOutcome>((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(watchdog);
      const at = new Date().toISOString();
      const attempt =
        readChoiceFile(refsDir, MANIFEST, at) ??
        fallbackChoice(MANIFEST, at, "no owner choice arrived before the timeout");
      if (attempt === null) {
        resolve({ kind: "no-lock", why: "neither the chooser nor the fallback produced an attempt" });
        return;
      }
      const result = lockManifest(MANIFEST, attempt);
      resolve(result.ok ? { kind: "locked", manifest: result.manifest } : { kind: "no-lock", why: result.error });
    }, delayMs);
    const watchdog = setTimeout(() => {
      clearTimeout(timer);
      resolve({ kind: "never-fired" });
    }, watchdogMs);
  });
}

test("RULE 1: the park EXPIRES ON ITS OWN and auto-selects — the timer fires, a lock exists", async () => {
  // Rule 1 is not "a constant exists". It is "a park that nobody clicks still
  // ends". So this schedules the real delay against the real clock and asserts a
  // lock came out of it — and a timeout that silently never arrives fails here
  // rather than being invisible until an unattended run parks overnight.
  //
  // THE BOUND IS ASSERTED BEFORE THE TIMER IS ARMED, DELIBERATELY: Node coerces a
  // non-finite or out-of-range `setTimeout` delay to 1ms, so an infinite timeout
  // would make a "did the callback run?" assertion pass. Firing is necessary
  // evidence and not sufficient evidence; the delay itself has to be finite.
  const env = { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0.002" };
  const delayMs = designLockTimeoutMin(env) * 60_000;
  assert.ok(Number.isFinite(delayMs) && delayMs > 0, `a park scheduled at ${String(delayMs)}ms never ends by itself`);
  assert.ok(delayMs <= DAY_MS, "a park longer than a day is indefinite in every sense that matters");
  const defaultDelayMs = designLockTimeoutMin({}) * 60_000;
  assert.ok(Number.isFinite(defaultDelayMs) && defaultDelayMs <= DAY_MS, "the DEFAULT park is bounded too");

  const chose = mkdtempSync(join(tmpdir(), "design-timeout-chose-"));
  writeFileSync(join(chose, "choice.json"), JSON.stringify({ chosen: B, reason: "denser grid" }), "utf8");
  const withChooser = await resolveParkOnTimeout(delayMs, chose, 5_000);
  assert.equal(withChooser.kind, "locked", "the park did not resolve itself within the configured timeout");
  assert.ok(withChooser.kind === "locked" && withChooser.manifest.lockedMockup === B);
  assert.ok(withChooser.kind === "locked" && withChooser.manifest.lockedBy === "ui-designer", "RULE 3 on the auto path");

  const silent = mkdtempSync(join(tmpdir(), "design-timeout-silent-"));
  const withoutChooser = await resolveParkOnTimeout(delayMs, silent, 5_000);
  assert.equal(withoutChooser.kind, "locked", "no chooser file must still end the park — with a lock, not with nothing");
  assert.ok(withoutChooser.kind === "locked" && withoutChooser.manifest.lockedMockup === A);
  assert.ok(withoutChooser.kind === "locked" && withoutChooser.manifest.lockedBy === "fallback", "RULE 4, named");
  assert.match(String(withoutChooser.kind === "locked" ? withoutChooser.manifest.lockedReason : ""), /timeout/u);
});

test("RULE 1: the timer's deadline and the restart deadline are the SAME instant", () => {
  // Task 10 arms `setTimeout(..., designLockTimeoutMin(env) * 60_000)`, and after
  // a restart `reconcileOnBoot` asks `designLockExpired(parkedAt, now, mins)`
  // instead. The two have to agree AT the deadline: a park the timer would have
  // resolved at exactly T+delay, that the boot path then calls "still waiting",
  // is a park with no remaining mechanism to end it — rule 1 broken by one
  // millisecond of disagreement between two files.
  const timeoutMin = designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" });
  const delayMs = timeoutMin * 60_000;
  const atDeadline = new Date(Date.parse(AT) + delayMs).toISOString();
  const oneBefore = new Date(Date.parse(AT) + delayMs - 1).toISOString();
  assert.equal(designLockExpired(AT, atDeadline, timeoutMin), true, "the instant the timer fires, the park IS expired");
  assert.equal(designLockExpired(AT, oneBefore, timeoutMin), false, "and not one millisecond before it");
});

/* ══ the DIRECTION choice, and the record that survives a restart ══════════ */

const DIRECTIONS_MANIFEST: DesignManifest = {
  version: 1,
  refs: [
    {
      path: `${WS}/design-refs/editorial-slab-01-hero.png`,
      section: "hero",
      aspect: "16:9",
      intent: "a",
      direction: "editorial-slab",
      origin: "canvass",
    },
    {
      path: `${WS}/design-refs/quiet-grid-01-hero.png`,
      section: "hero",
      aspect: "16:9",
      intent: "b",
      direction: "quiet-grid",
      origin: "canvass",
    },
  ],
  directions: [
    { slug: "editorial-slab", name: "Editorial slab", distinction: "slab masthead", notes: null },
    { slug: "quiet-grid", name: "Quiet grid", distinction: "hairline grid", notes: null },
  ],
  chosenDirection: null,
  directionChoice: null,
  lockedMockup: null,
  lockedBy: null,
  lockedReason: null,
  lockedAt: null,
};

test("chooseDirection MIRRORS lockManifest: a second choice, an undeclared slug and a blank reason", () => {
  const ok = chooseDirection(DIRECTIONS_MANIFEST, { slug: "quiet-grid", by: "owner", reason: "  it reads  ", at: AT });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.manifest.chosenDirection, "quiet-grid");
  assert.equal(ok.ok && ok.manifest.directionChoice?.reason, "it reads", "trimmed, and recorded with its provenance");
  assert.equal(ok.ok && ok.manifest.directionChoice?.by, "owner");
  assert.equal(ok.ok && ok.manifest.lockedMockup, null, "choosing a DIRECTION never locks a still");

  // A SECOND CHOICE. The expansion has already spent five to seven generations on
  // the first one, so re-choosing either strands that spend or leaves
  // `chosenDirection` disagreeing with the stills that were actually built.
  const second = chooseDirection(ok.ok ? ok.manifest : DIRECTIONS_MANIFEST, {
    slug: "editorial-slab",
    by: "owner",
    reason: "changed my mind",
    at: AT,
  });
  assert.equal(second.ok, false);
  assert.match(second.ok ? "" : second.error, /already chose/);

  const invented = chooseDirection(DIRECTIONS_MANIFEST, { slug: "made-up", by: "owner", reason: "r", at: AT });
  assert.equal(invented.ok, false);
  assert.match(invented.ok ? "" : invented.error, /not one of this run's 2 directions/);

  const blank = chooseDirection(DIRECTIONS_MANIFEST, { slug: "quiet-grid", by: "owner", reason: "   ", at: AT });
  assert.equal(blank.ok, false);
  assert.match(blank.ok ? "" : blank.error, /needs a reason/);
});

test("readDirectionChoiceFile takes a SLUG and validates it; fallback names itself a fallback", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-dirchoice-"));
  assert.equal(readDirectionChoiceFile(refsDir, DIRECTIONS_MANIFEST, AT), null, "absent is null, not a throw");

  const write = (body: unknown): void => {
    writeFileSync(join(refsDir, DESIGN_DIRECTION_CHOICE_FILE), JSON.stringify(body), "utf8");
  };
  write({ chosen: "quiet-grid", reason: "the grid carries it" });
  assert.deepEqual(readDirectionChoiceFile(refsDir, DIRECTIONS_MANIFEST, AT), {
    slug: "quiet-grid",
    by: "ui-designer",
    reason: "the grid carries it",
    at: AT,
  });

  // A SLUG NOBODY DECLARED IS REFUSED, exactly as `readChoiceFile` refuses a path
  // that is not a ref: this file is written by an agent and read by the host.
  write({ chosen: "invented", reason: "r" });
  assert.equal(readDirectionChoiceFile(refsDir, DIRECTIONS_MANIFEST, AT), null);
  // AND A PATH IS NOT A SLUG. An agent that wrote `choice.json`'s shape into this
  // file must not have it silently honoured.
  write({ chosen: `${WS}/design-refs/editorial-slab-01-hero.png`, reason: "r" });
  assert.equal(readDirectionChoiceFile(refsDir, DIRECTIONS_MANIFEST, AT), null);
  write({ chosen: "quiet-grid" });
  assert.equal(readDirectionChoiceFile(refsDir, DIRECTIONS_MANIFEST, AT)?.reason, "no reason given");

  const fallback = fallbackDirectionChoice(DIRECTIONS_MANIFEST, AT, "no owner choice arrived");
  assert.equal(fallback?.slug, "editorial-slab", "first in manifest order");
  assert.equal(fallback?.by, "fallback", "recording it as ui-designer would be a lie about provenance");
  assert.match(String(fallback?.reason), /no judgement applied/);
  assert.equal(fallbackDirectionChoice({ ...DIRECTIONS_MANIFEST, directions: [] }, AT, "x"), null);
});

test("directionForMockup translates a PUBLISHED click back to a direction, and nothing else", () => {
  const shots = "/results/screenshots/r1";
  const published = publishedMockupPath(shots, `${WS}/design-refs/quiet-grid-01-hero.png`);
  assert.equal(directionForMockup(DIRECTIONS_MANIFEST, shots, published), "quiet-grid");
  // The host's own paths (a workspace ref) travel through unchanged.
  assert.equal(directionForMockup(DIRECTIONS_MANIFEST, shots, `${WS}/design-refs/editorial-slab-01-hero.png`), "editorial-slab");
  // A PATH THAT NAMES NOTHING IS NULL, never a guess. The caller then has no slug
  // and leaves the run parked rather than choosing for him.
  assert.equal(directionForMockup(DIRECTIONS_MANIFEST, shots, "/tmp/whatever.png"), null);
  // AND A LEGACY MANIFEST YIELDS NULL RATHER THAN INVENTING A DIRECTION.
  assert.equal(directionForMockup(MANIFEST, shots, A), null);
});

test("A design-lock.json WRITTEN BEFORE 2026-08-03 READS, and its caps are ZERO not unlimited", () => {
  // THE DEFECT THIS REPLACES: `readDesignLock` was `JSON.parse(...) as
  // DesignLockRecord` — a cast the compiler checks about the TYPE and nothing
  // checks about the BYTES. Three files on this machine carry none of the eleven
  // fields added that day, so `turnsUsed` would be `undefined`, and
  // `undefined >= MAX_DESIGN_LOCK_TURNS` is FALSE — both caps reading as
  // unlimited on exactly the runs that predate them.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-legacy-"));
  writeFileSync(
    join(dir, DESIGN_LOCK_RECORD_FILE),
    JSON.stringify({ awaiting: false, parkedAt: AT, locked: B, lockedBy: "ui-designer", reason: "the only faithful one" }),
    "utf8",
  );
  const record = readDesignLock(dir);
  assert.ok(record !== null, "an old record still reads");
  assert.equal(record.locked, B, "and the five fields it does carry are untouched");
  assert.equal(record.lockedBy, "ui-designer");
  assert.equal(record.turnsUsed, 0, "NOT undefined — a falsy absent value must never read as unlimited");
  assert.equal(record.rendersUsed, 0);
  assert.deepEqual(record.directions, []);
  assert.deepEqual(record.requests, []);
  assert.equal(record.chosenDirection, null);
  assert.equal(record.expanded, false);
  assert.equal(record.askedAfterSeq, null, "null = every pending message is a candidate");

  // AND THE SAME FOR HOSTILE-SHAPED VALUES. `?? 0` would pass a null straight
  // through; `Number.isFinite` is what makes the cap a number.
  writeFileSync(
    join(dir, DESIGN_LOCK_RECORD_FILE),
    JSON.stringify({ awaiting: true, parkedAt: AT, turnsUsed: null, rendersUsed: "6", requests: "none" }),
    "utf8",
  );
  const hostile = readDesignLock(dir);
  assert.equal(hostile?.turnsUsed, 0);
  assert.equal(hostile?.rendersUsed, 0);
  assert.deepEqual(hostile?.requests, []);
});

test("EVERY design-lock.json ON THIS MACHINE READS — the real files, not a fixture of them", () => {
  const runsDir = join(import.meta.dirname, "..", "..", "runs");
  if (!existsSync(runsDir)) return;
  for (const entry of readdirSync(runsDir)) {
    const results = join(runsDir, entry, "results");
    if (!existsSync(join(results, DESIGN_LOCK_RECORD_FILE))) continue;
    const record = readDesignLock(results);
    assert.ok(record !== null, `${entry}'s lock record must still read`);
    assert.equal(record.turnsUsed, 0, `${entry} predates the caps and must read as spent-nothing, not unlimited`);
    assert.equal(record.rendersUsed, 0);
    assert.deepEqual(record.directions, [], `${entry} predates directions`);
  }
});

test("the record round-trips with a dialogue in it — the caps and the requests survive the disk", () => {
  // WHAT THIS CATCHES: a `writeDesignLock` caller that reconstructs the record
  // instead of spreading onto it. `#applyDesignLock` and `#parkForDesignLock`
  // both built fresh literals before the dialogue existed, and a fresh literal
  // resets `rendersUsed` — so the render the owner already paid for becomes free
  // again on the write that records his choice.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-dialogue-"));
  const record = {
    ...emptyDesignLockRecord(AT),
    awaiting: true,
    directions: [
      {
        slug: "quiet-grid",
        name: "Quiet grid",
        distinction: "hairline grid",
        notes: null,
        mockups: ["/results/screenshots/r1/design-quiet-grid-01-hero.png"],
      },
    ],
    turnsUsed: 2,
    rendersUsed: 1,
    askedAfterSeq: 7,
    requests: [
      {
        seq: 8,
        at: AT,
        section: "contact",
        direction: "quiet-grid",
        outcome: "rendered" as const,
        detail: "rendered the contact section in Quiet grid",
        path: `${WS}/design-refs/quiet-grid-req-01-contact.png`,
      },
    ],
  };
  writeDesignLock(dir, record);
  assert.deepEqual(readDesignLock(dir), record);
});
