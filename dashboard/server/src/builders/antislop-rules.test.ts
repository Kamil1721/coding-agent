/**
 * antislop-rules.test.ts — the Layer-1 ruleset and the Layer-2 motion bar, both
 * directions, per rule.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This file exercises the PURE decisions —
 * text in, findings out. The HOOK is exercised through `buildOptions` in
 * `antislop-hook.test.ts`, because a test that builds its own matcher and
 * invokes it is `settings-plumbing.test.ts` again: it asserts the
 * implementation equals itself and stays green when nothing hands the matcher to
 * the SDK.
 *
 * EVERY RULE IS TESTED IN BOTH DIRECTIONS, and the second direction is the one
 * that costs something. A rule that denies its violation and ALSO denies the
 * thing one character away from it is a rule that will stop real work — and it
 * would pass a violation-only suite. The near-misses below are not decorative:
 * `letter-spacing:-.03em` is `calibration/correct-portfolio`'s real value,
 * `images.unsplash.com/photo-…` is a chosen photograph rather than a generator,
 * and `border-left:1px` is AT craft-floor's floor rather than above it.
 *
 * THE LAYER-2 CASES USE FIXTURES THIS PHASE DID NOT AUTHOR.
 * `calibration/correct-portfolio` is the project's GOOD artefact and
 * `calibration/stock-motion-only` is its named motion failure; grading them the
 * wrong way round is the failure this bar exists to catch, and neither file was
 * written to make these tests pass.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANTISLOP_RULES,
  decideMotion,
  isArtefactPath,
  scanForSlop,
  type WorkspaceFile,
} from "./antislop-rules.js";

/** A private outDir sits at the same depth as `src/builders/`, by house rule. */
function fixture(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../calibration/${relative}`, import.meta.url)), "utf8");
}

function fixtureFiles(dir: string, names: readonly string[]): readonly WorkspaceFile[] {
  return names.map((name) => ({ path: `/ws/${name}`, text: fixture(`${dir}/${name}`) }));
}

/* ───────────────────── Layer 1: both directions, per rule ───────────────────── */

interface RuleCase {
  readonly ruleId: string;
  readonly file: string;
  /** Must produce this rule. */
  readonly violation: string;
  /** Must NOT produce this rule. The half that keeps the gate off real work. */
  readonly nearMiss: string;
  /** Why the near-miss is legitimate, in one line. */
  readonly why: string;
}

const CASES: readonly RuleCase[] = [
  {
    ruleId: "AS-PLACEHOLDER-IMAGE",
    file: "hero.html",
    violation: `<img src="https://picsum.photos/seed/hero/1200/800" alt="">`,
    nearMiss: `<img src="https://images.unsplash.com/photo-1518791841217-8f162f1e1131" alt="A cat">`,
    why: "a specific chosen photograph is not a placeholder generator",
  },
  {
    ruleId: "AS-PLACEHOLDER-IMAGE",
    file: "hero.html",
    violation: `<img src="https://source.unsplash.com/random/800x600" alt="">`,
    nearMiss: `<a href="https://unsplash.com/photos/abc123">credit</a>`,
    why: "`unsplash.com` without `/random` is a credit link, not a generator",
  },
  {
    ruleId: "AS-LOREM-IPSUM",
    file: "about.html",
    violation: `<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`,
    nearMiss: `<p>She named the loremIpsum helper after the filler she refused to ship.</p>`,
    why: "an identifier is not shipped copy; the rule anchors to the two words adjacent",
  },
  {
    ruleId: "AS-PURPLE-PINK-GRADIENT",
    file: "theme.css",
    violation: `.hero{background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%)}`,
    nearMiss: `.hero{background:linear-gradient(135deg,#0ea5e9 0%,#14b8a6 100%)}`,
    why: "blue to teal lands in neither hue band — gradients are not banned, this one is",
  },
  {
    ruleId: "AS-PURPLE-PINK-GRADIENT",
    file: "page.jsx",
    violation: `<h1 className="bg-gradient-to-r from-violet-600 to-pink-500">Ada</h1>`,
    nearMiss: `<h1 className="bg-gradient-to-r from-amber-500 to-rose-500">Ada</h1>`,
    why: "amber is not in the purple family; only a purple `from-` with a pink `to-` is the cliche",
  },
  {
    ruleId: "AS-GRADIENT-TEXT",
    file: "type.css",
    violation:
      `.title{background:linear-gradient(90deg,#0ea5e9,#14b8a6);` +
      `-webkit-background-clip:text;-webkit-text-fill-color:transparent}`,
    nearMiss: `.title{background:#0ea5e9;background-clip:padding-box;color:#fff}`,
    why: "`background-clip` on its own is a background decision, not gradient text",
  },
  {
    ruleId: "AS-GRADIENT-TEXT",
    file: "page.tsx",
    violation: `<h1 className="bg-gradient-to-r from-sky-400 to-teal-300 bg-clip-text text-transparent">Ada</h1>`,
    nearMiss: `<span className="text-transparent select-none">skeleton</span>`,
    why: "`text-transparent` alone is how a skeleton or an icon-only button hides a label",
  },
  {
    ruleId: "AS-COLORED-BORDER-SIDE",
    file: "callout.css",
    violation: `.callout{border-left:4px solid #8a5a2b;padding:1rem}`,
    nearMiss: `.callout{border-left:1px solid #8a5a2b;border-top:4px solid #8a5a2b;padding:1rem}`,
    why: "1px is AT craft-floor's floor, and the floor names left/right only — `border-top` is free",
  },
  {
    ruleId: "AS-COLORED-BORDER-SIDE",
    file: "tabs.css",
    violation: `.tab{border-right:3px solid rgb(138 90 43)}`,
    nearMiss: `.tab{border-right:3px solid transparent}`,
    why: "a transparent side border is a layout reservation, not colour",
  },
  {
    ruleId: "AS-TIGHT-TRACKING",
    file: "display.css",
    violation: `.display{letter-spacing:-.06em}`,
    nearMiss: `.display{letter-spacing:-.03em}`,
    why: "correct-portfolio's real value, and the leading zero is optional in CSS",
  },
  {
    ruleId: "AS-TIGHT-TRACKING",
    file: "display.css",
    violation: `.display{letter-spacing:-0.041em}`,
    nearMiss: `.display{letter-spacing:-0.04em}`,
    why: "-0.04em IS the floor; the rule fires below it, not at it",
  },
  {
    ruleId: "AS-TIGHT-TRACKING",
    file: "page.tsx",
    violation: `<h1 className="tracking-tighter">Ada</h1>`,
    nearMiss: `<h1 className="tracking-tight">Ada</h1>`,
    why: "Tailwind's `tighter` is -0.05em and `tight` is -0.025em — one character, two sides of the floor",
  },
  {
    ruleId: "AS-TIGHT-TRACKING",
    file: "display.css",
    violation: `.display{letter-spacing:-0.05rem}`,
    nearMiss: `.display{letter-spacing:-2px}`,
    why: "px tracking is not comparable to an em floor without a font size; the rule abstains",
  },
  {
    ruleId: "AS-EYEBROW-EVERYWHERE",
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
    why: "craft-floor allows one named kicker as a system; the third is where it becomes grammar",
  },
  {
    ruleId: "AS-INTER-SLATE-DEFAULT",
    file: "globals.css",
    violation: `body{font-family:Inter,system-ui,sans-serif;color:#0f172a;background:#f8fafc}`,
    nearMiss: `body{font-family:Inter,system-ui,sans-serif;color:#0f172a}h1{font-size:clamp(2.5rem,8vw,6rem)}`,
    why: "Inter is fine once something in the type has been decided — the third conjunct is load-bearing",
  },
  {
    ruleId: "AS-INTER-SLATE-DEFAULT",
    file: "globals.css",
    violation: `body{font:16px/1.6 Inter,system-ui,sans-serif;color:#334155}`,
    nearMiss: `body{font:16px/1.6 Georgia,serif;color:#334155}`,
    why: "the slate ramp under a chosen serif is a neutral, not the boilerplate",
  },
];

