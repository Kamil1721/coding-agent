# 2026-08-10/11 — THE NIGHT `falseFinish` FIRED FOR THE FIRST TIME

Five runs. Four died in the spec phase without reaching a builder. The fifth produced the
first co-primary measurement this project has ever recorded.

```
run-2026-08-11T04-42-07-584Z-fccefcee   181 min, unattended
heldOutPass = 0    falseFinish = 1    agentDeclaredDone = 1    inferredCriteria = 0
23 of 25 criteria met · 0 BLOCKING failures · gate attempts 2
```

---

## 1. THE HEADLINE — A METRIC THAT COULD NOT FIRE, FIRED

`falseFinish = agentDeclaredDone && !heldOutPass`. At the start of this session
`agentDeclaredDone` had **never once been true on this machine**, and could not be: the
builder's completion file was described in a prompt that a design-lane run never receives, so
it guessed `"complete"`, `readSelfReport` returned `null`, and the orchestrator logged
*"absent status, or not JSON"* — wrong on both counts.

Tonight the builder wrote `status: "done"`, the sealed suite disagreed, and **the system said
so.** That is the failure mode the whole project exists to catch, caught, unattended, at
07:29.

Nothing else in this document matters as much as that line.

---

## 2. WHAT WAS FIXED, AND WHY EACH ONE WAS FOUND

Every fix below is the same shape: **a check refusing correct work, or a prompt commissioning
the impossible.** None was a defect in a model's output.

| # | defect | how it was found |
|---|---|---|
| 1 | the self-report shape reached one prompt; every real run took the other | grep the shipped `prompt.txt`: `"exactly this shape"` → 0 |
| 2 | `APP_ROOT` documented, exempted by the audit, set by nothing | the scorer's own recorded stack trace |
| 3 | the blocking literal scan read COMMENTS, against the module's written policy | rule-by-rule audit vs the prompt |
| 4 | EARS refused `"Each project page shall…"` for one word | run `aa6e721e`'s failure text |
| 5 | the prompt commissioned a stub-marker test and forbade the only way to write it | same audit |
| 6 | the credential scan blocks a 16-char fake token and won't quote it | run `ac275880`'s failure text |
| 7 | `cancel()` on a live run published the half-built workspace | concurrency audit |
| 8 | `resume()` would start a second `#start` on one run id | concurrency audit |
| 9 | one `PreviewHost` singleton served run B's site under run A's URL | concurrency audit |

**#9 is the one worth remembering.** It is not a stale link: `#adversaryPhase` reads
`runs.previewUrl` and hands it to a live agent prompted *"Attack the running web app at
${previewUrl}"*. Two concurrent runs would have had A's adversary spend real quota attacking
B's artefact and file the findings under A.

---

## 3. THE THING THAT COST THE MOST WAS THE TICKET, NOT THE CODE

Two of the five runs died on **my own ticket**, and the second one generalises:

- Run 1 promised *"a reading of a reference page's motion is attached to this ticket"* and
  nothing was attached — a forward reference to nothing, written ninety minutes after
  committing the fix for that exact shape in `resumeBuilderPrompt`.
- Run 3 died on `[mis_specified] REQ-013`. The criterion was a near-transcription of a bullet
  I wrote: *"Each project page carries A, B, C and D"* — four obligations in one sentence,
  opening with a noun phrase EARS has no slot for. **The seat mirrored the shape it was
  given.**

> **The ticket's prose shape becomes the criterion's shape.**

The fix that worked was rewriting each requirement singly and in EARS form. That fix should
not have been mine to apply by hand — see §5.

---

## 4. THE PRINCIPLE THE OWNER SET, AND WHERE IT LANDED

> *"It should just have slight guides… Rest should just be judgement calls… if we limit the
> ai too much we will get no work done."*

Applied, and it is worth recording **which seat** each half belongs to, because they look
contradictory:

