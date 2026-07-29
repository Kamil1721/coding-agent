/**
 * antislop-corpus.mjs — Phase 2a's false-positive AND true-positive measurement.
 *
 *   node antislop-corpus.mjs                 # against ./dist
 *   ANTISLOP_DIST=dist-mine node antislop-corpus.mjs
 *   node antislop-corpus.mjs --json          # machine-readable
 *
 * WHY BOTH NUMBERS, AND WHY THE SECOND ONE IS THE IMPORTANT ONE.
 * "Zero false positives" is what a ruleset that matches NOTHING scores. This
 * project has nine recorded instances of a check that could only observe
 * success, and a false-positive report is the exact place to add a tenth: one
 * rule reading `content` where `Edit` actually sends `new_string` scans the
 * empty string forever, never fires, and reports a perfect record.
 *
 * So this harness fails on either side:
 *
 *   FALSE POSITIVE  any hit on `calibration/correct-portfolio` — a GOOD
 *                   artefact. A rule that fires there will fire on real work.
 *                   Hits elsewhere in the repo are reported and classified.
 *   TRUE POSITIVE   any shipped rule with ZERO hits, anywhere, across the real
 *                   corpus and the constructed violations. A rule that cannot
 *                   fire is not a rule.
 *   WIRING          each constructed violation is additionally pushed through
 *                   the REAL `makeAntiSlopHook` as a `Write`, an `Edit` and a
 *                   `NotebookEdit` payload. `scanForSlop` being right does not
 *                   make the hook right: the keys differ per tool and a wrong
 *                   one is invisible to a text-level test.
 *
 *   MOTION       `decideMotion` is a NINTH rule, and the one that gates
 *                COMPLETION rather than one write, so it gets the same corpus
 *                treatment. Exercising it only against the two fixtures it was
 *                written for is how a completion gate ships that blocks
 *                legitimate builds — which is exactly what the `dashboard/src`
 *                row caught.
 *
 * HITS IN OUR OWN FILES ARE EXPECTED AND ARE NEVER A REASON TO LOOSEN AN ANCHOR.
 * `antislop-rules.ts`, its tests and `visual-criteria.ts` necessarily contain
 * `picsum`, `placehold.co`, `unsplash.com/random` and lorem ipsum — they define
 * and grade the rules. They are split into `[own-source]` (written by this
 * phase, so NOT independent evidence) and `[self-reference]` (pre-existing).
 * The rule this replaces is the one that matched the English word "fit" inside
 * CSS `object-fit`, and the fix for that was a better anchor, not a shorter
 * corpus.
 *
 * `bakeoff/` IS DELIBERATELY OUT OF THE CORPUS: another agent is rebuilding it
 * in this session, so its file set is not stable enough for a number anyone can
 * reproduce. Stated rather than silently skipped.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SERVER, "..", "..");
const DIST = process.env.ANTISLOP_DIST ?? "dist";

const { ANTISLOP_RULES, decideMotion, scanForSlop, isArtefactPath } = await import(
  join(SERVER, DIST, "builders", "antislop-rules.js")
);
const { makeAntiSlopHook } = await import(join(SERVER, DIST, "builders", "antislop-hook.js"));

/* ───────────────────────────────── corpora ───────────────────────────────── */

/**
 * Real source, none of it written for these rules.
 *
 * `kind` is what a hit MEANS, and getting it wrong is how a report lies in the
 * comfortable direction:
 *
 *   good      `correct-portfolio` is a GOOD artefact. A hit is a BLOCKING false
 *             positive — a rule that fires here will fire on real work.
 *   bad       the other calibration fixtures are known-defective artefacts. A
 *             hit is a TRUE positive; counting it as a false one would push the
 *             rules towards matching nothing.
 *   neutral   this repo's own source. A hit is a candidate false positive
 *             unless the file is in the self-reference set below.
 */
const REAL_CORPUS = [
  { label: "correct-portfolio (GOOD artefact)", root: "dashboard/server/calibration/correct-portfolio", kind: "good" },
  { label: "other calibration fixtures (KNOWN BAD)", root: "dashboard/server/calibration", kind: "bad", exclude: ["correct-portfolio"] },
  { label: "server source", root: "dashboard/server/src", kind: "neutral" },
  { label: "client source", root: "dashboard/src", kind: "neutral" },
];

/**
 * Files this PHASE authored. Hits here prove the rule fires, but against text
 * written by the same hand that wrote the rule — so they are labelled
 * `[own-source]` and do NOT count as independent evidence.
 */
const OWN_SOURCE = new Set([
  "dashboard/server/src/builders/antislop-rules.ts",
  "dashboard/server/src/builders/antislop-rules.test.ts",
  "dashboard/server/src/builders/antislop-hook.ts",
  "dashboard/server/src/builders/antislop-hook.test.ts",
]);