for (const c of CASES) {
  test(`${c.ruleId} DENIES its violation and ALLOWS the near-miss (${c.why})`, () => {
    const denied = scanForSlop(`/ws/${c.file}`, c.violation).map((f) => f.ruleId);
    assert.ok(
      denied.includes(c.ruleId),
      `expected ${c.ruleId} on ${JSON.stringify(c.violation)}, got ${JSON.stringify(denied)}`,
    );
    const allowed = scanForSlop(`/ws/${c.file}`, c.nearMiss).map((f) => f.ruleId);
    assert.ok(
      !allowed.includes(c.ruleId),
      `${c.ruleId} fired on a LEGITIMATE near-miss (${c.why}): ${JSON.stringify(c.nearMiss)}`,
    );
  });
}

test("every shipped rule has a both-directions case — adding a rule without one FAILS", () => {
  // WITHOUT THIS, THE TABLE ABOVE IS OPTIONAL. A new rule could ship untested
  // and every existing test would stay green, which is the shape of failure this
  // repo has recorded nine times.
  const covered = new Set(CASES.map((c) => c.ruleId));
  const uncovered = ANTISLOP_RULES.map((r) => r.id).filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `shipped rules with no violation/near-miss case: ${uncovered.join(", ")}`);
});

test("every rule carries a source citation and an actionable reason", () => {
  // The reason reaches the MODEL verbatim as an `is_error` tool_result. A rule
  // with a terse or empty reason is a mysterious build failure with extra steps.
  for (const rule of ANTISLOP_RULES) {
    assert.ok(
      ["craft-floor.md", "spec §8 Layer 1", "spec §8 Layer 2"].includes(rule.source),
      `${rule.id} cites no known source`,
    );
    assert.ok(rule.reason.length > 80, `${rule.id}'s reason is too short to act on`);
  }
});

/* ──────────────────────────── the artefact gate ──────────────────────────── */

