---
document_status: findings
verified_at_commit: e5f9ce4
verified_on: 2026-09-02
---

# Why the pipeline's site loses to a chat session

The owner's judgement on 2026-09-02: the sites this pipeline delivers are far
worse than what the same model produces in an interactive chat given the same
ticket. This document records the mechanisms behind that gap, measured against
the code at `e5f9ce4` and the persisted artefacts of source run
`run-2026-08-26T16-56-51-065Z-3c0e92be`, its linked continuation
`run-cont-e22fa17f9b7972c79641` (the delivered site), and the two creative
recovery children `8a65087e` and `4c4285c5`.

Method: six independent readers, each finding checked by two independent
refuters (one against the code, one against the run artefacts). Fifteen
findings survived both. Nine were rejected on cause or impact although their
mechanism was real; those are listed at the end so nobody re-derives them.
Every load-bearing citation below was re-opened by the session author.

Seven corrections in this document came from an adversarial exchange with a
parallel prior-art study run in a second session. That study is
[RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md](RESEARCH-prior-art-ticket-to-software-agents-2026-09-02.md)
and the reconciliation, including four items credited to neither document, is
[COMPARISON-2026-09-03-prior-art-vs-internal-findings.md](COMPARISON-2026-09-03-prior-art-vs-internal-findings.md).
Carry-forward items are `BLIND-001` and `FIXPROMPT-001` in
[BACKLOG.md](BACKLOG.md).

## The delivered page, looked at

Full-page render of the continuation workspace at 1440 and 375: a hero, three
service line items, a "Selected work" section of two category rows titled
"Websites" and "Apps" over Gemini-generated drafting-instrument photographs,
both linking to the same portfolio URL, four process step titles, one
statement section, a contact block. About 660 lines of HTML, CSS and JS. The
ticket asked for a curated selection of verified projects from
kamilborzecki.dev. That site's JS bundle lists five named projects (Teewise,
Trade Assistant, JobSilver, Kori, Parts Agent). None appear.

## Ranked causes

### 1. The builder cannot see its own page (dominant)

**Mechanism.** `buildOptions` in `dashboard/server/src/builders/claude-builder.ts`
enables the CLI's OS sandbox with a filesystem clause only (`enabled: true` at
:1011, `filesystem: { allowWrite, denyRead }` at :1034) and no `sandbox.network`
clause at all. `orchestrator.test.ts:3591` pins that absence. Under seatbelt
defaults that denies loopback `listen()` (measured EPERM in every build) and
Mach lookup, so default-flag Chromium dies at `bootstrap_check_in` (continuation
`build.log:174`). The SDK's network options are `allowLocalBinding` (boolean),
`allowUnixSockets` and `allowMachLookup` (both arrays of names), declared at
`server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2749-2752`, and
none of them is set. The docblock naming Playwright as the use case for
`allowMachLookup` is at `:6171`, not beside the schema.

**These knobs alone are not the remedy, and an earlier draft implied they were.**
`bootstrap_check_in` *registers* a bootstrap service; `allowMachLookup` grants
*lookup*. The SDK package contains no `machRegister` key in any spelling
(grepped, zero hits), so no combination of the three can grant what default
multi-process Chromium needs. What removed the requirement in our own data was
the process model, not the sandbox: recovery child `8a65087e` ran
`--no-sandbox --disable-gpu --single-process` and completed 20 browser checks.

**Effect.** Both the source and continuation builders shipped layout that was
"reasoned and statically verified, not seen" (source `build.log:213`) and
verified the motion requirements by reading CSS rather than running it
(continuation `workspace/.bakeoff/self-report.json`). The pipeline does render
the page (sealed scorer captures at 375/768/1280), but no code path shows those
captures to the builder or the fixer: `fix-prompt.ts:62-99` replaces any
path-shaped visual detail with `WITHHELD_VISUAL_DETAIL`, and `:144` tells the
fixer "the renderer is not available to you". The builder is told the port is
sealed (`build-prompt.ts:372`) and never that it is blind; `build-prompt.ts`
contains no occurrence of "browser".

**Not a hard limit.** Recovery child `8a65087e` launched Chromium with
`--no-sandbox --disable-gpu --single-process`, served the workspace by route
interception, ran 20 browser checks and looked at sliced full-page screenshots
(`build.log:103`). Nothing in the pipeline carries that workaround forward.

**Fix shape.** Give the build seat a renderer, in this order of cost:

1. Hand the builder the host's own captures at segment boundaries. No sandbox
   change at all. Cheapest, and it also closes the withholding above.
2. An orchestrator-owned renderer outside the seal, which the builder requests.
3. The sandbox knobs *paired with* single-process Chromium. Only this arm has a
   successful precedent here, and the flag rather than the knobs is what makes
   it work.

### 2. Nobody judges quality before the builder says done

