/**
 * defect-record.trail.test.ts — the ONE field that says an attempt was cut off by
 * the harness rather than answered by the seat.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * `bakeoff`'s `AuthoringAttempt` grew a `timedOut` flag on 2026-08-10, and
 * `spec-agent.ts` passes the attempts straight into `freezeSuite` as
 * `authoringTrail: authored.attempts`. Because that is a VARIABLE and not a fresh
 * object literal, TypeScript's excess-property check never ran, so the field
 * reached the persisted `AUDIT.json` while being undeclared on
 * `AuthoringTrailEntry` — invisible to this module and to every other reader of the
 * trail. The consequence was precise: the defect record for the one failure mode
 * that round ADDED could not say that an attempt had been abandoned.
 *
 * ═══ WHY `=== true` AND NOT TRUTHINESS ═══
 *
 * The field is OPTIONAL on the trail type because trails frozen before that date do
 * not carry it. "No attempt timed out" and "this build did not record timeouts" are
 * different facts about a run, and a loose check turns every absence into a claim —
 * which is this repository's catalogued signature defect. Both directions are
 * asserted below.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { readAuthoringAttempts } from "./defect-record.js";

const ABANDONED = /ABANDONED on the per-call wall-clock bound/;

function trail(entries: readonly Record<string, unknown>[]): unknown {
  return { authoringTrail: entries };
}

test("an abandoned attempt is named as abandoned, first, on its own row", () => {
  const attempts = readAuthoringAttempts(
    trail([
      { attempt: 1, parsed: false, timedOut: true, problems: ["the authoring call did not return"] },
    ]),
  );
  assert.ok(attempts !== null, "the trail was not read at all");
  assert.equal(attempts?.length, 1);
  const problems = attempts?.[0]?.problems ?? [];
  assert.ok(
    ABANDONED.test(problems[0] ?? ""),
    `the abandonment is not the FIRST problem on the row: ${JSON.stringify(problems)}. Every other ` +
      "problem on an abandoned attempt is downstream of the fact that nothing arrived, and reading it " +
      "second inverts the cause.",
  );
  assert.equal(problems.length, 2, "the attempt's own problems were dropped, or duplicated");
});

test("absent is NOT false: a pre-2026-08-10 trail claims nothing about timeouts", () => {
  const attempts = readAuthoringAttempts(
    trail([{ attempt: 1, parsed: true, problems: ["a manifest field is missing"] }]),
  );
  const problems = attempts?.[0]?.problems ?? [];
  assert.equal(problems.length, 1);
  assert.ok(
    !ABANDONED.test(problems[0] ?? ""),
    "an attempt with no `timedOut` field was reported as abandoned, so every old trail now claims a " +
      "timeout that was never recorded",
  );
});

test("a truthy-but-not-true value is not an abandonment, and neither is `false`", () => {
  for (const value of [false, 0, "", "true", 1, null] as const) {
    const attempts = readAuthoringAttempts(trail([{ attempt: 1, timedOut: value, problems: [] }]));
    const problems = attempts?.[0]?.problems ?? [];
    assert.ok(
      !ABANDONED.test(problems[0] ?? ""),
      `timedOut: ${JSON.stringify(value)} was read as an abandonment. Only the boolean \`true\` — the ` +
        "value `spec-agent.ts` writes — may produce that sentence.",
    );
  }
});

/**
 * THE NEGATIVE CONTROL ON THE WHOLE FILE: the reader must still distinguish "no
 * trail at all" from "a trail with nothing in it". `null` is the answer that lets
 * the defect record say a field is unavailable instead of filing a run with three
 * authoring calls as a run with zero.
 */
test("a candidate with no trail is null, and an empty trail is an empty list", () => {
  assert.equal(readAuthoringAttempts(null), null);
  assert.equal(readAuthoringAttempts({ notATrail: 1 }), null);
  assert.deepEqual(readAuthoringAttempts(trail([])), []);
});

/* -------------------------------------------------------------------------
 * REPAIR ROUNDS — the defect a repaired attempt no longer carries
 * ---------------------------------------------------------------------- */

const REPAIRED = /repair round\(s\) ran inside this attempt/;

/**
 * WHY THIS ROW WOULD OTHERWISE READ AS CLEAN. A repair round that clears a
 * blocking finding leaves the attempt recorded with the RE-audit's findings,
 * which are empty, and `accepted: true`. So the attempt that shipped a
 * credential-shaped literal and then fixed it is, on disk, indistinguishable
 * from an attempt that never had one — unless this reader says otherwise.
 */
test("a repaired attempt still reports what the repair had to clear", () => {
  const attempts = readAuthoringAttempts(
    trail([
      {
        attempt: 1,
        parsed: true,
        accepted: true,
        problems: [],
        findings: [],
        repairRounds: 1,
        repairedProblems: ['[other] test file "visible/x.test.mjs" contains credential-shaped literal(s)'],
      },
    ]),
  );
  const problems = attempts?.[0]?.problems ?? [];
  assert.equal(problems.length, 1, `expected exactly one row problem, got ${JSON.stringify(problems)}`);
  assert.ok(REPAIRED.test(problems[0] ?? ""));
  assert.match(problems[0] ?? "", /credential-shaped literal/);
});

test("absent is NOT zero: a pre-2026-08-12 trail claims nothing about repair", () => {
  const attempts = readAuthoringAttempts(trail([{ attempt: 1, parsed: true, problems: [] }]));
  assert.equal(attempts?.[0]?.problems.length, 0);
  assert.ok(
    !REPAIRED.test((attempts?.[0]?.problems ?? []).join(" ")),
    "a trail with no repairRounds field was reported as having run repair rounds",
  );
});

test("zero rounds is a measurement and says nothing, and a non-number is not a count", () => {
  for (const value of [0, "1", true, null] as const) {
    const attempts = readAuthoringAttempts(
      trail([{ attempt: 1, parsed: true, problems: [], repairRounds: value }]),
    );
    assert.ok(
      !REPAIRED.test((attempts?.[0]?.problems ?? []).join(" ")),
      `repairRounds: ${JSON.stringify(value)} produced a repair sentence. Only a number above zero — ` +
        "the value `spec-agent.ts` writes — may.",
    );
  }
});
