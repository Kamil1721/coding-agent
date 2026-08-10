/**
 * fix-prompt.test.ts — what a fixing agent is told, and what it is bounded to.
 *
 * The leak property is asserted in `gate-fix-loop.test.ts`, at the seam where a
 * real container's report becomes a real prompt. These are the properties of the
 * text itself.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { WORKSPACE } from "bakeoff/dist/runner.js";
import { buildFixPrompt, fixAllowedAgents } from "./fix-prompt.js";
import type { AgentVisibleReport, FixableFailure } from "./gate-report.js";
import type { FixTask } from "./fix-triage.js";

const FAILURE: FixableFailure = {
  id: "GATE:build",
  klass: "build",
  summary: "npm run build",
  detail: "TS2345: Argument of type 'string' is not assignable",
  command: "npm run build",
  exitCode: 2,
};

const TASK: FixTask = { agent: "debugger", failures: [FAILURE] };

function report(patch: Partial<AgentVisibleReport> = {}): AgentVisibleReport {
  return { failures: [FAILURE], heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 }, infraFailure: null, ...patch };
}

test("a fix round may delegate to exactly one agent", () => {
  // The build's own shortlist is ~26 agents because the build is open-ended. A
  // fix round has one job triage already decided; the full shortlist would
  // invite a second exploratory build inside the loop that exists to be bounded.
  assert.deepEqual(fixAllowedAgents(TASK), ["debugger"]);
  assert.equal(fixAllowedAgents({ agent: "test-automator", failures: [] }).length, 1);
});

test("the prompt states the failure, the command and the exit code", () => {
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.match(p, /TS2345/);
  assert.match(p, /npm run build/);
  assert.match(p, /exit code: 2/);
  assert.match(p, /\/w/, "and where the workspace is, so it does not have to guess");
});

test("the prompt names the one agent this round permits", () => {
  // A boundary the fixer cannot see is one it discovers by hitting it, one
  // denied call and one turn at a time.
  assert.match(buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 }), /debugger/);
});

test("the prompt says the budget is finite, and which round this is", () => {
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 2, maxAttempts: 3 });
  assert.match(p, /round 2 of at most 3/);
});

test("the prompt states that editing the visible suite scores nothing", () => {
  // Not a scolding — a mechanical fact. Anthropic measured anti-cheating framing
  // producing HIGHER misalignment than neutral framing (doc 02 §5.6), and a
  // fixer that does not know this wastes its round discovering it.
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.match(p, new RegExp(`${WORKSPACE.visibleDir}/ changes nothing that is scored`));
  assert.doesNotMatch(p, /cheat|hack|misalign/i);
});

test("held-out counts appear as counts, and a satisfied suite says so", () => {
  const unmet = buildFixPrompt({
    task: TASK,
    report: report({ heldOutUnmet: { BLOCKING: 1, FUNCTIONAL: 2, QUALITY: 0 } }),
    workspace: "/w",
    attempt: 1,
    maxAttempts: 3,
  });
  assert.match(unmet, /1 BLOCKING, 2 FUNCTIONAL, 0 QUALITY/);
  assert.match(unmet, /not something I can tell you/);

  const met = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.match(met, /Every acceptance criterion is currently satisfied/);
  assert.doesNotMatch(met, /BLOCKING/, "no phantom counts when there is nothing to count");
});

/* -------------------------------------------------------------------------
 * THE VISUAL ROUTE
 *
 * A visual failure carries `command: null` and `exitCode: null` — every producer
 * of one sets them so (`gate-report.ts`). The generic instruction therefore names
 * a command that does not exist, and an agent handed work it cannot check is a
 * round spent for nothing while looking, from outside, exactly like a round that
 * tried.
 * ---------------------------------------------------------------------- */

function visualFailure(detail: string): FixableFailure {
  return {
    id: "dom:placeholder_text",
    klass: "visual",
    summary: "placeholder_text on flow home at 1280x800",
    detail,
    command: null,
    exitCode: null,
  };
}

function visualPrompt(detail: string): string {
  const failure = visualFailure(detail);
  return buildFixPrompt({
    task: { agent: "taste-frontend-expert", failures: [failure] },
    report: { failures: [failure], heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 }, infraFailure: null },
    workspace: "/w",
    attempt: 1,
    maxAttempts: 3,
  });
}

test("a visual task is told how to CHECK a fix, because there is no command to re-run", () => {
  const p = visualPrompt("the hero region contains only placeholder copy");
  assert.match(p, /no command to re-run/);
  assert.doesNotMatch(p, /re-run the failing command yourself/);
  // IT USED TO SAY "serve the build … and look at it", AND BOTH HALVES ARE
  // IMPOSSIBLE IN THIS SANDBOX: `listen()` is denied on every port, and Chromium
  // does not start — the builder on run 54927ebc wrote "so I never saw the site
  // rendered", and a probe on 2026-08-10 reproduced the launch failure with a
  // working negative control. Telling a seat to do the impossible spends a round
  // and teaches it the rest of the prompt is unreliable, so the instruction is
  // asserted ABSENT here rather than merely replaced.
  // Keyed to the INSTRUCTION, not the words: the corrected prompt still contains
  // "serve the build" inside "You cannot serve the build", which is the opposite
  // of the defect. What must be gone is the imperative.
  assert.doesNotMatch(p, /way to check a fix is to serve/, "the prompt must not ask for what listen() forbids");
  assert.doesNotMatch(p, /open the flow named above/, "nor for a rendered page it cannot open");
  assert.doesNotMatch(p, /and look at it\./, "nor end a plan in looking");
  assert.match(p, /YOU CANNOT SEE THE PAGE/, "it must say so plainly");
  assert.match(p, /global\.fetch/, "and give the technique that does work over no socket");
  // The two defect classes a source-only review misses unless it is told to look.
  assert.match(p, /height: auto|aspect-ratio/, "image geometry is invisible without a render");
  assert.match(p, /text-transform/, "so is casing that only exists in innerText");
  // The evidence itself still crosses — the summary alone does not say what was
  // wrong, only where.
  assert.match(p, /the hero region contains only placeholder copy/);
});