**Mechanism.** The only loop that can reopen the builder is the gate/fix loop,
and its prompt carries criterion failures only (`fix-prompt.ts:5-6`). Every
judge of rendered quality runs after the build declares done and feeds nothing
back: the visual-substance gate is SHADOW in all 13 persisted reports
(`visual-gate.md`: "NONE of them can fail this run"), the rendered Taste Critic
has `criticAttempt: null` in all 7 creative runs, Context7 has never executed,
the adversary has never run dynamically. Across 30 persisted runs, 0 had any
visual-quality signal reach the builder before it declared done.

**The one gating judge counts elements.** The spec seat authors from ticket
text alone, binary only, "never 'quality of X'", with QUALITY "REPORTED, NEVER
GATING" (`bakeoff/src/spec-agent.ts:204, 217, 231`). The delivered ticket's
frozen suite is 19 criteria; its content tests pass on `entries >= 2` under a
heading regex (`acceptance/t-cbf387df97b9b6dd/suite/holdout/page-content.spec.mjs:178-194`).
REQ-007 "a work section lists at least two distinct pieces of work" passed the
two placeholder rows (`results/scores/run-cont-e22fa17f9b7972c79641.json`).
Across all 30 runs the criteria table holds 342 criteria; none mention
palette, typography, hierarchy or composition.

**No build-versus-still comparison exists.** The only executed comparison
between the delivered capture and the locked still is a CIELAB ground-lightness
polarity bit, itself shadow-locked (`visual-substance.ts:422`). "Compile
passed" re-reads the contract JSON; it never opens the HTML.

**Fix shape.** A rendered-quality judge that runs before done and can send the
builder back with the picture, not a sentence about it. The critic route exists
in code (`ea54c35`, `e5f9ce4`); it has never completed.

### 3. The builder is told the wrong thing

**A blind contract seat writes the page before the design exists.**
`#creativeContractPhase` (`orchestrator.ts:2512`) runs before `#specPhase`
(:2536) and `#buildPhase` (:2584). In the source run the contract was frozen at
17:02Z, 48 minutes before the first design still existed. The author has "exactly
one turn ... no tools, shell, browser, MCP, workspace access"
(`creative-contract-author.ts:319`), and the seat class states it outright: "the
PLAN seat can see the owner's pictures, and every seat downstream of it cannot"
(`subscription-caller.ts:1965-1966`). From ticket text it fixes headline and
body strings, layout families, section and motion ids. The locked still says
"Websites and apps, made to last."; the contract headline shipped instead.
Nothing downstream checks which one the build followed. The contract is
re-authored per run with no memory (`CreativeContractAuthorInput` carries no
prior contract): the source froze `r.home` and `s.*` ids with a bento services
section; the continuation froze `home`, unprefixed ids, a new `positioning`
section and a vertical-stack services section for the same ticket. That drift
is what refused the critic capture on the continuation and what the recovery
children spent 141 turns renaming.

**The build turn never receives the first-turn prompt.** On every design-lane
run the build segment resumes the design session, so `orchestrator.ts:5934`
takes the `resumeBuilderPrompt` arm and `dashboardBuilderPrompt`, the only
prompt that embeds the owner's words, the working agreement, the finished-work
bullets and the delegation section, is never sent (`build-prompt.ts:673-677`
records this). Measured: 0 of 87 non-blank `TICKET.md` lines appear in the
46,747-byte build prompt; the prompt's own pointer to "the ticket text above"
dangles. The brief is not lost, it is frozen into `direction.md` and the
contract, but the builder builds to a pre-decided page rather than to the owner.

**The fact source is never rendered.** The pipeline owns exactly one
JS-rendering reader, `captureSite` in `site-capture.ts:389`, and points it at
the first URL in the ticket (`site-capture.ts:203`, "THE FIRST URL WINS"). That
was the style reference, progressionlabs.com. The facts source,
kamilborzecki.dev, is an SPA whose HTML is a 2,249-byte shell; the builder's two
`WebFetch` calls returned only the title (source `build.log:134`), the build
seat has `allowedMcpServers: []` (`claude-builder.ts:1007`) and no browser, and
the count-only gate waved the placeholders through. The plan seat that could
have asked the owner exists and fired once on the continuation for a scope
question; it never reached content facts.

**Fix shape.** Author copy after the design, with the stills in view. Render
every URL the ticket makes binding, not only the first. Carry the contract
forward on continuation instead of re-authoring it.

### 4. The builder is taxed by the grader

**After the first draft, every turn is conformance.** 329 builder turns across
the four runs (source 42+21+56+10, continuation 13+19+27, recovery 74 and
53+14). After the source's 56-turn build lane, the 210 further turns produced
only gate-driven changes in the delivered site: a scroll-based reveal rewrite
and an opacity nudge from the fix round, and a net 13-line skip-link rule from
the continuation. The design lane may not write application code
(`design-prompt.ts:178`); every lane that may touch code is scoped to closing a
failure (`fix-prompt.ts:185`) or to marker repair (`orchestrator.ts:9106`,
"Stop after the marker/state repair is complete"). The recovery children's
141 turns of edits diverge from the delivered workspace and never shipped.