- **The builder should infer.** Its prompt opened with *"SHIP THE SIMPLEST THING THE TICKET
  ACTUALLY ASKS FOR"*, which was only ever a rule about *machinery* — don't bolt on a
  framework to prove effort — and was being read as a rule about *scope*. That is how run
  `54927ebc` shipped a `/work` page whose six cards linked nowhere. It now reads **"SIMPLE
  MACHINERY, FINISHED WORK"**, and says: if you find yourself thinking "the ticket did not ask
  for it" about something a reader would notice was missing, build it.
- **The spec seat should not.** It keeps *"do not invent user stories the ticket did not ask
  for"*, and must: grading someone against a requirement they never wrote is the
  unfair-criterion class that produced three of the previous run's seven failures.

**Inference belongs in the BUILD, not in the GRADE.** A test pins the split so a later edit
cannot "resolve" the apparent contradiction by making the builder timid again.

The one place prompt text was ADDED rather than removed is where the system was lying to the
model: `fix-prompt.ts` told the visual seat to *"serve the build… and look at it"*, and both
halves are impossible here.

---

## 5. WHAT IS STILL OPEN, RANKED BY WHAT IT COSTS TO LEAVE

1. **The ticket has no shape check.** `POST /api/runs` refuses an empty or over-long brief in
   milliseconds and says nothing about a sentence that conjoins four obligations. Cost of not
   having it, measured: three runs, ~6 hours, no verdict. The workaround was a human
   hand-writing EARS — a capability the pipeline needs, living in prose someone happens to
   know how to write.
2. **Repair before regenerate.** One bad statement discards the entire suite and burns one of
   three attempts. The research is unambiguous that self-correction works *with* an external
   verifier and fails without one — and the audit **is** an external verifier. Cheapest
   remaining reliability win.
3. **Semantic slots instead of a formatted sentence.** Have the seat emit
   `{intent, template, system, response}` and let the harness render the EARS string. The
   regex becomes unfailable by construction; there is no "Each" to write. Note from EMNLP 2024
   (*Let Me Speak Freely?*): the free-reasoning field must come FIRST in the schema, because
   generation is left-to-right.
4. **Aspect ratio is measured by nothing.** Two images still ship stretched —
   `leg-2-poster.webp` at ×0.69 and `leg-1-poster.webp` at ×0.28 — and **all 25 criteria
   passed over them.** The ticket asked for true proportions in prose; no criterion resulted.
   This is the visual-gate gap in one concrete instance.
5. **Concurrency above N=1** needs the same-ticket authoring race fixed. Different tickets are
   safe today; identical ticket text double-spends and fails one run.
6. **The published-folder split.** A follow-up run claims `projects/<slug>-<suffix>`, so the
   folder the owner has open keeps serving the *previous* artefact. Confirmed live tonight:
   `…-a-w-fccefcee` sits beside `…-a-w`.

---

## 6. TWO DEFECTS I INTRODUCED, RECORDED BECAUSE THE PATTERN IS THE LESSON

- `activeRunIds[0] ?? null === null` — parses as `?? (null === null)`. A wait predicate that
  can only succeed, in a test I had just written, in the session whose theme is that exact
  defect.
- `find -newermt '-10 minutes'` returned nothing and I read it as "the builder has stopped
  writing". BSD `find` will not parse the relative form. **This is catalogued in my own notes
  from a previous session and I walked into it anyway.**

Both were caught by checking rather than by review. Neither reached a commit.

---

## 7. THE RUN, FOR THE RECORD

Six project pages at `/work/<slug>`, verified by serving the artefact rather than by trusting
the verdict — 200 apiece, 5.4–6.3 KB, `/work/nonsense` → styled 404. All eight
project-page criteria met.

The two honest failures, both checked for grader artefacts and found genuine:

- **REQ-004** — a valid contact submission must answer 201. The failing test is the *visible*
  twin, which the builder had in its workspace.
- **REQ-019** — reduced motion. Specifically checked whether this was the leaf-element
  heuristic that made REQ-022 a false failure the night before. It is not: it calls
  `document.getAnimations()` and reads computed opacity. It measures.

Spend: spec 358k output, builder 358k, fix 25k, audit 20k, judge 5k.
