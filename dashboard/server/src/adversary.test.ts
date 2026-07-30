/**
 * adversary.test.ts — the ported `/debugfix --web --max` adversary pass.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import { shortlistFor } from "./agent-shortlist.js";
import type { Surface } from "./agent-shortlist.js";
import {
  ADVERSARY_AGENT,
  ADVERSARY_DISALLOWED_TOOLS,
  ADVERSARY_MAX_FINDINGS,
  ADVERSARY_RECORD_FILE,
  ADVERSARY_WRITE_TOOLS,
  adversaryCall,
  adversaryOptions,
  adversaryPassFromRecord,
  adversaryRecord,
  adversaryRefusal,
  parseAdversaryFindings,
  parseAgentDenylist,
  runAdversaryLane,
  shouldRunAdversary,
  summariseAdversary,
  withAdversaryFindings,
} from "./adversary.js";
import type { AdversaryCall, AdversaryFinding, AdversaryLaneDeps } from "./adversary.js";
import { planFixes } from "./fix-triage.js";
import type { AgentVisibleReport } from "./gate-report.js";

const EMPTY: AgentVisibleReport = {
  failures: [],
  heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
  infraFailure: null,
};

test("the adversary runs only against a running preview URL", () => {
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://127.0.0.1:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "fullstack", previewUrl: "http://127.0.0.1:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: null }), false, "no URL, no adversary");
  assert.equal(shouldRunAdversary({ surface: "cli", previewUrl: "http://127.0.0.1:4180" }), false);
});

test("a non-loopback URL is refused — the adversary is not pointed at somebody's server", () => {
  // preview.ts serves on 127.0.0.1 and nowhere else, so this can only be reached
  // by a future caller passing something else. It fails closed rather than
  // trusting that caller: the personas include rage-clicking "Pay" and racing
  // two accounts for one resource.
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://example.com" }), false);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://192.168.1.10:4180" }), false);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "http://localhost:4180" }), true);
  assert.equal(shouldRunAdversary({ surface: "web-ui", previewUrl: "not a url" }), false);
});

test("the adversary is mechanically read-only", () => {
  // human-factors-adversary declares disallowedTools covering Write/Edit/Agent
  // and every credential-bearing MCP server. It reports; it never fixes.
  const opts = adversaryOptions({ previewUrl: "http://127.0.0.1:4180" });
  assert.equal(opts.agent, "human-factors-adversary");
  assert.ok(opts.disallowedTools.includes("Write"));
  assert.ok(opts.disallowedTools.includes("Edit"));
  assert.ok(opts.disallowedTools.includes("Agent"), "it does not get to spawn something that can write");
});

test("every tool this module denies is denied by the agent on disk too", () => {
  // The frontmatter is the mechanism; this list is a copy of it, and a copy
  // drifts. If the agent file ever drops one of these, the claim "mechanically
  // read-only" stops being true and this test is what says so.
  //
  // IT NOW READS THE FILE THROUGH THE PRODUCTION PARSER. `parseAgentDenylist` is
  // what `#adversaryAgentDenylist` calls on every pass, so this test and the lane
  // are looking at the same list. A hand-rolled split here (which is what stood
  // in this test) could have agreed with the file while the lane's parser
  // disagreed, and the lane's answer is the one that decides whether the pass
  // runs at all.
  const path = join(homedir(), ".claude", "agents", "human-factors-adversary.md");
  const onDiskList = parseAgentDenylist(readFileSync(path, "utf8"));
  assert.ok(onDiskList !== null, "the agent declares a denylist at all");
  const onDisk = new Set(onDiskList);
  for (const tool of adversaryOptions({ previewUrl: "http://127.0.0.1:4180" }).disallowedTools) {
    assert.ok(onDisk.has(tool), `${tool} is denied here and NOT by the agent on disk`);
  }
});

test("parseAgentDenylist returns null for a file that denies nothing", () => {
  // Null is what makes `adversaryRefusal` treat a weakened file exactly as
  // harshly as a missing one: an agent with no denylist is not a read-only agent,
  // and the pass must not run behind one.
  assert.equal(parseAgentDenylist("no frontmatter here"), null);
  assert.equal(parseAgentDenylist("---\nname: x\nmodel: inherit\n---\nbody"), null, "no disallowedTools line");
  assert.equal(parseAgentDenylist("---\nname: x\ndisallowedTools:\n---\n"), null, "an empty list is not a list");
  assert.deepEqual(
    [...(parseAgentDenylist("---\nname: x\ndisallowedTools: Write, Edit , Agent\n---\n") ?? [])],
    ["Write", "Edit", "Agent"],
    "and a real one comes back trimmed",
  );
});

test("money and destructive attacks are gated to a proven test environment, failing closed", () => {
  // /debugfix section 0.5. The default is PROD-OR-UNKNOWN, which is the state
  // that forbids committing anything, and it is what a caller that says nothing
  // gets.
  const silent = adversaryOptions({ previewUrl: "http://127.0.0.1:4180" });
  assert.equal(silent.environment, "PROD_OR_UNKNOWN");
  assert.match(silent.prompt, /PROD-OR-UNKNOWN/);
  assert.doesNotMatch(silent.prompt, /environment=TEST/, "the unlock is not handed over by accident");

  const unlocked = adversaryOptions({ previewUrl: "http://127.0.0.1:4180", environment: "TEST" });
  assert.equal(unlocked.environment, "TEST");
  assert.match(unlocked.prompt, /environment=TEST/);
});

test("adversary findings become fix tasks, not gate failures", () => {
  // They are evidence, not a sealed verdict. They must not alter heldOutPass.
  const findings: readonly AdversaryFinding[] = [
    { severity: "HIGH", klass: "logic", summary: "double-submit creates two bookings", detail: "10/10 attempts" },
  ];
  const tasks = planFixes(withAdversaryFindings(EMPTY, findings));
  assert.ok(tasks.some((t) => t.agent === "debugger"));
});

test("an adversary finding never moves the held-out counts", () => {
  const before: AgentVisibleReport = {
    failures: [],
    heldOutUnmet: { BLOCKING: 1, FUNCTIONAL: 2, QUALITY: 0 },
    infraFailure: null,
  };
  const after = withAdversaryFindings(before, [
    { severity: "CRITICAL", klass: "logic", summary: "refund abuse nets money" },
  ]);
  assert.deepEqual({ ...after.heldOutUnmet }, { ...before.heldOutUnmet }, "heldOutPass is the sealed verdict");
  assert.equal(after.failures.length, 1);
  assert.match(String(after.failures[0]?.summary), /CRITICAL/, "severity survives so triage can order it");
});

test("no findings means no change at all", () => {
  assert.equal(withAdversaryFindings(EMPTY, []).failures.length, 0);
});

const SURFACES: readonly Surface[] = ["web-ui", "fullstack", "api", "cli", "library", "background-jobs"];

test("the shortlist permits the adversary on exactly the surfaces it would run on", () => {
  // THIS TEST REPLACED ITS OWN NEGATION. It used to assert the adversary was on
  // NO shortlist, which was true and was the gap: a delegated call to an agent
  // off `allowedAgents` is denied by the PreToolUse hook, and a denied agent
  // produces nothing distinguishable from an agent with nothing to do. The name
  // is now in `DELIVERY_LANES.review`.
  //
  // THE ORACLE IS THE OTHER PREDICATE, NOT A SECOND LIST OF SURFACES. "Which
  // surfaces have a browsable UI" is spelled in two modules — `WEB_SURFACES`
  // here and `WEB_REVIEW` plus the switch in `agent-shortlist.ts` — because a
  // permission boundary must not import a feature module that already imports
  // it. Comparing the two spellings against EACH OTHER is what makes them one
  // decision: a permission wider than the intent (shortlisted where the pass
  // will never run) and a permission narrower than it (the pass runs and every
  // delegated call is denied) both fail, and neither could be caught by a list
  // of surfaces written a third time inside this test.
  for (const surface of SURFACES) {
    const permitted = shortlistFor(surface).includes(ADVERSARY_AGENT);
    const intended = shouldRunAdversary({ surface, previewUrl: "http://127.0.0.1:4180" });
    assert.equal(
      permitted,
      intended,
      `${surface}: the shortlist ${permitted ? "permits" : "denies"} ${ADVERSARY_AGENT} and ` +
        `shouldRunAdversary ${intended ? "would run it" : "refuses to"}`,
    );
  }
  // The oracle must not be vacuous: if `shouldRunAdversary` answered the same
  // way for every surface, the loop above would pass against a shortlist that
  // ignored the surface entirely.
  assert.ok(
    SURFACES.some((s) => shouldRunAdversary({ surface: s, previewUrl: "http://127.0.0.1:4180" })) &&
      SURFACES.some((s) => !shouldRunAdversary({ surface: s, previewUrl: "http://127.0.0.1:4180" })),
    "the oracle answers both ways across these surfaces, or the comparison above proves nothing",
  );
});

test("the design lane's mode does not decide whether the adversary may run", () => {
  // `shortlistFor` has a second argument and its DEFAULT is `off`. The adversary
  // sits in REVIEW, not DESIGN, so it must survive a shortlist built with no
  // design lane at all — a web-ui run whose caller has not classified the lane
  // still gets its human-factors pass. Asserted because the two conditionals now
  // live in the same function and one could easily be made to gate the other.
  for (const mode of ["off", "degraded", "full"] as const) {
    assert.ok(
      shortlistFor("web-ui", mode).includes(ADVERSARY_AGENT),
      `a web-ui run with the design lane ${mode} still gets the adversary`,
    );
  }
});

/* -------------------------------------------------------------------------
 * THE LANE. What runs it, what refuses to run it, and what bounds it.
 *
 * EVERY ARM DRIVES `runAdversaryLane` ITSELF, with a `spawn` that THROWS if it is
 * called on a path that must not spawn. A refusal that still spawned would be
 * indistinguishable in every log line from one that did not, and it would cost
 * the same quota — so "did not spawn" is asserted by making the spawn fatal
 * rather than by counting log lines.
 * ---------------------------------------------------------------------- */

