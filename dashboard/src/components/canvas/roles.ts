/**
 * roles.ts — what KIND of work an agent did, and therefore what colour it is.
 *
 * WHY THIS IS DERIVED AND NOT A TABLE OF AGENTS. This machine offers 154 agents
 * and the roster grows every week; a switch over agent names would be wrong the
 * day after it was written and wrong SILENTLY — a new agent would land on
 * whatever the default branch happened to be. So the mapping is over a small set
 * of CRAFT TOKENS that appear in agent names, plus the lane the server already
 * derived, and nothing else.
 *
 * THE RULE, IN TWO CLAUSES:
 *
 *   1. Split the agent name on `-`, `_` and `.`. Score every role by the LONGEST
 *      of its tokens that appears anywhere in the name. A token that is exactly
 *      one of the name's segments beats every non-exact match, because the
 *      segments of an agent name are its subject and its craft in that order:
 *      `api-designer` designs APIs (backend), `ui-designer` is a designer whose
 *      subject happens to be spelled with two letters (design). Without the
 *      exact-segment clause `api` (3 chars) loses to `design` (6) and an API
 *      agent comes out orchid.
 *
 *   2. If no token matches at all, fall back to the LANE the server assigned.
 *      A lane is real information — it is authored by the CLI's own
 *      configuration, not inferred from graph shape — so an agent named
 *      something this table has never heard of still lands in the right family
 *      when it ran in a known lane.
 *
 * AND IF BOTH MISS, THE ANSWER IS `unmapped`, WHICH IS A COLOUR OF ITS OWN.
 * `unmapped` is a flat, low-lightness, near-zero-chroma grey. It is deliberately
 * NOT the nearest plausible role and deliberately not one of the seven hues: an
 * agent this dashboard cannot classify must look like an agent this dashboard
 * cannot classify. Guessing `build` for anything unrecognised would make the
 * canvas assert something no event said, which is the same defect as animating
 * an inferred edge like a fact.
 *
 * ROLE IS A HUE. STATE IS A CHROMA. Every role colour below sits between 0.07
 * and 0.11 chroma; every state colour in globals.css (`pass`, `fail`, `warn`)
 * sits between 0.16 and 0.19. That is what keeps a jade `backend` spine from
 * reading as a green `pass` badge even though their hues are 20 degrees apart —
 * the two channels are separated by saturation and by shape, not by hue
 * distance, because after removing the four state hues there is not enough wheel
 * left to give seven roles clean spacing. Colour means "what kind of work"; a
 * pill means "how it went". Nothing on the canvas uses colour for both.
 */

import type { RunLane } from "@/lib/api-types";

export type AgentRole =
  | "orchestration"
  | "spec"
  | "design"
  | "frontend"
  | "backend"
  | "build"
  | "review"
  | "unmapped";

/** Every role that carries a hue, in the order they appear in the legend. */
export const ROLE_ORDER: readonly AgentRole[] = [
  "orchestration",
  "spec",
  "design",
  "frontend",
  "backend",
  "build",
  "review",
  "unmapped",
];

export const ROLE_LABEL: Readonly<Record<AgentRole, string>> = {
  orchestration: "orchestration",
  spec: "spec",
  design: "design",
  frontend: "frontend",
  backend: "backend",
  build: "build",
  review: "review",
  unmapped: "unmapped",
};

/**
 * What each role means, shown in the legend and on a card's role chip. Written
 * to be read by someone who has never seen this dashboard.
 */
export const ROLE_MEANING: Readonly<Record<AgentRole, string>> = {
  orchestration: "Ran the run and delegated the rest.",
  spec: "Turned the ticket into requirements and context.",
  design: "Decided how it should look.",
  frontend: "Wrote the code a browser runs.",
  backend: "Wrote the code a server runs, or the infrastructure under it.",
  build: "General engineering: language work, refactors, tooling, dependencies.",
  review: "Checked the work — tests, audits, accessibility, the gate.",
  unmapped:
    "This dashboard could not tell what kind of work this was. Neither the agent's name nor its lane matched anything it knows, so it is deliberately drawn as none of the roles rather than guessed at.",
};

/**
 * Craft tokens per role.
 *
 * DELIBERATELY NOT AGENT NAMES. Every entry here is a word about a kind of work,
 * so an agent nobody has written yet is already covered if it is named after
 * what it does — which every agent on this machine is.
 *
 * WHAT IS ABSENT IS AS CONSIDERED AS WHAT IS PRESENT. `developer`, `engineer`,
 * `specialist`, `expert`, `pro`, `manager` and `architect` are NOT tokens. They
 * are craft-free suffixes: `frontend-developer` must resolve on `frontend`, and
 * if `developer` were a `build` token it would out-length `frontend` (9 > 8) and
 * every framework agent on the machine would come out the same colour as the
 * refactoring agent. `architect` is absent for the sharper version of the same
 * reason: it would beat `reviewer` in `architect-reviewer` and turn the
 * architecture REVIEWER into a spec agent.
 */