/** Pre-existing files that GRADE the same material. Not written for these rules. */
const SELF_REFERENCE = new Set([
  "dashboard/server/src/visual-criteria.ts",
  "dashboard/server/src/visual-criteria.test.ts",
]);

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".next", "coverage", "results", "runs"]);

async function walk(root, exclude = []) {
  const out = [];
  const go = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        if (exclude.includes(entry.name)) continue;
        if (dir.startsWith(join(REPO, "dashboard", "server")) && entry.name.startsWith("dist")) continue;
        await go(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isArtefactPath(full)) continue;
      const size = await stat(full).then((s) => s.size).catch(() => Infinity);
      if (size > 2 * 1024 * 1024) continue;
      const text = await readFile(full, "utf8").catch(() => null);
      if (text !== null) out.push({ path: full, text });
    }
  };
  await go(root);
  return out;
}

/**
 * ONE CONSTRUCTED VIOLATION AND ONE LEGITIMATE NEAR-MISS PER SHIPPED RULE.
 *
 * The near-miss is the half that costs something to get right: a rule that
 * denies its violation and also denies the thing one character away from it is a
 * rule that will stop real work, and it would pass a violation-only harness.
 */
const CONSTRUCTED = {
  "AS-PLACEHOLDER-IMAGE": {
    file: "hero.html",
    violation: `<img src="https://picsum.photos/seed/hero/1200/800" alt="">`,
    nearMiss: `<img src="https://images.unsplash.com/photo-1518791841217-8f162f1e1131" alt="A cat">`,
  },
  "AS-LOREM-IPSUM": {
    file: "about.html",
    violation: `<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`,
    nearMiss: `<p>Ada named the loremIpsum helper after the placeholder she refused to ship.</p>`,
  },
  "AS-PURPLE-PINK-GRADIENT": {
    file: "theme.css",
    violation: `.hero{background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%)}`,
    nearMiss: `.hero{background:linear-gradient(135deg,#0ea5e9 0%,#14b8a6 100%)}`,
  },
  "AS-GRADIENT-TEXT": {
    file: "type.css",
    violation: `.title{background:linear-gradient(90deg,#0ea5e9,#14b8a6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}`,
    nearMiss: `.title{background:#0ea5e9;background-clip:padding-box;color:#fff}`,
  },
  "AS-COLORED-BORDER-SIDE": {
    file: "callout.css",
    violation: `.callout{border-left:4px solid #8a5a2b;padding:1rem}`,
    nearMiss: `.callout{border-left:1px solid #8a5a2b;border-top:4px solid #8a5a2b;padding:1rem}`,
  },
  "AS-TIGHT-TRACKING": {
    file: "display.css",
    violation: `.display{letter-spacing:-.06em;font-size:4rem}`,
    nearMiss: `.display{letter-spacing:-.03em;font-size:4rem}`,
  },
  "AS-EYEBROW-EVERYWHERE": {
    file: "page.jsx",
    violation: [
      `<p className="text-xs uppercase tracking-widest">Work</p>`,
      `<p className="text-xs uppercase tracking-widest">About</p>`,
      `<p className="text-xs uppercase tracking-widest">Contact</p>`,
    ].join("\n"),
    nearMiss: [
      `<p className="text-xs uppercase tracking-widest">Chapter one</p>`,
      `<p className="text-xs uppercase tracking-widest">Chapter two</p>`,
    ].join("\n"),
  },
  "AS-INTER-SLATE-DEFAULT": {
    file: "globals.css",
    violation: `body{font-family:Inter,system-ui,sans-serif;color:#0f172a;background:#f8fafc}`,
    nearMiss: `body{font-family:Inter,system-ui,sans-serif;color:#0f172a}h1{font-size:clamp(2.5rem,8vw,6rem)}`,
  },
};

/* ───────────────────────────────── measure ───────────────────────────────── */

const falsePositives = new Map(ANTISLOP_RULES.map((r) => [r.id, []]));
const selfReferences = new Map(ANTISLOP_RULES.map((r) => [r.id, []]));
const truePositives = new Map(ANTISLOP_RULES.map((r) => [r.id, []]));
const onGoodArtefact = new Map(ANTISLOP_RULES.map((r) => [r.id, []]));
const perCorpus = [];
let scanned = 0;