const GOOD_DENYLIST: readonly string[] = [...ADVERSARY_DISALLOWED_TOOLS];

function laneDeps(overrides: Partial<AdversaryLaneDeps> = {}): AdversaryLaneDeps {
  return {
    surface: "web-ui",
    previewUrl: "http://127.0.0.1:4180",
    scratchDir: "/runs/r1/results/adversary-scratch",
    artefactDir: "/runs/r1/workspace",
    agentDenylist: () => GOOD_DENYLIST,
    // Lexical here: these paths do not exist, and the ORCHESTRATOR passes
    // `canonicaliseForDecision` — the same resolver the sandbox and the write
    // guard use. See the orchestrator test that asserts the real scratch dir.
    canonicalise: (path) => path,
    spawn: () => {
      throw new Error("spawn must not be reached on this path");
    },
    ...overrides,
  };
}

test("THE LANE SPAWNS on a qualifying run, and the call carries the whole policy", async () => {
  const seen: AdversaryCall[] = [];
  const result = await runAdversaryLane(
    laneDeps({
      spawn: async (call) => {
        seen.push(call);
        return {
          findings: [{ severity: "HIGH", klass: "logic", summary: "double submit books twice" }],
          failure: null,
          reportWritten: true,
        };
      },
    }),
  );

  assert.equal(seen.length, 1, "exactly one session, not one per finding and not none");
  const call = seen[0];
  assert.ok(call !== undefined);
  assert.equal(call.agent, ADVERSARY_AGENT);
  assert.equal(call.previewUrl, "http://127.0.0.1:4180");
  assert.deepEqual([...call.allowedAgents], [ADVERSARY_AGENT], "no other agent may be delegated to");
  assert.equal(call.environment, "PROD_OR_UNKNOWN", "the unlock is never handed over by default");
  assert.ok(call.wallClockMs > 0, "a lane pointed at a live app needs a deadline");
  assert.equal(result.ran, true);
  assert.equal(result.stop, "ran");
  assert.equal(result.findings.length, 1);
});