test("Layer 1 scans PAGES, not prose about pages", () => {
  // THIS IS NOT A CONVENIENCE. The denial reasons quote the banned literals, so
  // an unscoped rule would deny the model writing down why it was denied — and
  // this file, `antislop-rules.ts`, the plan and `visual-criteria.ts` would all
  // be unwritable by the system that enforces them.
  const slop = `<img src="https://picsum.photos/600/400">`;
  assert.equal(scanForSlop("/ws/index.html", slop).length, 1);
  assert.equal(scanForSlop("/ws/NOTES.md", slop).length, 0);
  assert.equal(scanForSlop("/ws/decisions.txt", slop).length, 0);
  assert.equal(scanForSlop("/ws/Makefile", slop).length, 0);
});

test("the artefact gate reads the EXTENSION, not the path", () => {
  assert.equal(isArtefactPath("/ws/src/components/Hero.tsx"), true);
  assert.equal(isArtefactPath("/ws/styles/main.SCSS"), true);
  assert.equal(isArtefactPath("/ws/README.md"), false);
  // A dotfile is not an artefact with an extension. `.gitignore` would otherwise
  // read as extension `.gitignore`.
  assert.equal(isArtefactPath("/ws/.gitignore"), false);
  assert.equal(isArtefactPath("/ws/LICENSE"), false);
});

/* ─────────────────────── Layer 2: the motion bar ─────────────────────── */

test("the GOOD artefact PASSES the motion bar — rAF, no library", () => {
  // `calibration/correct-portfolio` is the project's good artefact, and it uses
  // IntersectionObserver plus `requestAnimationFrame` with a stagger and NO
  // animation library at all. A bar that mandated GSAP would grade it — and the
  // owner's own kamilborzecki.dev, which runs `document.getAnimations() === 0` —
  // a failure. That is how a quality bar gets deleted after it embarrasses
  // itself once.
  const verdict = decideMotion(fixtureFiles("correct-portfolio", ["index.html", "app.js", "style.css"]));
  assert.equal(verdict.kind, "satisfied");
});

test("the STOCK-MOTION artefact FAILS the motion bar, and the reason names why", () => {
  const verdict = decideMotion(fixtureFiles("stock-motion-only", ["index.html", "app.js", "style.css"]));
  assert.equal(verdict.kind, "unsatisfied");
  assert.ok(verdict.kind === "unsatisfied" && /hover|transition|stock/i.test(verdict.reason));
  // The reason must list what WOULD satisfy it, or the agent is told "no" with
  // no route to "yes".
  assert.ok(verdict.kind === "unsatisfied" && /scroll-scrubbed/i.test(verdict.reason));
  assert.ok(verdict.kind === "unsatisfied" && /GSAP|ScrollTrigger/i.test(verdict.reason));
});

test("a workspace with no web surface ABSTAINS — a CLI has no page to animate", () => {
  const verdict = decideMotion([
    { path: "/ws/src/index.ts", text: "export function main(): void {}" },
    { path: "/ws/README.md", text: "# tool" },
  ]);
  assert.equal(verdict.kind, "abstain");
});

test("a CLI that ships a STYLESHEET still abstains — a stylesheet is not a page", () => {
  // MEASURED NEAR-MISS, and it changed the code. `.css`/`.scss` were in the
  // web-surface set until this exact workspace came back `unsatisfied` — a CLI
  // that prints a styled report, told to add a scroll-scrubbed video. Something
  // being styled is never evidence that something is a page.
  const verdict = decideMotion([
    { path: "/ws/src/index.ts", text: "export function main(): void {}" },
    { path: "/ws/report.css", text: "body{font:14px/1.5 Georgia,serif}table{border-collapse:collapse}" },
    { path: "/ws/README.md", text: "# a CLI that prints a styled report" },
  ]);
  assert.equal(verdict.kind, "abstain");
});

test("each satisfier stands ALONE — no single library may be mandated", () => {
  const page: WorkspaceFile = { path: "/ws/index.html", text: "<main></main>" };
  const scrub: WorkspaceFile = {
    path: "/ws/app.js",
    text: "const p = window.scrollY / h; video.currentTime = p * 4;",
  };
  assert.equal(decideMotion([page, scrub]).kind, "satisfied");

  const gsap: WorkspaceFile = {
    path: "/ws/app.js",
    text: "gsap.timeline({scrollTrigger:{trigger:'#a',scrub:true,pin:true}});",
  };
  assert.equal(decideMotion([page, gsap]).kind, "satisfied");

  const framer: WorkspaceFile = {
    path: "/ws/Hero.tsx",
    text: "const { scrollYProgress } = useScroll(); const y = useTransform(scrollYProgress, [0,1], [0,-200]);",
  };
  assert.equal(decideMotion([page, framer]).kind, "satisfied");
});

test("a library IMPORTED but never driven fails, and the reason says so", () => {
  const verdict = decideMotion([
    { path: "/ws/index.html", text: "<main></main>" },
    { path: "/ws/app.js", text: "import gsap from 'gsap';\nbutton.classList.add('is-ready');" },
  ]);
  assert.equal(verdict.kind, "unsatisfied");
  assert.ok(verdict.kind === "unsatisfied" && /imported .* never driven/i.test(verdict.reason));
});