for (const source of REAL_CORPUS) {
  const files = await walk(join(REPO, source.root), source.exclude ?? []);
  perCorpus.push({ label: source.label, kind: source.kind, files: files.length });
  for (const file of files) {
    scanned += 1;
    const rel = relative(REPO, file.path);
    for (const finding of scanForSlop(file.path, file.text)) {
      const line = `${rel}: ${finding.evidence}`;
      if (source.kind === "good") {
        onGoodArtefact.get(finding.ruleId).push(line);
        falsePositives.get(finding.ruleId).push(line);
      } else if (source.kind === "bad") {
        truePositives.get(finding.ruleId).push(`[bad fixture] ${line}`);
      } else if (OWN_SOURCE.has(rel)) {
        selfReferences.get(finding.ruleId).push(line);
        truePositives.get(finding.ruleId).push(`[own-source] ${line}`);
      } else if (SELF_REFERENCE.has(rel)) {
        selfReferences.get(finding.ruleId).push(line);
        truePositives.get(finding.ruleId).push(`[self-reference] ${line}`);
      } else {
        falsePositives.get(finding.ruleId).push(line);
        truePositives.get(finding.ruleId).push(`[repo source] ${line}`);
      }
    }
  }
}

// Constructed violations, through the REAL scanner AND the REAL hook.
const hookFailures = [];
for (const [ruleId, sample] of Object.entries(CONSTRUCTED)) {
  const path = `/ws/${sample.file}`;
  const hits = scanForSlop(path, sample.violation).filter((f) => f.ruleId === ruleId);
  if (hits.length > 0) truePositives.get(ruleId).push(`[constructed] ${hits[0].evidence}`);
  const nearMissHits = scanForSlop(path, sample.nearMiss).filter((f) => f.ruleId === ruleId);
  if (nearMissHits.length > 0) {
    hookFailures.push(`${ruleId}: the LEGITIMATE near-miss was flagged — ${nearMissHits[0].evidence}`);
  }

  // The keys differ per tool and a wrong one is a silent no-op. Each payload is
  // the real SDK shape: FileWriteInput.content, FileEditInput.new_string,
  // NotebookEditInput.new_source.
  for (const [tool, payload] of [
    ["Write", { file_path: path, content: sample.violation }],
    ["Edit", { file_path: path, old_string: "x", new_string: sample.violation }],
    ["NotebookEdit", { notebook_path: `/ws/${sample.file}`, new_source: sample.violation }],
  ]) {
    const hook = makeAntiSlopHook({ escalateAfter: 99 }).hooks[0];
    const out = await hook(
      { hook_event_name: "PreToolUse", tool_name: tool, tool_input: payload },
      "t1",
      { signal: new AbortController().signal },
    );
    const denied = out?.hookSpecificOutput?.permissionDecision === "deny";
    if (!denied) hookFailures.push(`${ruleId}: the hook ALLOWED the violation via ${tool}`);
  }
}

/* ────────────── Layer 2: the motion bar gets the same treatment ────────────── */

/**
 * `decideMotion` IS A NINTH RULE, and the one that blocks COMPLETION rather than
 * one write — so it gets a false-positive corpus too. Exercising it only against
 * the two fixtures it was written for is how a completion gate ships that
 * blocks legitimate builds.
 *
 * `expected: null` means REPORT, DO NOT FAIL. `dashboard/src` is the entry that
 * matters: it is this repo's own client, it comes back `unsatisfied`, and that
 * measurement is why the Layer-2 hook is opt-in rather than always-on
 * (`MOTION_BAR_ENV` in claude-builder.ts). It is recorded here so the next
 * reader does not have to re-derive it — or, worse, arm the gate without it.
 */
const MOTION_CASES = [
  { label: "calibration/correct-portfolio (GOOD)", root: "dashboard/server/calibration/correct-portfolio", expected: "satisfied" },
  { label: "calibration/stock-motion-only (BAD)", root: "dashboard/server/calibration/stock-motion-only", expected: "unsatisfied" },
  { label: "calibration/missing-section", root: "dashboard/server/calibration/missing-section", expected: "unsatisfied" },
  { label: "calibration/reward-hacked", root: "dashboard/server/calibration/reward-hacked", expected: "unsatisfied" },
  { label: "calibration/broken-build", root: "dashboard/server/calibration/broken-build", expected: "unsatisfied" },
  { label: "calibration/stub-markers", root: "dashboard/server/calibration/stub-markers", expected: "unsatisfied" },
  { label: "calibration/blank-page", root: "dashboard/server/calibration/blank-page", expected: "unsatisfied" },
  { label: "dashboard/server/src (non-web node package)", root: "dashboard/server/src", expected: "abstain" },
  { label: "dashboard/src (THIS REPO'S CLIENT)", root: "dashboard/src", expected: null },
];

const motionRows = [];
const motionFailures = [];
for (const c of MOTION_CASES) {
  const files = await walk(join(REPO, c.root));
  const verdict = decideMotion(files);
  motionRows.push({ label: c.label, files: files.length, kind: verdict.kind, expected: c.expected });
  if (c.expected !== null && verdict.kind !== c.expected) {
    motionFailures.push(`${c.label}: expected ${c.expected}, got ${verdict.kind}`);
  }
}