test("THE DENIAL IS ON THE CALL THE LANE MAKES, not only in a constant", async () => {
  // Requirement: the tools must be denied on the call, not merely present in a
  // module-level array. The call is read here, at the boundary the orchestrator
  // hands to the spawner, and every write tool must be on it.
  // COLLECTED IN AN ARRAY rather than a `let`: TypeScript narrows a `let` assigned
  // only inside a callback to `never` after the await, which is the compiler
  // telling the truth about what it can see and not about what happens.
  const calls: AdversaryCall[] = [];
  await runAdversaryLane(
    laneDeps({
      spawn: async (call) => {
        calls.push(call);
        return { findings: [], failure: null, reportWritten: true };
      },
    }),
  );
  const made = calls[0];
  assert.ok(made !== undefined, "nothing was spawned, so there is no call to read");
  for (const tool of ADVERSARY_WRITE_TOOLS) {
    assert.ok(made.disallowedTools.includes(tool), `${tool} is not denied on the call the lane makes`);
  }
  assert.ok(made.disallowedTools.includes("Agent"), "it may not spawn something that can write");
  for (const server of ["mcp__stripe", "mcp__github", "mcp__supabase"]) {
    assert.ok(made.disallowedTools.includes(server), `${server} carries a credential and is not denied`);
  }
});