**A continuation restarts cold and re-runs the design lane.**
`createTerminalContinuation` copies only the workspace tree
(`run-continuation.ts:70`) and mints a new run with no builder session. The
copied `design-refs/manifest.json` carries absolute paths into the old run's
directory, and `readDesignManifest` drops any ref outside `refsDir`
(`design-manifest.ts:467`), so the continuation scheduled a fresh canvass and
expansion before building. Those two segments used 32 of its 59 builder turns
and about 96k of its 114k output tokens re-validating a design it kept
byte-for-byte ("Zero images regenerated", continuation `build.log:45, 96`;
`design-lane.json` records 0 image calls).

**The renderer probes only the marked node.** The injected probe diffs
transform/opacity on the `[data-motion-id]` element alone under a hover
trigger (`creative-render.ts:242, 267`), and its refusal carries no explanation
(`:1073`). The builder must reverse-engineer the rule and move attributes for
the probe rather than the visitor. That is what the last recovery attempt
died on: `m-contact-state` was still not observed after the one allowed
repair (events seq 276 of `4c4285c5`).

**Fix shape.** Let a design-capable lane touch code after a render review.
Copy the results tree and the resolved manifest on continuation. Make the
renderer's refusal say what it watched and what it saw.

### 5. Model and effort — an untested configuration difference, not a ranked cause

Kept in the list because it is a real and unexplained asymmetry, demoted because
it asserts no measured delta and carries no fix shape. Nothing here was shown to
change the delivered page.

`models.ts:129` pins `BUILDER_EFFORT = "high"` and `claude-builder.ts:1039`
passes it explicitly on every design, build, fix and recovery call. The
owner's `~/.claude/settings.json:364` runs chat at `"effortLevel": "xhigh"`, and
the pipeline's own spec, audit and judge seats run xhigh. The seat that writes
the page is one rung below the model the owner talks to and below the graders.
The docblock justifies the pin with the xhigh-to-max marginal, not the
high-to-xhigh step. Turn caps, context (peak 11% of 1M) and rate limits were
checked and are not a mechanism in these runs.

Spend is measured but inert for quality: the continuation's spec seat produced
362,095 output tokens against the builder's 114,367, and the run row shows only
builder plus adversary (151,023). That is an observability gap
(`writeRunSpend` has no production caller), not a cause of the thin page.

## Rejected findings, so nobody re-derives them

- **Video lane harm.** The scroll-scrub mandate is real, ticket-independent and
  falsely attributed to the reference, and the builder shipped a 717 KB mp4 of
  its own mockup behind the work rows. A gradient overlay at 90% hides it; the
  measured render shows no visible second layer. Payload waste, not a visual cause.
- **Font prohibition.** The no-fetched-asset rule is real and the page ships
  system fallbacks, but the causal link to visible quality was not established.
- **Graders outspend the page-writer.** True and causally inert; the builder
  ended every segment on its own report, well under the 400-turn cap.
- **No owner channel for content facts.** The plan seat exists and fired. The
  cause is the fact source never being rendered plus a count-only gate.
- **MCP servers stripped as the binding cause.** True, but the binding cause is
  the single JS-rendering reader aimed at the wrong URL and no bundle fallback.
- **Ticket-less build prompt as a budget problem.** The bytes are absent but
  the brief is frozen into direction and contract; the effect is "builds to a
  pre-decided page", not lost context.

Three more were rejected and an earlier draft of this list omitted them, which
is the silent-truncation failure this document is otherwise about. All three
were rejected on wording while their mechanism survived through another lens,
and each is already carried above under the cause named:

- **Blind pre-design contract seat** (builder-prompt lens). Rejected because two
  citations did not support what they were cited for: `tools: []` does not blind
  the seat, since an image is content rather than a tool call, and the input
  validator it named filters prose, not attachments. The same mechanism was
  confirmed from the design lens and is cause 3.
- **After the first draft every turn is conformance** (contract-tax lens).
  Rejected on two wording points: the delivered site did also receive the fix
  round's reveal rewrite, and design was not "removed from scope" by prompts but
  by two structural rules. The corrected version is cause 4.
- **Video lane ships the greeked mockup as a background** (design lens). A
  second, distinct video finding. Rejected because a 90% gradient overlay makes
  the layer invisible in the measured render, so it is payload cost, not a
  visual defect.

## Delegation topology, measured

Recorded here because a reader studying the builder's agent topology will
otherwise reach the wrong conclusion from the tool log alone.

