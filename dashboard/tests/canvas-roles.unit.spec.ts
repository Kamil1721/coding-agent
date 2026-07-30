/**
 * The two derivations the owner asked for by name, as pure functions.
 *
 * WHY THESE ARE UNIT-TESTED AND THE COLOURS ARE NOT. `roleOf` answers "what kind
 * of work was this" from an agent name and a lane; `groupSiblings` answers "which
 * of these cards are the same card repeated". Both are total functions over data
 * the server sends, both have right answers, and neither needs a browser. What
 * DOES need a browser is that two roles resolve to two different pixels — a
 * `var(--role-*)` only becomes a colour once a real stylesheet is loaded — and
 * that lives in `run-canvas.browser.spec.ts`.
 *
 * THE CASES BELOW ARE THE REAL AGENT ROSTER. Every name in the first block is an
 * agent this machine actually offers, taken off the run this redesign was built
 * against (`inventory.allowedAgents`, 154 of them). They are here because the
 * whole claim of `roles.ts` is that a table of ~120 CRAFT TOKENS classifies a
 * roster that grows every week without being edited — and the way that claim fails
 * is not "no match", it is a match by the WRONG role, quietly, because one token
 * happened to be longer than another. Four of the cases below are exactly that
 * collision and each one is annotated with what it would have resolved to under a
 * naive rule.
 */

import { expect, test } from "@playwright/test";

import type { GraphNode, GraphNodeState, RunLane } from "../src/lib/api-types";
import { MIN_GROUP, columnOf, groupSiblings, placeGraph } from "../src/components/canvas/layout";
import { ROLE_ORDER, roleOf } from "../src/components/canvas/roles";

/* ------------------------------------------------------------------ */
/* roleOf                                                             */
/* ------------------------------------------------------------------ */

test.describe("roleOf: the craft token wins, and the first segment wins harder", () => {
  test("the pipeline agents this dashboard is built around", () => {
    expect(roleOf("orchestrator", null)).toBe("orchestration");
    expect(roleOf("context-manager", "spec")).toBe("spec");
    expect(roleOf("product-manager", "spec")).toBe("spec");
    expect(roleOf("ui-designer", "design")).toBe("design");
    expect(roleOf("taste-frontend-expert", "design")).toBe("design");
    expect(roleOf("code-reviewer", "review")).toBe("review");
    expect(roleOf("qa-expert", "review")).toBe("review");
  });

  test("front end and back end — the two the owner named", () => {
    expect(roleOf("frontend-developer", "build")).toBe("frontend");
    expect(roleOf("nextjs-developer", "build")).toBe("frontend");
    expect(roleOf("react-specialist", "build")).toBe("frontend");
    expect(roleOf("backend-developer", "build")).toBe("backend");
    expect(roleOf("postgres-pro", "build")).toBe("backend");
    expect(roleOf("python-pro", "build")).toBe("backend");
    expect(roleOf("docker-expert", "build")).toBe("backend");
    expect(roleOf("trigger-dev-expert", "build")).toBe("backend");
  });

  test("THE FOUR COLLISIONS, each with what a naive rule gives instead", () => {
    // `developer` is 9 characters and `frontend` is 8. If `developer` were a
    // `build` token, every framework agent on the machine would come out the same
    // colour as the refactoring agent. It is deliberately absent from the table.
    expect(roleOf("frontend-developer", null)).toBe("frontend");

    // `architect` is 9 and `reviewer` is 8. With `architect` in the table the
    // architecture REVIEWER becomes a spec agent. Also deliberately absent.
    expect(roleOf("architect-reviewer", "review")).toBe("review");

    // `design` is 6 and `api` is 3, so longest-token alone makes the API designer
    // a DESIGN agent. The exact-first-segment bonus is what stops it: `api` is
    // this name's subject, `designer` is only its craft.
    expect(roleOf("api-designer", null)).toBe("backend");

    // And the same rule must not swing the other way: `ui` is not a token at all
    // (two characters is too ambiguous to match on), so this resolves on
    // `designer` and stays design.
    expect(roleOf("ui-designer", null)).toBe("design");
  });

  test("the lane is the fallback, and it is a real one", () => {
    // No token in either name. Neither is a mistake — a roster of 154 will always
    // contain names this table has not heard of, and the lane the CLI assigned is
    // authored information rather than a guess.
    expect(roleOf("antislop-hook", "gate")).toBe("review");
    expect(roleOf("some-agent-nobody-wrote-yet", "build")).toBe("build");
    expect(roleOf("some-agent-nobody-wrote-yet", "design")).toBe("design");
  });

  test("UNMAPPED IS A REAL ANSWER, NOT A DEFAULT ROLE", () => {
    // THE CASE THE OWNER'S BRIEF SINGLED OUT: an agent this dashboard cannot
    // classify must look like one, never like a role it is not. `tail-marker`
    // contains no craft token and ran in no lane.
    expect(roleOf("tail-marker", null)).toBe("unmapped");
    // A nameless sub-session — six of these on the run this was built against,
    // every one of them described as generating a design reference image. The
    // description is NOT read: picking `design` out of a sentence a human wrote
    // for another purpose would be the canvas inventing a classification.
    expect(roleOf(null, null)).toBe("unmapped");
    expect(roleOf("", null)).toBe("unmapped");
  });

  test("every answer is a member of the declared set", () => {
    // Guards against a token table entry whose key is not a role — which would
    // reach the renderer as `var(--role-typo)` and resolve to nothing at all.
    const names = [
      "orchestrator",
      "context-manager",
      "ui-designer",
      "frontend-developer",
      "backend-developer",
      "typescript-pro",
      "security-auditor",
      "tail-marker",
    ];
    for (const name of names) {
      expect(ROLE_ORDER).toContain(roleOf(name, null));
    }
  });
});