test("the session prompt carries the adversary's own prompt VERBATIM, and names the report file", async () => {
  const call = adversaryCall({ previewUrl: "http://127.0.0.1:4180", scratchDir: "/scratch" });
  // /debugfix §5: the child's prompt comes from a FIXED template. If the session
  // prompt paraphrased it, the environment rules and the evidence contract would
  // be whatever the orchestrating model felt like writing.
  assert.ok(call.sessionPrompt.includes(call.agentPrompt), "the adversary block is not embedded verbatim");
  assert.equal(call.agentPrompt, adversaryOptions({ previewUrl: "http://127.0.0.1:4180" }).prompt);
  assert.match(call.sessionPrompt, /PROD-OR-UNKNOWN/, "the safety branch travels with the call");
  assert.ok(call.findingsPath.startsWith("/scratch/"), "the report lands in the scratch dir");
  assert.match(call.sessionPrompt, new RegExp(call.findingsPath.replace(/\//gu, "\\/")));
  assert.match(call.sessionPrompt, /one Agent call/u, "the session is told to delegate, not to attack itself");
});

test("NO URL, NO SPAWN — and the same for a surface with no browsable UI", async () => {
  // The negative arm of the wiring. `spawn` throws, so a lane that "ran anyway
  // and reported nothing" fails here instead of looking identical to this one.
  const noUrl = await runAdversaryLane(laneDeps({ previewUrl: null }));
  assert.equal(noUrl.ran, false);
  assert.equal(noUrl.stop, "not-applicable");
  assert.equal(noUrl.call, null, "nothing was built, so nothing could have been spawned");

  const cli = await runAdversaryLane(laneDeps({ surface: "cli" }));
  assert.equal(cli.stop, "not-applicable");

  const remote = await runAdversaryLane(laneDeps({ previewUrl: "http://example.com" }));
  assert.equal(remote.stop, "not-applicable", "and it is never pointed at somebody else's server");
});

test("A WEAKENED AGENT FILE REFUSES THE PASS — the frontmatter is the mechanism", async () => {
  // This is the discriminating check for "ADVERSARY_DISALLOWED_TOOLS must actually
  // bind". The list that binds a delegated agent is the one in the agent file, so
  // the lane reads it and refuses when it no longer covers what this module
  // claims. A pass that ran behind a file with no `Write` denial would be an
  // adversary that can edit the artefact it is judging.
  const weakened = GOOD_DENYLIST.filter((tool) => tool !== "Write");
  const drift = await runAdversaryLane(laneDeps({ agentDenylist: () => weakened }));
  assert.equal(drift.ran, false, "it must not spawn behind a weakened denylist");
  assert.equal(drift.stop, "agent-denylist-drift");
  assert.match(drift.detail, /Write/u, "and it must say which tool went missing");

  const missing = await runAdversaryLane(laneDeps({ agentDenylist: () => null }));
  assert.equal(missing.ran, false);
  assert.equal(missing.stop, "agent-missing", "/debugfix §0.4: stop, never fall back to a generic agent");
});

test("THE SCRATCH DIR MUST NOT BE THE ARTEFACT, or a relative of it", () => {
  const call = adversaryCall({ previewUrl: "http://127.0.0.1:4180", scratchDir: "/runs/r1/results/scratch" });
  const base = { agentDenylist: GOOD_DENYLIST, canonicalise: (p: string) => p };

  assert.equal(
    adversaryRefusal({ ...base, call, artefactDir: "/runs/r1/workspace" }),
    null,
    "a sibling of the workspace is what the lane actually uses",
  );

  // The session's `cwd` is what scopes the sandbox's allowWrite and the
  // workspace-write guard. Pointed at the artefact, both layers would PERMIT
  // writing the thing under judgement — so the pass is refused instead.
  const inside = adversaryRefusal({
    ...base,
    call: adversaryCall({ previewUrl: "http://127.0.0.1:4180", scratchDir: "/runs/r1/workspace/scratch" }),
    artefactDir: "/runs/r1/workspace",
  });
  assert.equal(inside?.stop, "workspace-not-isolated");

  const same = adversaryRefusal({
    ...base,
    call: adversaryCall({ previewUrl: "http://127.0.0.1:4180", scratchDir: "/runs/r1/workspace" }),
    artefactDir: "/runs/r1/workspace",
  });
  assert.equal(same?.stop, "workspace-not-isolated");

  // The other direction too: a workspace INSIDE the scratch dir is the same
  // failure wearing different clothes.
  const contains = adversaryRefusal({
    ...base,
    call: adversaryCall({ previewUrl: "http://127.0.0.1:4180", scratchDir: "/runs/r1" }),
    artefactDir: "/runs/r1/workspace",
  });
  assert.equal(contains?.stop, "workspace-not-isolated");

  // AND THE CANONICALISER IS CONSULTED, not bypassed: a symlinked scratch dir that
  // really resolves inside the artefact must be refused, which is why the
  // orchestrator passes `canonicaliseForDecision` rather than a lexical resolve.
  const symlinked = adversaryRefusal({
    ...base,
    canonicalise: (p) => (p === "/runs/r1/results/scratch" ? "/runs/r1/workspace/sneaky" : p),
    call,
    artefactDir: "/runs/r1/workspace",
  });
  assert.equal(symlinked?.stop, "workspace-not-isolated", "the fs-aware resolution is what decides");
});

test("a call whose own denylist lost a write tool is refused before it is spawned", () => {
  // `ADVERSARY_DISALLOWED_TOOLS` is frozen, so this is the only way the condition
  // arises — a future edit to the constant, or a hand-built call. It fails closed
  // rather than trusting that no such edit will happen.
  const call: AdversaryCall = {
    ...adversaryCall({ previewUrl: "http://127.0.0.1:4180", scratchDir: "/scratch" }),
    disallowedTools: ["Agent"],
  };
  const refusal = adversaryRefusal({
    call,
    artefactDir: "/runs/r1/workspace",
    agentDenylist: GOOD_DENYLIST,
    canonicalise: (p) => p,
  });
  assert.equal(refusal?.stop, "denylist-incomplete");
  assert.match(refusal?.detail ?? "", /Write/u);
});

test("THE WALL CLOCK IS ENFORCED HERE, because no per-agent turn bound exists", async () => {
  // claude-builder.ts:886-891 measured `maxTurns` binding nothing for a delegated
  // agent, so this timer is the only bound this program can prove. A hung pass
  // would otherwise outlive the run holding a subscription seat.
  let sawAbort = false;
  const result = await runAdversaryLane(
    laneDeps({
      wallClockMs: 20,
      spawn: async (_call, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ findings: [], failure: "aborted", reportWritten: false });
          });
        }),
    }),
  );
  assert.equal(sawAbort, true, "the spawn was never actually aborted, so the bound is decoration");
  assert.equal(result.stop, "timeout");
  assert.match(result.detail, /wall clock/u);
});