test("a visual task is told what it is being judged against", () => {
  // "Does it look good" is not the question and cannot be answered; "does it
  // match the reference this run locked" is, and the fixer cannot answer it
  // without being told the reference exists.
  const p = visualPrompt("nav overflows the viewport");
  assert.match(p, /design reference this run LOCKED/);
  assert.match(p, /match it rather than improve on it/);
});

test("a visual task is told the asset rule — the owner's standing rule, at the point of temptation", () => {
  // THIS IS THE ONLY PLACE IT IS SAID TO A FIXING AGENT. A design specialist
  // repairing a broken image reaches for an icon package or a stock-photo URL
  // because that is what its own skills recommend by name. Stating the rule where
  // the temptation is costs four lines; detecting the violation afterwards costs
  // a round, and detecting it never costs the product.
  const p = visualPrompt("an image has a natural width of zero");
  assert.match(p, /MUST BE GENERATED FOR THIS BUILD AND SHIPPED FROM THIS WORKSPACE/);
  assert.match(p, /No CDN link, no icon font, no icon package, no stock-photo URL, no remote webfont/);
  assert.match(p, /including the\s+ones your own skills recommend by name/);
  assert.match(p, /say which asset and\s+stop/, "and what to do when the asset genuinely does not exist");
});

test("a visual task is told that deleting the element is not a fix — mechanically, not as a scolding", () => {
  // Anthropic measured "only a misaligned AI would do X" framing producing HIGHER
  // misalignment than neutral framing (doc 02 §5.6). What is stated is a fact
  // about the measurement: the suite still asks for whatever was there.
  const p = visualPrompt("section#features is empty");
  assert.match(p, /Removing the element removes the element/);
  assert.match(p, /still asks for whatever was there/);
  assert.doesNotMatch(p, /cheat|hack|misalign/i);
});

test("a NON-visual task gets none of it", () => {
  // The negative control for all four tests above. An unconditional block would
  // satisfy every one of them while teaching the prompt builder nothing about
  // classes, and would lecture every debugger in the system about icon packages
  // while it read a compiler error.
  const p = buildFixPrompt({ task: TASK, report: report(), workspace: "/w", attempt: 1, maxAttempts: 3 });
  assert.doesNotMatch(p, /no command to re-run/);
  assert.doesNotMatch(p, /icon package/);
  assert.doesNotMatch(p, /design reference this run LOCKED/);
  assert.match(p, /re-run the failing command yourself/);
});

test("a visual detail that could locate a capture is WITHHELD, and says so", () => {
  // Masking is applied at capture time and is the only masking there is
  // (bakeoff/.gitignore), so a path in a fix prompt is an invitation to open an
  // image nobody vetted. `gate-report.ts` copies `domFindings[].detail` and the
  // screenshot gates' detail across with a length cap and NO allowlist, so this
  // is the boundary that closes it.
  const p = visualPrompt("flow home: review/screenshots/home__1280.png is blank");
  assert.doesNotMatch(p, /home__1280\.png/);
  assert.doesNotMatch(p, /review\/screenshots/);
  assert.match(p, /detail withheld/);
  // AND IT DOES NOT READ AS "THERE WAS NOTHING TO SAY", which is the other way a
  // redaction lies — `WITHHELD_DETAIL` exists for the same reason.
  assert.match(p, /render that flow at that breakpoint yourself and look at it/);
  // The summary survives: a flow and a breakpoint locate nothing on disk.
  assert.match(p, /placeholder_text on flow home at 1280x800/);
});

test("…and the withholding is fail-closed rather than fatal, because the run is unattended", () => {
  // `assertNoScreenshotReference` THROWS, which is right where it is called
  // today — inside record construction, where a throw is a programming error a
  // test catches. Here the identical throw would reject the loop's promise and
  // turn a FIXABLE visual failure into a crashed run at three in the morning. A
  // withheld detail costs the fixer one piece of evidence; a throw costs the
  // owner the night, and the boundary is equally closed either way.
  assert.doesNotThrow(() => visualPrompt("../../etc/passwd and design-refs/01-hero.png"));
  const p = visualPrompt("../../etc/passwd and design-refs/01-hero.png");
  assert.doesNotMatch(p, /01-hero\.png/);
  assert.doesNotMatch(p, /etc\/passwd/);
});

test("a NON-visual detail is not run through the capture guard — it would gut the debugger's evidence", () => {
  // The guard's pattern matches any `/` after whitespace or a quote, so
  // `TS2345 at src/app.ts:12` — the exact string the loop's leak test asserts
  // DOES cross — would be withheld, and a debugger told only "the build failed"
  // spends its round rediscovering the error it was already handed.
  const p = buildFixPrompt({
    task: { agent: "debugger", failures: [{ ...FAILURE, detail: "TS2345 at src/app.ts:12" }] },
    report: report({ failures: [{ ...FAILURE, detail: "TS2345 at src/app.ts:12" }] }),
    workspace: "/w",
    attempt: 1,
    maxAttempts: 3,
  });
  assert.match(p, /TS2345 at src\/app\.ts:12/);
  assert.doesNotMatch(p, /detail withheld/);
});
