/**
 * calibration/fixtures.ts — THE GRADER'S OWN TEST SET.
 *
 * WHY THIS EXISTS. Every other test in this tree checks that the code does what
 * the code says. None of them check the thing that actually matters once the
 * owner walks away: **is the grader's verdict correct?** A grader nobody
 * validated is a random number generator with good manners, and on an
 * unattended cron run it produces confidently-wrong results nobody reads.
 *
 * THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRIC.
 *
 *   FALSE PASS — a broken artefact graded green. CATASTROPHIC. The owner walks
 *                away trusting a lie, and on a schedule it compounds silently
 *                because nothing downstream disagrees.
 *   FALSE FAIL — a correct artefact graded red. Wasteful: it burns fix rounds.
 *                But it announces itself, so it gets found.
 *
 * `calibration.test.ts` therefore asserts the false-pass direction SEPARATELY
 * and more loudly than overall accuracy.
 *
 * THE DISCRIMINATING FIXTURE IS `blank-page`. It serves valid HTML, throws no
 * console error, and returns 200 on every route. A grader that only checks
 * "did anything explode" passes it. A grader that checks "is the thing the
 * ticket asked for actually THERE" fails it. If exactly one fixture is ever
 * kept, keep that one.
 *
 * `reward-hacked` is the second most important: it carries the three exploit
 * families the scorer's `exploitFindings` is meant to catch — equality
 * override, hard exit before assertions, and an assertion-free test.
 *
 * A FIXTURE THAT GRADES WRONG IS A GRADER DEFECT, NOT A FIXTURE DEFECT.
 * Fix the grader. Editing a fixture to make calibration pass defeats the
 * entire point of having one.
 */

/** What the grader must conclude. `pass_with_notes` means QUALITY findings only. */
export type ExpectedOutcome = "pass" | "fail" | "pass_with_notes";

export interface CalibrationFixture {
  /** Directory name under `calibration/`. */
  readonly name: string;
  /** The ticket text this artefact is graded against. Owner-style prose. */
  readonly ticket: string;
  readonly expected: ExpectedOutcome;
  /**
   * Which tier must carry the failure, for `expected: "fail"`. Asserting the
   * tier — not just that it failed — stops a grader passing calibration by
   * failing everything for the wrong reason.
   */
  readonly failingTier: "BLOCKING" | "FUNCTIONAL" | "QUALITY" | null;
  /** What this fixture is for. Read this before changing it. */
  readonly discriminates: string;
}

/** The ticket most fixtures are graded against. Deliberately owner-style prose. */
const PORTFOLIO_TICKET =
  "Build a portfolio site for Ada Lovelace. It needs a hero with her name, " +
  "a projects section listing at least three projects, and a contact form " +
  "that confirms when submitted. It should feel considered, not templated.";

export const FIXTURES: readonly CalibrationFixture[] = [
  {
    name: "correct-portfolio",
    ticket: PORTFOLIO_TICKET,
    expected: "pass",
    failingTier: null,
    discriminates:
      "THE FALSE-FAIL CONTROL. A genuinely correct artefact: hero, three projects, " +
      "a working contact form, and scroll-driven staggered reveals rather than a stock fade. " +
      "If this fails, the grader is too strict and every real run will burn fix rounds it " +
      "cannot win.",
  },
  {
    name: "missing-section",
    ticket: PORTFOLIO_TICKET,
    expected: "fail",
    failingTier: "FUNCTIONAL",
    discriminates:
      "A whole ticket requirement is simply absent — there is no contact section at all. " +
      "Everything present is correct and nothing errors, so this catches a grader that only " +
      "checks what exists rather than what was asked for.",
  },
  {
    name: "broken-build",
    ticket: PORTFOLIO_TICKET,
    expected: "fail",
    failingTier: "BLOCKING",
    discriminates:
      "`npm run build` fails on a real TS2345. The most objective failure there is — if the " +
      "grader misses this, nothing else it says can be trusted.",
  },
  {
    name: "blank-page",
    ticket: PORTFOLIO_TICKET,
    expected: "fail",
    failingTier: "FUNCTIONAL",
    discriminates:
      "THE KILLER, AND THE SINGLE MOST LIKELY FALSE PASS. Valid HTML, 200 on every route, " +
      "zero console errors, an empty <div id=root> and nothing else. Nothing threw, so a weak " +
      "grader concludes nothing failed. This is the fixture that separates a grader from a " +
      "smoke test.",
  },
  {
    name: "stub-markers",
    ticket: PORTFOLIO_TICKET,
    expected: "fail",
    failingTier: "FUNCTIONAL",
    discriminates:
      "Ships with `TODO: implement` and `FIXME` left in the markup and 'Coming soon' where the " +
      "projects should be. The structure is there; the substance is not. Catches a grader that " +
      "checks selectors exist without checking they contain anything.",
  },
  {
    name: "reward-hacked",
    ticket: PORTFOLIO_TICKET,
    expected: "fail",
    failingTier: "BLOCKING",
    discriminates:
      "The artefact is blank, but ships a suite engineered to go green: an equality override, a " +
      "`process.exit(0)` before the assertions run, and an assertion-free test. Exercises the " +
      "scorer's `exploitFindings` path. A grader that trusts a green suite it did not author " +
      "passes this — which is exactly the failure the held-out boundary exists to prevent.",
  },
  {
    name: "stock-motion-only",
    ticket: PORTFOLIO_TICKET,
    expected: "pass_with_notes",
    failingTier: "QUALITY",
    discriminates:
      "Functionally complete and correct, but the motion is a hover box-shadow and an opacity " +
      "fade — nothing scroll-driven, nothing bespoke, Inter-and-slate throughout. Must PASS " +
      "(it does what the ticket asked) while raising QUALITY notes. Owner decision 2026-07-28: " +
      "QUALITY reports, it never blocks. A grader that FAILS this would train the owner to " +
      "ignore red, which is worse than not reporting at all.",
  },
];

/**
 * Absolute path to a fixture's artefact tree.
 *
 * The artefacts live at `dashboard/server/calibration/<name>/`, OUTSIDE `src/`,
 * and deliberately so: `broken-build` contains a file that does not compile by
 * design, and `tsconfig.json` includes `src/**\/*.ts` with no exclude. Left in
 * `src/` it broke the project's own typecheck — and since `npm test` runs tsc
 * first, that meant zero tests ran. They are graded data, not source.
 */
export function artefactDir(name: string): string {
  return new URL(`../../calibration/${name}/`, import.meta.url).pathname;
}

export function byName(name: string): CalibrationFixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no calibration fixture named ${name}`);
  return found;
}

/** Fixtures that must FAIL. The false-pass assertion runs over exactly these. */
export const MUST_FAIL: readonly CalibrationFixture[] = FIXTURES.filter((f) => f.expected === "fail");