/* ------------------------------------------------------------------ */
/* groupSiblings                                                       */
/* ------------------------------------------------------------------ */

let counter = 0;

function node(overrides: Partial<GraphNode> & { id?: string } = {}): GraphNode {
  counter += 1;
  return {
    id: overrides.id ?? `n${String(counter)}`,
    parent: "root",
    agent: null,
    lane: null,
    description: "",
    ambient: false,
    state: "completed",
    attribution: "inferred",
    sdk: null,
    tools: [],
    skills: [],
    hooks: [],
    toolCalls: 0,
    result: null,
    activity: [],
    activityDropped: 0,
    ...overrides,
  };
}

function siblings(count: number, overrides: Partial<GraphNode> = {}): GraphNode[] {
  return Array.from({ length: count }, () => node(overrides));
}

test.describe("groupSiblings: what folds, and the four things it can never hide", () => {
  test("the shape the owner complained about: six identical siblings become one group", () => {
    // THE RUN THIS EXISTS FOR. Ten cards under the orchestrator, six of them
    // captioned "Generate <section> design reference image", every one a nameless
    // completed leaf inferred from the same parent.
    const root = node({ id: "root", parent: null });
    const six = siblings(6);
    const assigned = groupSiblings([root, ...six], new Set());

    const keys = new Set(six.map((entry) => assigned.get(entry.id)));
    expect(keys.size, "all six landed in ONE group").toBe(1);
    expect([...keys][0]).toBe("group:1");
    expect(assigned.has("root"), "the root is never folded — it has no parent").toBe(
      false,
    );
  });

  test("A GROUP CAN NEVER HIDE A FAILURE", () => {
    // The clause that makes folding safe rather than convenient. Five completed
    // siblings fold; the sixth FAILED and stays on the canvas as its own card,
    // with its own red border, in its own row.
    const root = node({ id: "root", parent: null });
    const ok = siblings(5, { state: "completed" });
    const bad = node({ id: "boom", state: "failed" });
    const assigned = groupSiblings([root, ...ok, bad], new Set());

    expect(new Set(ok.map((entry) => assigned.get(entry.id))).size).toBe(1);
    expect(assigned.get("boom"), "a failure was folded in with five successes").toBe(
      undefined,
    );
  });

  test("and it can never hide a GUESS", () => {
    // A folded group has ONE edge to its parent, and that edge is drawn either as
    // a fact or as an inference. A mixed group would force it to lie one way.
    const root = node({ id: "root", parent: null });
    const guessed = siblings(4, { attribution: "inferred" });
    const stated = siblings(4, { attribution: "exact" });
    const assigned = groupSiblings([root, ...guessed, ...stated], new Set());

    const guessedKeys = new Set(guessed.map((entry) => assigned.get(entry.id)));
    const statedKeys = new Set(stated.map((entry) => assigned.get(entry.id)));
    expect(guessedKeys.size).toBe(1);
    expect(statedKeys.size).toBe(1);
    expect([...guessedKeys][0]).not.toBe([...statedKeys][0]);
  });

  test("and it can never hide a SUBTREE", () => {
    // Folding a node that delegated would hide everything under it behind a
    // count, and the edge out of it would have to start at a card that is not
    // drawn. `hasChildren` is the disqualification.
    const root = node({ id: "root", parent: null });
    const leaves = siblings(3);
    const parentish = node({ id: "delegator" });
    const assigned = groupSiblings(
      [root, ...leaves, parentish],
      new Set(["delegator"]),
    );

    expect(new Set(leaves.map((entry) => assigned.get(entry.id))).size).toBe(1);
    expect(assigned.get("delegator")).toBe(undefined);
  });

  test("and it can never fold across two columns", () => {
    // One card is drawn in one column. A fold spanning `design` and `build` would
    // have to pick one and put the other agent in the wrong lane.
    const root = node({ id: "root", parent: null });
    const design = siblings(3, { lane: "design" as RunLane, agent: "ui-designer" });
    const build = siblings(3, { lane: "build" as RunLane, agent: "ui-designer" });
    const assigned = groupSiblings([root, ...design, ...build], new Set());

    const designKey = [...new Set(design.map((e) => assigned.get(e.id)))][0];
    const buildKey = [...new Set(build.map((e) => assigned.get(e.id)))][0];
    expect(designKey).not.toBe(buildKey);
    expect(columnOf(design[0] as GraphNode)).toBe("design");
    expect(columnOf(build[0] as GraphNode)).toBe("build");
  });

  test(`fewer than ${String(MIN_GROUP)} is not a stack, and stays unfolded`, () => {
    const root = node({ id: "root", parent: null });
    const pair = siblings(MIN_GROUP - 1);
    const assigned = groupSiblings([root, ...pair], new Set());
    for (const entry of pair) expect(assigned.get(entry.id)).toBe(undefined);
  });
});