test("a cancelled run does not start an adversary pass, and one in flight is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const before = await runAdversaryLane(laneDeps({ signal: controller.signal }));
  assert.equal(before.ran, false);
  assert.equal(before.stop, "cancelled");

  const live = new AbortController();
  let sawAbort = false;
  const result = await runAdversaryLane(
    laneDeps({
      signal: live.signal,
      spawn: async (_call, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ findings: [], failure: null, reportWritten: false });
          });
          live.abort();
        }),
    }),
  );
  assert.equal(sawAbort, true, "the run's own cancel must reach the session");
  assert.equal(result.stop, "cancelled");
});

test("findings are capped, so one runaway pass cannot become the whole backlog", async () => {
  const many: AdversaryFinding[] = [];
  for (let i = 0; i < ADVERSARY_MAX_FINDINGS + 7; i += 1) {
    many.push({ severity: "LOW", klass: "visual", summary: `finding ${String(i)}` });
  }
  const result = await runAdversaryLane(
    laneDeps({ spawn: async () => ({ findings: many, failure: null, reportWritten: true }) }),
  );
  assert.equal(result.findings.length, ADVERSARY_MAX_FINDINGS);
});

test("the report file is parsed defensively — model-written JSON is not trusted", () => {
  const parsed = parseAdversaryFindings(
    JSON.stringify([
      { severity: "CRITICAL", klass: "logic", summary: "refund abuse nets money", detail: "10/10" },
      { severity: "SEVERE", summary: "not a severity this program knows" },
      { severity: "HIGH", summary: "   " },
      { severity: "MEDIUM", klass: "not-a-class", summary: "klass falls back" },
      "a bare string",
      null,
    ]),
  );
  assert.equal(parsed.length, 2, "the unusable entries are DROPPED, never coerced");
  assert.equal(parsed[0]?.severity, "CRITICAL");
  assert.equal(parsed[1]?.klass, "logic", "an unknown class routes to the debugger, not to a design agent");
  assert.deepEqual([...parseAdversaryFindings("not json at all")], []);
  assert.deepEqual([...parseAdversaryFindings('{"severity":"HIGH","summary":"an object, not an array"}')], []);
  assert.equal(
    parseAdversaryFindings(
      JSON.stringify(Array.from({ length: 90 }, () => ({ severity: "LOW", summary: "x" }))),
    ).length,
    ADVERSARY_MAX_FINDINGS,
  );
});

