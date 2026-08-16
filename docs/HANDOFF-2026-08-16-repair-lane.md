# HANDOFF — the repair lane, 2026-08-16

Repo `/Users/kamilborzecki/Projects/coding-agent`, branch `main`, pushed to
`origin/main` at **`07e23e9`**. Working tree clean apart from an untracked
`.DS_Store`.

## Read these first, in this order

1. `docs/DESIGN-repair-lane-2026-08-16.md` — the whole design, 838 lines, committed.
   **§12 is the important one**: it lists eight claims the rest of the document got
   wrong, measured against the tree. Read §12 before trusting §§1–11.
2. `git log -3` — the three commits' messages carry the reasoning; do not re-derive it.
3. `dashboard/STATUS.md` §1.2 — the scorer digest chain, now at move #6.

## Ground rules this repo is built on (they are not optional)

- **"A check that can only observe success is not a check."** Every new test must be
  shown going RED when its mechanism is broken. Name the mutation in the docblock AND
  RUN IT. Three times this session a docblock named a mutation that did not actually
  redden, and each was caught only by running it.
- **Measure, never relay.** Docs here lag the tree and have been repeatedly wrong.
  Re-derive any claim from code, `dashboard/data/runs.db`, or a command you ran.
  This applies to the design doc, to STATUS.md, and to this file.
- **No AI attribution in commits or PR bodies.** Global rule, `~/.claude/CLAUDE.md`.
- Commit/push only when the owner asks.

## State: green

```
dashboard/server   2228 / 2225 pass / 0 fail / 3 skipped
bakeoff             248 /  248
dashboard UI         27 /   27   (npx playwright test tests/repair-questions.unit.spec.ts)
typechecks          clean in all three trees
```

Two regression probes worth keeping green (scratch scripts are gone; re-derive if needed):
`047f9872` must adjudicate PIPELINE / wake=true; `052c6e02` must be UNKNOWN / wake=false.

## What exists now

`dashboard/server/src/` — all new, all committed:
`adjudicate.ts` (is a red gate the grader's fault or the build's),
`repair-questions.ts` (Codex asks, answers must cite a source),
`repair-report.ts` + `repair-mail.ts` (plain-English report, fail-open SMTP),
`repair-orchestrator.ts` (the goal loop), `repair-questions-panel.tsx` (UI).

## THE NEXT DECISION — this is a blocker, and it is the owner's

`repair-author.ts`'s `REFUSED_PATH_PREFIXES` refuses `bakeoff/src/` as "a superset of
the frozen grader closure … refused as a directory because the derived list cannot be
imported here" — its own comment admits it is an over-approximation.

The defect the whole lane was designed around (`APP_DIR`, run `047f9872`) is fixed in
`bakeoff/src/scorer-container.ts`. So the lane can diagnose it and **cannot apply the
fix** — it returns `PARKED_SCOPE_REFUSED` and emails the owner the patch instead.

That is principled (an agent editing its own grader is the collapse this repo refuses)
but it means the most common defect class is never repaired unattended. **Ask the owner
whether to narrow the closure before building anything downstream of it.**

## Open work, in dependency order

1. **Bind the orchestrator's seams.** `RepairDeps` in `repair-orchestrator.ts` is a
   tested shape with fakes. Bind `reproduce`/`applyPatch`/`revertPatch` to
   `tools/repair/cycle.mjs` + `tools/repair/supervisor-gate.mjs`, `gate` to
   `tools/tier3/gate.mjs`, `ask` to `createCodexAsk`. **Check you are not
   re-implementing `cycle.mjs` rather than calling it** — the file's header warns about
   exactly that.
2. **Nothing can wake the lane.** `supervisor_tickets` rows are minted only by
   `enqueueSupervisorTicket`, whose sole production caller is `http.ts:2016`
   (`POST /api/supervisor/tickets`). A run from `POST /api/runs` is structurally
   invisible to the supervisor; zero rows have ever existed.
3. **Canvas repair node** — design §13: a CHILD lane a run spawns at the point of
   failure, deduped by defect signature, rendering nothing when the run is healthy.
   §11 is the questions panel that lives inside it (component already built).
4. **`REPAIR_SMTP_URL`** — owner sets it via `~/.claude/scripts/set-secret.sh`.
   NEVER invite it into the chat. Until then reports write to disk only.
5. **Nothing commits durably yet** — `applyGatedPatch` ends at `git apply -p1`;
   `tools/repair/supervisor-gate.mjs` has no `git commit` on the production path, and
   `revertGatedPatch` has no caller. Design §3B needs this.

## Findings still open (~13, all MEDIUM/LOW, none behavioural)

Full evidence in the two workflow journals:
`~/.claude/projects/-Users-kamilborzecki-Projects-coding-agent/563ffb05-*/subagents/workflows/wf_4b23a4a3-9f7/journal.jsonl`
and `.../wf_e40e7af0-072/journal.jsonl` (one `{"type":"result"}` line per agent).

The only one worth treating as load-bearing:
**`repair-questions.ts:303` `claimsFromDefect` may interpolate held-out assertion text
verbatim into a prompt shipped to a third-party model process.** PLAUSIBLE, unverified.
Verify before wiring the Codex asker (open item 1).

The rest are overclaiming docblocks and tests that do not observe what they are named
for — `repair-mail.ts:47` (STARTTLS coverage claim), `adjudicate.ts:778`/`:965`,
`repair-report.test.ts:18`/`:421`/`:786`, the panel header at `:114`/`:129`,
`repair-questions.ts:474`/`:672`, `scorer-container.ts:1203`,
`node-test-reporter.mjs:241`.

`/debugfix` did NOT converge: 8 of 9 passes used, core lens set met, **0 consecutive dry
passes**. `.debugfix-active` is still armed — the `verify.sh` Stop hook owns it, do not
delete it.

## Local processes left running (kill freely, nothing depends on them)

```
127.0.0.1:4319  dashboard UI       127.0.0.1:4176  dashboard API
127.0.0.1:4400  the site run 047f9872 built (node server.mjs from its workspace)
```

## Skills the next session should use

- `superpowers:verification-before-completion` — before any "it works" claim.
- `superpowers:systematic-debugging` — before proposing a fix for anything.
- `superpowers:test-driven-development` — the seam-binding in open item 1.
- `/debugfix` (user-invoked only; the agent cannot call it) once seams are bound.
- `/simplify` after each feature, per the owner's standing quality gate.
- Workflow tool for multi-step work — the owner asked for it explicitly and ultracode
  is on for their session.

## One caution about this document

It was written from a long session and is a point-in-time snapshot. Line numbers drift.
Re-grep anything before you build on it — that instruction is the single most useful
thing this repo has taught, and it applies to the handoff too.