/* ------------------------------------------------------------------ */
/* placeGraph, which is where folding becomes a layout                 */
/* ------------------------------------------------------------------ */

test.describe("placeGraph: the fold is a layout change, not a display trick", () => {
  const root = node({ id: "root", parent: null, description: "the run's own session" });
  const six = siblings(6);
  const spec = node({
    id: "spec1",
    agent: "context-manager",
    lane: "spec",
    attribution: "exact",
  });

  const graph = {
    nodes: [root, ...six, spec],
    edges: [
      ...six.map((entry) => ({
        from: "root",
        to: entry.id,
        attribution: "inferred" as const,
      })),
      { from: "root", to: "spec1", attribution: "exact" as const },
    ],
    inventory: null,
  };

  test("SEVEN edges become TWO, and the graph reads as a flow", () => {
    const placed = placeGraph(graph, { showAmbient: false });
    // One card for the fold, one for the root, one for spec.
    expect(placed.nodes.map((entry) => entry.kind)).toEqual([
      "agent",
      "group",
      "agent",
    ]);
    expect(placed.edges).toHaveLength(2);
    expect(placed.foldedCount, "five cards are hidden behind the deck").toBe(5);
  });

  test("the root gets a column to ITSELF — the fix for ten siblings under it", () => {
    const placed = placeGraph(graph, { showAmbient: false });
    const columns = placed.columns.map((column) => column.column);
    expect(columns).toEqual(["root", "tasks", "spec"]);

    // And nothing shares the root's column, which is the entire defect: every
    // lane-less node used to land in column 0 alongside the orchestrator.
    const rootColumn = placed.nodes.filter((entry) => entry.column === "root");
    expect(rootColumn).toHaveLength(1);
    expect(rootColumn[0]?.node.id).toBe("root");
  });

  test("a column's count is its AGENTS, not its cards", () => {
    // A fold must not make the run look smaller than it was.
    const placed = placeGraph(graph, { showAmbient: false });
    const tasks = placed.columns.find((column) => column.column === "tasks");
    expect(tasks?.count).toBe(6);
  });

  test("expanding puts the members back, in arrival order, under a header", () => {
    const placed = placeGraph(graph, {
      showAmbient: false,
      expandedGroups: new Set(["group:1"]),
    });
    const tasks = placed.nodes.filter((entry) => entry.column === "tasks");
    expect(tasks[0]?.kind).toBe("group");
    expect(tasks[0]?.expanded).toBe(true);
    expect(tasks.slice(1).map((entry) => entry.node.id)).toEqual(
      six.map((entry) => entry.id),
    );
    expect(placed.foldedCount).toBe(0);
    // Seven edges again: the members are on the canvas in their own right.
    expect(placed.edges).toHaveLength(7);
  });

  test("no two cards overlap in a column, folded or expanded", () => {
    for (const expandedGroups of [new Set<string>(), new Set(["group:1"])]) {
      const placed = placeGraph(graph, { showAmbient: false, expandedGroups });
      const byColumn = new Map<string, { y: number; height: number }[]>();
      for (const entry of placed.nodes) {
        const list = byColumn.get(entry.column) ?? [];
        list.push({ y: entry.y, height: entry.height });
        byColumn.set(entry.column, list);
      }
      for (const [column, boxes] of byColumn) {
        boxes.sort((a, b) => a.y - b.y);
        for (let index = 1; index < boxes.length; index += 1) {
          const above = boxes[index - 1];
          const below = boxes[index];
          if (above === undefined || below === undefined) continue;
          expect(
            below.y,
            `two cards overlap in the ${column} column`,
          ).toBeGreaterThanOrEqual(above.y + above.height);
        }
      }
    }
  });

  test("every forward edge into one column from one source shares a bend", () => {
    // THE CABLE BUS. `getSmoothStepPath` routes each edge independently, so
    // without a shared `centerX` a fan-out is a spray of near-identical curves
    // that cross each other. This is the property that makes them merge into one
    // vertical trunk instead.
    /*
     * FOUR DISTINCT STATES, so nothing folds.
     *
     * The first version of this case used four IDENTICAL siblings and asserted
     * "every edge shares a bend" — which passed for the wrong reason: four
     * identical leaves are exactly what `groupSiblings` folds, so there was one
     * edge and one bend, trivially. A bus of one wire proves nothing about a bus.
     */
    const states: readonly GraphNodeState[] = [
      "completed",
      "failed",
      "stopped",
      "running",
    ];
    const many = states.map((state) => node({ state }));
    const wide = {
      nodes: [root, ...many],
      edges: many.map((entry) => ({
        from: "root",
        to: entry.id,
        attribution: "exact" as const,
      })),
      inventory: null,
    };
    const placed = placeGraph(wide, { showAmbient: false });
    const bends = new Set(placed.edges.map((edge) => edge.centerX));
    expect(placed.edges.length).toBeGreaterThan(1);
    expect(bends.size, "each edge bent at its own x — that is the spray").toBe(1);
    expect([...bends][0]).not.toBeNull();
  });
});