test("THE RECORD IS WRITTEN FOR A REFUSAL TOO, and it never claims what it does not have", async () => {
  const refused = await runAdversaryLane(laneDeps({ previewUrl: null }));
  const record = adversaryRecord({ result: refused, surface: "web-ui", previewUrl: null });
  assert.equal(record.ran, false);
  assert.equal(record.stop, "not-applicable");
  assert.equal(record.gating, false, "a QUALITY-tier pass says so in the record it leaves behind");
  const notes = record.notes.join("\n");
  // /debugfix §0.3, verbatim requirement: never claim hook enforcement it does not
  // have. The spec (§8, "/debugfix integration") requires this to be stated.
  assert.match(notes, /in-workflow verification only/u);
  assert.match(notes, /NOT ARMED/u);
  assert.match(notes, /turn bound/u, "the missing per-agent turn bound is recorded, not papered over");
  assert.match(notes, /heldOutPass/u, "and so is the fact that it cannot move the verdict");

  const ran = await runAdversaryLane(
    laneDeps({ spawn: async () => ({ findings: [], failure: null, reportWritten: false }) }),
  );
  const silent = adversaryRecord({ result: ran, surface: "web-ui", previewUrl: "http://127.0.0.1:4180" });
  assert.match(
    silent.notes.join("\n"),
    /left no report file/u,
    "'the session said nothing' and 'the pass found nothing' are different statements",
  );
});

/* -------------------------------------------------------------------------
 * THE WIRE — `RunDetail.adversary`, and the distinction it exists to preserve
 *
 * WHAT IS UNDER TEST AND WHAT IS NOT. `adversaryPassFromRecord` is the mapper
 * `http.ts#toDetail` calls; these arms drive it through the REAL WRITE PATH —
 * `adversaryRecord(...)` → `redactForPersistence` → `JSON.stringify` — because
 * that is the byte sequence `#recordAdversary` produces, and a bit that the
 * redactor dropped would be invisible to a test that hand-built the JSON. What
 * is NOT under test, here or anywhere: whether a live adversary session ever
 * writes a report at all. THIS LANE HAS NEVER EXECUTED. Every arm below is a
 * reader proven against a writer that has never run in anger.
 *
 * THE ONE ASSERTION THAT MATTERS is that arms 1 and 2 DIFFER. A mapper that
 * returned `null` for everything passes arm 1; a mapper that returned `[]` for
 * everything passes arm 2; only the comparison catches both. Collapsing "the
 * pass left no report" into "the pass found nothing" is the defect this shape
 * was built to refuse, so it is asserted as a difference and not as two facts.
 * ---------------------------------------------------------------------- */

/** Exactly what `#recordAdversary` writes to `results/adversary.json`. */
function persisted(result: Awaited<ReturnType<typeof runAdversaryLane>>): string {
  const record = adversaryRecord({ result, surface: "web-ui", previewUrl: "http://127.0.0.1:4180" });
  return JSON.stringify(redactForPersistence(record), null, 2);
}

test("THE WIRE KEEPS 'no report' APART FROM 'no findings' — they must not be one value", async () => {
  const silent = await runAdversaryLane(
    laneDeps({ spawn: async () => ({ findings: [], failure: null, reportWritten: false }) }),
  );
  const reported = await runAdversaryLane(
    laneDeps({ spawn: async () => ({ findings: [], failure: null, reportWritten: true }) }),
  );

  const noReport = adversaryPassFromRecord(persisted(silent));
  const nothingFound = adversaryPassFromRecord(persisted(reported));

  assert.ok(noReport !== null && nothingFound !== null, "a written record must map to a pass, not to null");
  assert.equal(noReport.ran, true, "the session was spawned in both arms");
  assert.equal(nothingFound.ran, true);

  // ARM 1: it ran and filed nothing. `null` is "this program cannot see what it
  // found", which is not a statement about the app.
  assert.equal(noReport.findings, null);
  // ARM 2: it ran, filed, and found nothing. An EMPTY LIST is a measurement.
  assert.deepEqual(nothingFound.findings, [], "a report that found nothing is [], never null");

  // THE DISCRIMINATOR. Without this, a mapper hard-coded to either value passes
  // one arm above and looks correct.
  assert.notEqual(
    noReport.findings === null,
    nothingFound.findings === null,
    "the two cases produced the same wire value — the UI can no longer tell them apart",
  );

  // AND THE BIT IS A FIELD, NOT A SENTENCE. `notes` has always carried this in
  // prose; prose does not reach a renderer.
  const record = adversaryRecord({ result: silent, surface: "web-ui", previewUrl: "http://127.0.0.1:4180" });
  assert.equal(record.reportWritten, false);
  assert.match(record.notes.join("\n"), /left no report file/u, "the prose stays too, for the file's reader");
});