The builder runs headless under the Claude Agent SDK and **does** spawn
subagents: 4 `Agent` calls in the source run (starting seq 101, "Author 3 art
directions + 6 stills", whose child is recorded at seq 104 as
`taste-frontend-expert`) and 4 in the continuation. That much is production
behaviour.

Peer-addressed messaging is **not**. Every `SendMessage` attempt in the entire
run history was denied by this repo's own `PreToolUse` hook, by deliberate
policy: 5 attempts, 5 denials, 0 allowed, across runs `fccefcee`, `e1c15359`,
`6a39e96e`, `b1219c2d` and `3c0e92be`. The denial string is
`AGENT_MESSAGE_DENIAL` at `delegation-hook.ts:225`, and its docblock explains
the fail-closed reasoning: `PreToolUse` never sees the target `agentId`, which
appears only in the Agent tool's *result*, so a hook inspecting `to` would be
judging a display name against nothing.

The remediation works, and tightly. In all five cases the event at `seq + 1` is
a fresh `Agent` delegation whose description preserves the blocked message's
intent. No intervening turn, no loss of intent.

| Run | Deny | Blocked message | Delegation at `seq + 1` |
|---|---|---|---|
| `fccefcee` | 265 | Retry field-notebook work still | Fix field-notebook work still |
| `e1c15359` | 293 | One retry on margin-notebook work | Retry margin-notebook work still |
| `6a39e96e` | 339 | One retry on footer still, denser | Retry editorial-ledger footer still |
| `b1219c2d` | 422 | Expand warm-editorial to full page | Expand warm-editorial full page |
| `3c0e92be` | 251 | Regenerate two work stills, taste findings | Fix two work stills |

A refusal an agent can act on beats one it can only absorb. Scoring refusals
that way is three-valued here, not binary, and an earlier draft of this section
got it wrong by calling the fix seat a blank:

| Refusal | Remediation offered | Outcome |
|---|---|---|
| Delegation hook, `SendMessage` | start a fresh `Agent` delegation | followed 5 of 5 |
| `VISUAL_INSTRUCTIONS`, routing case | shim `global.fetch`, run the real tests over no socket | actionable |
| `WITHHELD_VISUAL_DETAIL`, visual case | render the flow and look at it | impossible here |

Only the third is a failure, and it is one string.

## The fix prompt contradicts itself, in one prompt, for cause 1's own class

`VISUAL_INSTRUCTIONS` tells the fix seat "YOU CANNOT SEE THE PAGE ... Any plan
that ends in \"then I'll look at it\" is a plan that ends in nothing"
(`fix-prompt.ts:145`). The comment directly above it (`:137-142`) records that
this block *used to* say "serve the build … and look at it", that both halves
are impossible here, measured on run `54927ebc` and re-measured 2026-08-10 with
a negative control, and states the principle: "An instruction to do the
impossible costs a turn and teaches the seat to distrust the rest of the
prompt."

Ten lines above that comment, `WITHHELD_VISUAL_DETAIL` (`:62-67`) still ends
"render that flow at that breakpoint yourself and look at it." `renderFailure`
(`:107`) substitutes it for exactly `klass === "visual"`, and `hasVisual`
(`:202`) pushes `VISUAL_INSTRUCTIONS` into that same prompt. Both strings reach
the same seat, for the same failure class, in the same prompt.

**Executed, not reasoned.** Building the real prompt through
`dist/fix-prompt.js` with the test suite's own two fixtures:

| Fixture | "cannot see the page" | "look at it yourself" |
|---|---|---|
| detail with no path | present | absent |
| detail with a path | present | **present** |

So any visual failure whose detail is path-shaped, which is the common case
since these findings are written about captures, gets both instructions at once.

**Both sides are pinned green by separate tests.** `fix-prompt.test.ts:131`
asserts the prompt does *not* end a plan in looking; `:198` asserts the prompt
*does* contain the instruction to look. Same helper, different fixtures, both
passing. Neither test can see the other, so the pair is the signature defect in
its purest form: two probes, each observing only its own success condition.

The remedy is one string, and it is not a code change this document makes.

**Read the hook decision, not the tool call.** In the source run the
`SendMessage` tool event is seq 249 and its denial is seq 251. Reading 249
alone yields the false claim that peer messaging is in use here. This is the
project's signature defect arriving in a report about the project's signature
defect.

## Still unmeasured

- Whether the builder ever opened the design stills: `build.log` records
  assistant prose only; no tool-use records survive.
- Whether the Taste Critic prompt would surface real defects if it ran; no
  persisted critic output exists to inspect.
- What a run produces once the build seat can see the page. That is the first
  experiment, and per the fix shape above it should start with handed-over host
  captures rather than with the sandbox knobs, which cannot launch default
  Chromium on their own.
- Whether the effort pin in section 5 changes anything. No delta has been
  measured in either direction.