const ROLE_TOKENS: Readonly<Record<Exclude<AgentRole, "unmapped">, readonly string[]>> = {
  orchestration: [
    "orchestrator",
    "orchestration",
    "orchestrate",
    "conductor",
    "dispatcher",
    "supervisor",
    "coordinator",
    "workflow",
  ],
  spec: [
    "spec",
    "specification",
    "requirement",
    "requirements",
    "product",
    "context",
    "planner",
    "planning",
    "analyst",
    "research",
    "researcher",
    "discovery",
    "brief",
    "scope",
    "prd",
  ],
  design: [
    "design",
    "designer",
    "ux",
    "visual",
    "brand",
    "branding",
    "taste",
    "typography",
    "illustration",
    "illustrator",
    "aesthetic",
  ],
  frontend: [
    "frontend",
    "react",
    "reactjs",
    "nextjs",
    "next",
    "vue",
    "svelte",
    "angular",
    "css",
    "tailwind",
    "html",
    "dom",
    "browser",
    "client",
    "mobile",
    "expo",
    "ios",
    "android",
    "flutter",
    "swiftui",
    "animation",
  ],
  backend: [
    "backend",
    "api",
    "server",
    "database",
    "postgres",
    "postgresql",
    "supabase",
    "mysql",
    "mongo",
    "sqlite",
    "redis",
    "kafka",
    "graphql",
    "python",
    "django",
    "flask",
    "rails",
    "php",
    "laravel",
    "java",
    "rust",
    "golang",
    "elixir",
    "auth",
    "queue",
    "worker",
    "trigger",
    "docker",
    "kubernetes",
    "devops",
    "infra",
    "infrastructure",
    "terraform",
    "cloud",
    "deploy",
    "deployment",
    "network",
    "sre",
  ],
  build: [
    "fullstack",
    "typescript",
    "javascript",
    "refactor",
    "refactoring",
    "migration",
    "build",
    "compile",
    "bundler",
    "monorepo",
    "tooling",
    "dependency",
    "dependencies",
    "packaging",
    "scaffold",
  ],
  review: [
    "review",
    "reviewer",
    "audit",
    "auditor",
    "qa",
    "test",
    "tester",
    "testing",
    "automator",
    "critic",
    "adversary",
    "adversarial",
    "verifier",
    "validator",
    "lint",
    "linter",
    "debug",
    "debugger",
    "security",
    "accessibility",
    "compliance",
    "judge",
    "grader",
    "gate",
    "gatekeeper",
  ],
};

/**
 * The lane fallback, used only when no craft token matched.
 *
 * `gate` becomes `review` rather than a hue of its own: the gate IS the review
 * step, and an eighth colour bought nothing but a smaller gap between the other
 * seven.
 */
const LANE_ROLE: Readonly<Record<RunLane, AgentRole>> = {
  spec: "spec",
  design: "design",
  build: "build",
  review: "review",
  gate: "review",
};

/** Segments of an agent name, lowercased. `taste-frontend-expert` -> 3 of them. */
function segmentsOf(name: string): readonly string[] {
  return name
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter((part) => part !== "");
}

/**
 * The score a role earns against one agent name.
 *
 * `+100` for an exact segment is not a magic number so much as "longer than any
 * real token": the longest token in the table is 15 characters, so the bonus
 * makes any exact-segment match beat every substring match without needing a
 * second pass.
 */
const EXACT_SEGMENT_BONUS = 100;

/**
 * THE BONUS IS FOR THE FIRST SEGMENT ONLY, and the first version of this function
 * gave it to ANY exact segment — which is a different rule and a wrong one.
 *
 * Two of the roster's real names caught it, both written down in
 * `canvas-roles.unit.spec.ts` before this was fixed:
 *
 *   `api-designer`        — `designer` is an exact segment too, and it is 8
 *                           characters against `api`'s 3. Bonused equally, the
 *                           API designer came out orchid instead of jade.
 *   `taste-frontend-expert` — `frontend` is an exact segment in position 1 and
 *                           beat `taste` in position 0, so the design-quality
 *                           agent came out cyan.
 *
 * The rule that makes both right is the one the comment at the top of this file
 * claims: the FIRST segment is the agent's subject, later segments are its craft,
 * and the subject decides. Everything after position 0 competes on token length
 * alone.
 */
function scoreOf(name: string, tokens: readonly string[]): number {
  const lower = name.toLowerCase();
  const segments = segmentsOf(name);
  const subject = segments[0];
  let best = 0;
  for (const token of tokens) {
    if (subject !== undefined && subject === token) {
      best = Math.max(best, token.length + EXACT_SEGMENT_BONUS);
      continue;
    }
    if (lower.includes(token)) best = Math.max(best, token.length);
  }
  return best;
}

/**
 * The role of one node.
 *
 * TAKES THE NAME AND THE LANE, IN THAT PRECEDENCE, AND NOTHING ELSE. In
 * particular it does NOT read the task description: six nodes on the run this
 * was built against are described as "Generate hero section design reference
 * image", and picking `design` out of that sentence would be the canvas
 * inventing a classification from free text a human wrote for a different
 * purpose. A nameless sub-session is genuinely unclassified, and says so.
 */
export function roleOf(agent: string | null, lane: RunLane | null): AgentRole {
  if (agent !== null && agent !== "") {
    let winner: AgentRole | null = null;
    let winningScore = 0;
    for (const role of ROLE_ORDER) {
      if (role === "unmapped") continue;
      const tokens = ROLE_TOKENS[role as Exclude<AgentRole, "unmapped">];
      const score = scoreOf(agent, tokens);
      // Strictly greater, so a tie is broken by ROLE_ORDER — which is the
      // pipeline's own order, so the earlier stage wins a genuine draw.
      if (score > winningScore) {
        winningScore = score;
        winner = role;
      }
    }
    if (winner !== null) return winner;
  }

  if (lane !== null) return LANE_ROLE[lane] ?? "unmapped";

  return "unmapped";
}

/**
 * The CSS custom property carrying this role's hue.
 *
 * Returned as a `var()` reference rather than a literal so the seven colours
 * have exactly one definition, in globals.css, next to the state palette they
 * are tuned against.
 */
export function roleColorVar(role: AgentRole): string {
  return `var(--role-${role})`;
}

/** The same hue at spine/label strength, and at wire strength. */
export function roleTintVar(role: AgentRole): string {
  return `var(--role-${role}-dim)`;
}