test("A REFUSAL IS 'declined', NOT 'found nothing' — ran:false with a null findings list", async () => {
  // The lane never spawned, so there is no report and there are no findings, and
  // both of those are the SAME fact here: nothing was measured. `stop` is what
  // says why, and a panel keying on `ran` cannot print "no usability problems".
  const refused = await runAdversaryLane(laneDeps({ previewUrl: null }));
  const pass = adversaryPassFromRecord(persisted(refused));
  assert.ok(pass !== null);
  assert.equal(pass.ran, false);
  assert.equal(pass.stop, "not-applicable");
  assert.equal(pass.findings, null, "a pass that never ran must never present an empty findings list");
  assert.match(pass.stopDetail, /loopback preview URL/u, "and it carries the lane's own sentence");
});

test("the findings themselves cross the wire — severity, class, sentence and repro", async () => {
  const result = await runAdversaryLane(
    laneDeps({
      spawn: async () => ({
        findings: [
          { severity: "HIGH", klass: "logic", summary: "double submit books twice", detail: "10/10 attempts" },
          // No `detail` at all: `AdversaryFinding.detail` is optional and
          // `exactOptionalPropertyTypes` is on, so the mapper must CONVERT it
          // rather than pass it through.
          { severity: "MEDIUM", klass: "visual", summary: "the error text is invisible on dark" },
        ],
        failure: null,
        reportWritten: true,
      }),
    }),
  );
  const pass = adversaryPassFromRecord(persisted(result));
  assert.ok(pass?.findings != null, "a report with findings must not map to null");
  assert.equal(pass.findings.length, 2);
  assert.deepEqual(
    { ...pass.findings[0] },
    {
      severity: "HIGH",
      klass: "logic",
      summary: "double submit books twice",
      detail: "10/10 attempts",
    },
    "the sentence is the whole point of this field — it must arrive intact",
  );
  assert.equal(pass.findings[1]?.detail, "", "a finding with no repro carries '', never undefined");
  assert.equal(pass.stop, "ran");
  assert.equal(pass.stopDetail, "", "a clean pass has no stop sentence");
});

test("the record reader refuses what it cannot read, and never invents a pass", () => {
  // EVERY ONE OF THESE IS `null` = "no pass on this run". A default-shaped pass
  // (`ran: false`, `stop: ""`) would render as a refusal that never happened.
  assert.equal(adversaryPassFromRecord("not json at all"), null);
  assert.equal(adversaryPassFromRecord("[]"), null, "an array is not a record");
  assert.equal(adversaryPassFromRecord("null"), null);
  assert.equal(adversaryPassFromRecord('{"ran":true}'), null, "no stop, so nothing can be said about it");
  assert.equal(adversaryPassFromRecord('{"stop":"ran"}'), null, "and `ran` is not defaulted either");
  assert.equal(adversaryPassFromRecord('{"ran":true,"stop":""}'), null, "an empty stop names nothing");

  // A RECORD FROM AN OLDER BUILD HAS NO `reportWritten` KEY. Unknown is carried
  // as "no report", never as "found nothing" — the same direction the rest of
  // this file fails in.
  assert.equal(
    adversaryPassFromRecord('{"ran":true,"stop":"ran","detail":"","findings":[]}')?.findings,
    null,
    "an old record with no reportWritten and no findings must not read as 'found nothing'",
  );
  // …unless it carries findings, which are themselves proof a report existed.
  const legacy = adversaryPassFromRecord(
    '{"ran":true,"stop":"ran","detail":"","findings":[{"severity":"LOW","klass":"visual","summary":"x"}]}',
  );
  assert.equal(legacy?.findings?.length, 1, "a non-empty list is proof of a report, whatever the flag says");
});

/* -------------------------------------------------------------------------
 * THE TWO ENDS THAT NOTHING ELSE JOINS
 *
 * TEXT, NOT BEHAVIOUR, and that is stated rather than implied. These read source
 * files and prove that a call site and a mirror EXIST and name each other. They
 * cannot prove the route serves a correct value — `toDetail` is module-private
 * and its own suite is `http.test.ts` — and they cannot prove anything renders.
 *
 * WHY THEY ARE HERE AT ALL. Item 18's original defect is a producer whose output
 * reaches "two files no route serves": a mapper that nothing calls, and a server
 * field with no client mirror, are both invisible to every typecheck in this
 * repo — the two packages are separate TypeScript programs. `contract-parity.ts`
 * is where the client-mirror leg belongs and it is outside this change's file
 * list; it is written here so the check exists, and it should MOVE there rather
 * than be duplicated.
 * ---------------------------------------------------------------------- */

