/**
 * fix-triage.ts — which specialist gets which failure, in which order.
 *
 * ROUTING TARGET IS THE GATE LANE, ALMOST ENTIRELY, and that is a decision
 * rather than an oversight. `DELIVERY_LANES.gate` — `debugger`,
 * `test-automator`, `refactoring-specialist`, `dependency-manager` — is the set
 * `agent-shortlist.ts` charters to CHANGE THE TREE in response to a gate
 * finding, and it is unconditional: those four are shortlisted for every
 * surface. A route to a build-lane specialist would read as more precise and
 * would be denied by the delegation hook on the surfaces where that specialist
 * is filtered out, which looks exactly like a lane that had nothing to do.
 *
 * THE ONE EXCEPTION IS `visual`. It routes to `taste-frontend-expert`, which is
 * a DESIGN-lane agent, and the DESIGN lane is conditional on the surface
 * (web-ui / fullstack). On an `api` or `cli` ticket that route is denied. It is
 * kept — a visual failure on a surface with no design lane is a contradiction
 * worth surfacing — and {@link partitionByPermission} is what stops the denial
 * from being silent.
 */

import { ALL_FAILURE_CLASSES } from "./gate-report.js";
import type { AgentVisibleReport, FailureClass, FixableFailure } from "./gate-report.js";

export interface FixTask {
  readonly agent: string;
  readonly failures: readonly FixableFailure[];
}

/**
 * Class -> agent. Total, and typed as a full Record so a new `FailureClass`
 * does not compile until it has somewhere to go.
 */
const ROUTES: Readonly<Record<FailureClass, string>> = Object.freeze({
  install: "dependency-manager",
  build: "debugger",
  boot: "debugger",
  route: "debugger",
  "test-infra": "test-automator",
  logic: "debugger",
  structure: "refactoring-specialist",
  visual: "taste-frontend-expert",
});

export function agentFor(klass: FailureClass): string {
  return ROUTES[klass];
}

/** The id of the synthesised "the held-out half is not satisfied" failure. */
export const HELD_OUT_FAILURE_ID = "held-out-suite";

/**
 * The one failure that is not derived from an observable gate.
 *
 * WHY IT HAS TO EXIST. A build can pass every tier-0 gate and still leave
 * criteria unmet — the visible half green, the held-out half not. There is no
 * `FixableFailure` for that, because the only thing known about it is a count.
 * Without this the loop would find zero failures, plan zero fix tasks, and stop;
 * `isGreen` would still be false, so it would burn the whole retry budget doing
 * nothing, or (worse, on an earlier draft) read the empty task list as success.
 *
 * COUNTS ONLY. This string reaches an agent prompt. It must never grow a
 * criterion id, a statement or a test title.
 */
function heldOutFailure(report: AgentVisibleReport): FixableFailure {
  const parts = ALL_TIERS.filter((tier) => report.heldOutUnmet[tier] > 0).map(
    (tier) => `${String(report.heldOutUnmet[tier])} ${tier}`,
  );
  return {
    id: HELD_OUT_FAILURE_ID,
    klass: "logic",
    summary: "the held-out acceptance suite is not satisfied",
    detail:
      `${parts.join(", ")} criteria are unmet in the held-out half of the acceptance suite. ` +
      "Which criteria, and what they assert, is deliberately not available to you — it is the " +
      "measurement. Work from the ticket text and from visible-acceptance/, which is a real subset " +
      "of the same suite.",
    command: null,
    exitCode: null,
  };
}

const ALL_TIERS = ["BLOCKING", "FUNCTIONAL", "QUALITY"] as const;

/**
 * The fix work for one gate report, batched by agent and ordered by urgency.
 *
 * ORDER IS `ALL_FAILURE_CLASSES` — install, build, boot, route, test-infra,
 * logic, structure, visual. Fixing a visual nit while the dependency tree does
 * not resolve wastes a whole round of the loop's small budget.
 *
 * AN INFRA FAILURE PRODUCES NOTHING. `infrastructureErrors` means the scorer
 * failed, not the artefact; there is nothing here to fix.
 */
export function planFixes(report: AgentVisibleReport): readonly FixTask[] {
  if (report.infraFailure !== null) return [];

  const all: FixableFailure[] = [...report.failures];
  const unmet = report.heldOutUnmet.BLOCKING + report.heldOutUnmet.FUNCTIONAL + report.heldOutUnmet.QUALITY;
  if (unmet > 0) all.push(heldOutFailure(report));

  const byAgent = new Map<string, FixableFailure[]>();
  for (const klass of ALL_FAILURE_CLASSES) {
    for (const failure of all) {
      if (failure.klass !== klass) continue;
      const agent = agentFor(klass);
      const bucket = byAgent.get(agent);
      if (bucket === undefined) byAgent.set(agent, [failure]);
      else bucket.push(failure);
    }
  }

  return [...byAgent].map(([agent, failures]) => ({ agent, failures }));
}

/**
 * Split planned work by what this run's delegation shortlist actually permits.
 *
 * The denied half is RETURNED, not dropped. An agent the hook refuses produces
 * no output, and no output is indistinguishable from an agent that had nothing
 * to do — so the work goes to the backlog with a reason instead of evaporating.
 */
export function partitionByPermission(
  tasks: readonly FixTask[],
  allowedAgents: readonly string[],
): { readonly runnable: readonly FixTask[]; readonly denied: readonly FixTask[] } {
  const allowed = new Set(allowedAgents);
  const runnable: FixTask[] = [];
  const denied: FixTask[] = [];
  for (const task of tasks) (allowed.has(task.agent) ? runnable : denied).push(task);
  return { runnable, denied };
}
