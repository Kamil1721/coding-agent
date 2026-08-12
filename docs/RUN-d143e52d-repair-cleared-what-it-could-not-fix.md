# RUN `d143e52d` — the repair loop's first live outing cleared a rejection it could not fix

2026-08-12. The repair round shipped that morning fired on its first real run, saved an
attempt exactly as designed, and in doing so turned a correct blocking rejection into an
acceptance. The suite it froze cannot tell a real backend from a fake one.

```
run-2026-08-12T07-34-18-997Z-d143e52d   ticket t-855f41701dd1e908
spec phase: 1 attempt, repairRounds 1, accepted true, 23 criteria, suite frozen
cancelled by hand in the build phase once the suite was read
```

---

## 1. WHAT THE JUDGE SAID, VERBATIM

The adversarial audit rejected attempt 1 with one blocking finding. Abridged only in the
middle; the emphasis is the point:

> **REQ-004: No criterion in the suite ever observes that a submission is stored.** T-6 (and
> visible T-33) assert only status 201, a non-empty id, and that a second submission returns a
> different id — an in-memory `let nextId = 1` handler that never touches a database passes.
> […] the manifest's single dataExpectation is kind 'http' with file/table/sql all null, so no
> SQLite file is inspected; and no criterion covers survival across a restart. The ticket makes
> this the headline […] **As authored, a build with zero persistence passes 23/23 criteria, so
> the suite cannot distinguish a real backend from a fake one on the requirement it exists to
> measure.** The manifest schema exposes file/table/sql dataExpectations, so a sqlite-file check
> was available; **closing this requires new criteria and tests, i.e. re-authoring.**

That last clause is the judge telling the harness, in plain English, that a targeted repair
could not work. Nothing read it.

## 2. WHY THE ROUND FIRED ANYWAY

`repairTargets` asked one question: *does this finding name an artefact that exists in the
draft?* The finding named `REQ-004`, `REQ-003`, `REQ-006`, `T-6` and `T-33`. All five are real.
So it localised cleanly, those artefacts went back to the seat, and a repair round was spent.

A repair may only return artefacts it was given — `REPAIR_SYSTEM_PROMPT` forbids adding one and
`parseRepairResponse` rejects any id or path that was not sent. The round was therefore
**structurally incapable** of closing a finding whose remedy is a criterion that does not exist.

The re-audit is a fresh judge call with no memory of the first. It did not raise the finding
again. `mustRegenerate` came back false, the attempt was recorded `accepted: true`, and the
suite was frozen.

> **A finding about something MISSING names the artefacts that fail to cover it.**
> Localisable is not the same as repairable, and the old predicate could not tell them apart.

## 3. WHAT WAS ACTUALLY FROZEN, MEASURED

Read out of the frozen suite rather than inferred from the trail — which said `accepted: true`
and carried no clue:

- **0 of 23 criteria** mention persistence, storage, restart, SQLite or a database.
- No test in either half performs a right-token `GET /api/messages`. Both halves exercise only
  the missing-token and wrong-token 401 paths.
- The manifest's one `dataExpectation` is `{kind: "http", path: "/api/projects", minRows: 6}`.
  `file`, `table` and `sql` are null, so no SQLite file is opened.

The ticket calls the backend *"THE PART THAT MUST ACTUALLY WORK"* and lists *"a valid message
returns 201 and then appears in GET /api/messages"* and *"killing the server and starting it
again still returns messages"* as acceptance signals. None of that was gated.

**Under the previous discard-and-regenerate behaviour this suite would have been thrown away
and re-authored.** The repair loop made the outcome worse, not merely no better.

## 4. THE FIX — THE JUDGE DECLARES THE REMEDY

`AuditFinding` gains `remedy?: "edit" | "add"`, required in `AUDIT_JSON_SCHEMA`:

- `edit` — the defect lives inside artefacts that exist and rewriting those exact artefacts
  closes it. Repair may attempt it.
- `add` — closing it needs artefacts that do not exist yet. Repair declines; the suite is
  re-authored.

Four properties make it hold rather than merely exist:

1. **Absent means `add`, everywhere.** `parseJudgeFindings` maps anything that is not literally
   `"edit"` to `"add"`. A remedy nobody declared is not one anybody has shown to be an edit.
2. **The deterministic pass declares its own.** Every rule in `spec-validate.ts` inspects an
   artefact it can name, so `blocking()` defaults to `edit` — which is what keeps the three real
   suite-defect cases (`ac275880`, `0629aa6c`, `a913c871`) repairing. The five COVERAGE rules
   pass `"add"` explicitly.
3. **The prompt teaches the trap with the sentence that sprang it.** It tells the judge that
   naming an artefact does not make a finding `edit`, using this run's own finding as the
   worked example, and that when unsure the answer is `add` — a wrong `add` costs one
   re-authoring cycle, a wrong `edit` loses a rejection.
4. **Remedy is checked BEFORE localisation** in `repairTargets`, so a coverage finding is
   declined whatever it names.

The regression test is this run's finding text, twice: with `remedy: "add"` it is declined, and
with the **byte-identical** detail marked `"edit"` it is repaired. The test turns on the
declared remedy, not on the words.

## 5. WHAT THIS COST, AND WHAT IT IS EVIDENCE OF

One cancelled run, ~30 minutes of spec phase, and a build phase stopped early.

It is also the second time in one day that this project's signature defect appeared inside the
machinery built to detect it. The first was a mutation-surviving gap in the repair tests
themselves (every fixture had findings that *all* localised or *none* did, so deleting the
`unlocalised` guard left 19 tests green). The second is this. Both were found by executing
something — a mutation, a frozen suite — and neither would have been found by reading.

> The trail said `accepted: true`, `repairRounds: 1`, no problems. Every field was accurate and
> the suite was still wrong. **A record that reports what the harness did is not a record of
> whether it worked.**

## 6. WHAT IS STILL OPEN

1. **The trail does not record what a repair CHANGED.** `repairedProblems` says what the round
   was asked to clear; nothing says which artefacts came back or how they differ. Diagnosing
   this run required reading the frozen suite by hand. A per-artefact digest before and after
   would have shown in one line that REQ-004 came back materially unchanged.
2. **A repair that changes nothing is still accepted.** `parseRepairResponse` requires at least
   one artefact back but does not require it to DIFFER from what was sent. A no-op repair
   currently costs a call and a re-audit and can clear a finding by luck of the second judge.
3. **The re-audit's independence cuts both ways.** Not showing the second judge the first one's
   findings is what keeps the two detectors independent — and it is also why a finding can
   silently fail to recur. Whether a repaired suite should be re-audited by a judge told which
   finding it is re-checking is a real question with a real cost on both sides.