/** Block comments first, then line comments — the contract-parity idiom. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function readSource(file: string, what: string): string {
  assert.ok(
    existsSync(file),
    `this check reads ${what} and it is not at ${file}. The file moved, or this test is running ` +
      "from an outDir that is not directly under dashboard/server.",
  );
  return withoutComments(readFileSync(file, "utf8"));
}

test("CONTRACT: the run response actually carries the pass — the mapper is called, not merely exported", () => {
  // Comments are stripped first, so the explanation ABOVE the line in http.ts is
  // not what satisfies this. `import.meta.dirname` is `dashboard/server/<outDir>`
  // at run time, so the sources sit one directory up.
  const http = readSource(join(import.meta.dirname, "..", "src", "http.ts"), "this package's http.ts");
  assert.match(
    http,
    /adversary: readAdversaryPass\(results\),/u,
    "toDetail does not put the pass on RunDetail: the mapper exists, the record is written, and no " +
      "route serves it — which is exactly the gap this change was made to close",
  );
  assert.match(
    http,
    /adversaryPassFromRecord\(readFileSync\(path, "utf8"\)\)/u,
    "the reader no longer goes through adversaryPassFromRecord, so the null-vs-empty rule it owns " +
      "is not the one the wire obeys",
  );
  // THE FILENAME IS ONE CONSTANT, NOT TWO LITERALS. `#recordAdversary` writes
  // `join(runPaths.results, ADVERSARY_RECORD_FILE)`; a reader that hardcoded
  // "adversary.json" would work today and go quietly blank the day the writer's
  // name changed.
  assert.match(
    http,
    /join\(resultsDir, ADVERSARY_RECORD_FILE\)/u,
    "the reader spells the record's filename itself instead of taking the writer's constant",
  );
  assert.doesNotMatch(
    http,
    new RegExp(`"${ADVERSARY_RECORD_FILE.replace(/\./gu, "\\.")}"`, "u"),
    "http.ts contains the record's filename as a literal, which is the drift the constant prevents",
  );
});

test("CONTRACT: the client mirrors the pass, or the field arrives and never renders", () => {
  // The two packages are separate TypeScript programs with no path between them.
  // A field on the server's RunDetail with no client mirror compiles clean on
  // BOTH sides, is serialised, arrives at the browser, and is unreachable.
  const client = readSource(
    join(import.meta.dirname, "..", "..", "src", "lib", "api-types.ts"),
    "the client's api-types.ts",
  );
  assert.match(
    client,
    /readonly adversary: AdversaryPass \| null;/u,
    "the client's RunDetail has no adversary field: the server sends it and the UI cannot see it",
  );
  for (const field of [
    /readonly ran: boolean;/u,
    /readonly stop: string;/u,
    /readonly stopDetail: string;/u,
    // THE NULLABLE LIST IS THE CONTRACT. A client that typed this
    // `readonly AdversaryFinding[]` would compile, render, and silently say "no
    // usability problems found" for a pass that filed no report.
    /readonly findings: readonly AdversaryFinding\[\] \| null;/u,
  ]) {
    assert.match(client, field, `the client's AdversaryPass is missing ${String(field)}`);
  }
  for (const field of [
    /readonly severity: "CRITICAL" \| "HIGH" \| "MEDIUM" \| "LOW";/u,
    /readonly klass: string;/u,
    /readonly summary: string;/u,
    /readonly detail: string;/u,
  ]) {
    assert.match(client, field, `the client's AdversaryFinding is missing ${String(field)}`);
  }
  // THE CAVEAT TRAVELS WITH THE TYPE. The brief for this field is that its
  // producer has never run; a mirror that dropped that sentence would hand the
  // next reader a channel that looks proven.
  assert.match(
    readFileSync(join(import.meta.dirname, "..", "..", "src", "lib", "api-types.ts"), "utf8"),
    /THIS LANE HAS NEVER EXECUTED/u,
    "the client mirror no longer states that the producer of this field has never run",
  );
});

test("the canvas summary says how many findings there were, and that it is non-gating", async () => {
  const result = await runAdversaryLane(
    laneDeps({
      spawn: async () => ({
        findings: [
          { severity: "CRITICAL", klass: "logic", summary: "a" },
          { severity: "LOW", klass: "visual", summary: "b" },
          { severity: "LOW", klass: "visual", summary: "c" },
        ],
        failure: null,
        reportWritten: true,
      }),
    }),
  );
  const summary = summariseAdversary(result);
  assert.match(summary, /3 finding\(s\)/u);
  assert.match(summary, /1 CRITICAL, 2 LOW/u);
  assert.match(summary, /non-gating/u);
  assert.match(summariseAdversary(await runAdversaryLane(laneDeps({ previewUrl: null }))), /did not run/u);
});