// A constructed near-miss that already changed the code once: `.css`/`.scss`
// were in the web-surface set until this workspace came back `unsatisfied`.
const cliWithStylesheet = decideMotion([
  { path: "/ws/src/index.ts", text: "export function main(): void {}" },
  { path: "/ws/report.css", text: "body{font:14px/1.5 Georgia,serif}" },
]);
if (cliWithStylesheet.kind !== "abstain") {
  motionFailures.push(`a CLI that ships a stylesheet got "${cliWithStylesheet.kind}" — a stylesheet is not a page`);
}

/* ───────────────────────────────── report ───────────────────────────────── */

const rows = ANTISLOP_RULES.map((rule) => ({
  id: rule.id,
  source: rule.source,
  falsePositives: falsePositives.get(rule.id).length,
  onCorrectPortfolio: onGoodArtefact.get(rule.id).length,
  selfReferences: selfReferences.get(rule.id).length,
  truePositives: truePositives.get(rule.id).length,
  truePositiveKinds: [...new Set(truePositives.get(rule.id).map((l) => l.slice(0, l.indexOf("]") + 1)))],
  examples: truePositives.get(rule.id).slice(0, 3),
}));

const deadRules = rows.filter((r) => r.truePositives === 0).map((r) => r.id);
const firesOnGood = rows.filter((r) => r.onCorrectPortfolio > 0).map((r) => r.id);
/** Rules whose ONLY evidence is text this phase authored. Reported, not failed. */
const AUTHORED_HERE = new Set(["[constructed]", "[own-source]"]);
const constructedOnly = rows.filter((r) => r.truePositiveKinds.every((k) => AUTHORED_HERE.has(k))).map((r) => r.id);

const failures = hookFailures.length + motionFailures.length + deadRules.length + firesOnGood.length;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { scanned, perCorpus, rows, motionRows, hookFailures, motionFailures, deadRules, firesOnGood, constructedOnly },
      null,
      2,
    ),
  );
} else {
  console.log(`scanned ${scanned} artefact files (bakeoff/ excluded — another agent is rebuilding it)\n`);
  for (const c of perCorpus) console.log(`  ${String(c.files).padStart(3)} files  ${c.kind.padEnd(8)} ${c.label}`);
  console.log("\nrule                       src              FP   onGOOD  self   TP  kinds");
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(26)} ${r.source.padEnd(16)} ${String(r.falsePositives).padStart(2)}   ` +
        `${String(r.onCorrectPortfolio).padStart(4)}   ${String(r.selfReferences).padStart(3)}  ` +
        `${String(r.truePositives).padStart(3)}  ${r.truePositiveKinds.join(" ")}`,
    );
  }
  console.log("\nevidence, first three per rule:");
  for (const r of rows) for (const e of r.examples) console.log(`  ${r.id}  ${e}`);
  const real = rows.filter((r) => r.falsePositives > 0);
  if (real.length > 0) {
    console.log("\nCANDIDATE FALSE POSITIVES (hits on GOOD or on this repo's own non-defining source):");
    for (const r of real) for (const l of falsePositives.get(r.id)) console.log(`  ${r.id}  ${l}`);
  }
  if (constructedOnly.length > 0) {
    console.log(
      `\nNOTE — every hit is text THIS PHASE AUTHORED for: ${constructedOnly.join(", ")}. ` +
        "They fire, and their near-misses are allowed, but no pre-existing file in the corpus " +
        "violates them. Stated rather than rounded up: unproven against text written by another hand.",
    );
  }
  console.log("\nLAYER 2 — the motion bar over the same kind of corpus:");
  for (const r of motionRows) {
    const verdictNote = r.expected === null ? "  <- REPORTED, not gated (see MOTION_BAR_ENV)" : "";
    console.log(`  ${String(r.files).padStart(3)} files  ${r.kind.padEnd(12)} ${r.label}${verdictNote}`);
  }
  console.log("");
  for (const f of hookFailures) console.log(`WIRING FAILURE  ${f}`);
  for (const f of motionFailures) console.log(`MOTION FAILURE  ${f}`);
  for (const d of deadRules) console.log(`DEAD RULE       ${d} — zero hits anywhere. A rule that cannot fire is not a rule.`);
  for (const g of firesOnGood) console.log(`FALSE POSITIVE  ${g} — fires on correct-portfolio, a GOOD artefact.`);
  console.log(
    failures === 0
      ? "\nOK — every rule fires somewhere, none fires on the GOOD artefact, every near-miss allowed,\n" +
          "     and the motion bar grades the GOOD artefact satisfied and the bad ones not."
      : "\nFAILED",
  );
}

process.exit(failures === 0 ? 0 : 1);
