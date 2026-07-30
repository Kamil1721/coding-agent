"use client";

/**
 * inspector.tsx — one agent, in full.
 *
 * REBUILT 2026-07-30 AROUND WHAT THE READER ASKED FOR. The panel used to open on
 * `n10 · no lane`, a dashed note about hook attribution, `tokens / tool uses /
 * duration — not reported` three times, `0 tool calls`, and an SDK task id. The
 * owner's verdict:
 *
 *   "there is so much redundant information that is only important for you on the
 *   backend not to me. For me I just want to see the thinking and design process,
 *   for example what it was looking at in order, what he is looking at right now
 *   with time stamps… designing the hero image or text boxes"
 *
 * So THE TIMELINE IS NOW THE PANEL and everything above is behind one shut
 * disclosure. The ordering is `GraphNode.activity`'s, which is the order the events
 * were recorded in, and the times are `events.at` — the SERVER's clock, carried
 * through the wire rather than stamped on arrival, because a replayed run delivers
 * two hours of events in one burst and an arrival stamp would give them all the
 * same time. See `SseWireEvent`.
 *
 * DEMOTED, NOT DELETED — and the distinction is the point. The dashed
 * `attribution === "inferred"` note says a parent link is "a considered guess, not
 * a fact", and the SDK-reference note says those ids are redacted to one shared
 * literal and are never identity. Both are load-bearing honesty in a repository
 * whose recorded signature defect is a display claiming more than its data
 * supports. Off the first screen is right; gone is not. They live in
 * `<details>`, shut.
 *
 * WHAT IS STILL UNCONDITIONAL: the agent's name, its state, its task, and the
 * timeline. Four things, in that order.
 *
 * ONE CORRECTION TO THE PARAGRAPH ABOVE, MADE THE SAME DAY: that first rebuild
 * dropped the SDK ids and the hook note, but `n10 · no lane` itself survived it —
 * the panel still opened on the node id and on a placeholder for a lane the node
 * did not have. Both are gone now; see `MetaLine`, which also carries what was
 * kept and why.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  collapseAdjacent,
  describeActivity,
  readableSummary,
  type ActivityRun,
} from "@/lib/activity";
import type { GraphNode } from "@/lib/api-types";
import { formatDuration, formatTimeOnly, formatTokens } from "@/lib/format";
import { Button, EmptyState, cx } from "@/components/ui";
import { Pill, shortToolName, stateLook } from "./agent-node";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="border-t border-line px-3 py-2.5">
      <h4 className="flex items-baseline gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        {title}
        {count !== undefined && <span className="numeric text-ink-faint/70">{count}</span>}
      </h4>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/**
 * How each class of step is weighted.
 *
 * DESIGN WORK IS THE ONLY THING GIVEN FULL CONTRAST, and housekeeping is the only
 * thing muted. On the recorded run the interesting six lines — generate a
 * reference, look at it — sat among sixty `mkdir`/`ls` calls, and rendering all of
 * them at one weight is how a timeline becomes a log again.
 *
 * Muted is NOT hidden: the step is still there, still in order, still timed. This
 * only decides what the eye lands on first.
 */
const KIND_LOOK: Readonly<Record<ActivityRun["kind"], { dot: string; verb: string }>> = {
  design: { dot: "bg-role-design", verb: "text-ink" },
  delegate: { dot: "bg-role-spec", verb: "text-ink" },
  skill: { dot: "bg-accent", verb: "text-ink" },
  write: { dot: "bg-role-build", verb: "text-ink-dim" },
  read: { dot: "bg-line-strong", verb: "text-ink-dim" },
  search: { dot: "bg-line-strong", verb: "text-ink-dim" },
  housekeeping: { dot: "bg-line", verb: "text-ink-faint" },
};

/**
 * What housekeeping means, in the words the run sheet also uses.
 *
 * THE RAW TOKEN IS GONE — 2026-07-30. This tooltip used to read "The CLI marked
 * this skip_transcript.", which names the SDK field (`GraphNode.ambient` is folded
 * from it) and tells a reader who does not know that field nothing at all.
 *
 * A HAND-KEPT COPY, NOT A SHARED CONSTANT. The same sentence is meant to appear in
 * the run sheet (`sheet.tsx`), written there by a separate change in this pass;
 * this file exports nothing for it and NO TEST COMPARES THE TWO, so they can drift
 * silently. Treat them as two copies of one sentence and change both together.
 */
const HOUSEKEEPING_MEANING = "housekeeping — not an agent step";

/**
 * The line under the agent's name: its lane, and whether it is housekeeping.
 *
 * TWO THINGS WERE REMOVED HERE ON 2026-07-30, AND THEY ARE NOT THE SAME REMOVAL.
 *
 *   - `node.id` — the panel opened on `n10 · no lane`. `n10` is the reducer's own
 *     arrival counter for this run's fold; it addresses nothing the reader can
 *     act on, appears in no URL, and is not the SDK's task id (those were already
 *     dropped from the technical-details section for the same reason). Gone.
 *   - `"no lane"` — gone as a PLACEHOLDER only. A lane the server derived is a
 *     real fact about where the agent sits in the pipeline and still prints; what
 *     is dropped is the row that announced the absence of one, which was the
 *     larger half of what the reader saw first.
 *
 * RETURNS NULL RATHER THAN AN EMPTY ROW. A node with no lane and no housekeeping
 * mark now has nothing to say on this line, and rendering the `<p>` anyway would
 * leave its padding — a visible gap under the name that no browser check here
 * would have caught.
 *
 * The separator is between the two, so it only exists when both do.
 */
function MetaLine({
  node,
  className,
}: {
  node: GraphNode;
  className: string;
}): ReactNode {
  if (node.lane === null && !node.ambient) return null;
  return (
    <p className={className}>
      {node.lane !== null && <span>{node.lane}</span>}
      {node.lane !== null && node.ambient && <span aria-hidden="true">·</span>}
      {node.ambient && <span title={HOUSEKEEPING_MEANING}>housekeeping</span>}
    </p>
  );
}

function TimelineRow({ run }: { run: ActivityRun }): ReactNode {
  const look = KIND_LOOK[run.kind];
  return (
    <li className="flex items-baseline gap-2 py-[3px]">
      {/*
        * The time column is fixed-width and monospace so the times form a readable
        * ruler down the left rather than a ragged edge. A step with no recorded time
        * prints an em dash — never a guess, and never the reader's own clock.
        */}
      <span
        className="numeric w-[52px] shrink-0 text-[10.5px] tabular-nums text-ink-faint"
        title={run.at ?? "no time was recorded for this step"}
      >
        {run.at === null ? "—" : formatTimeOnly(run.at)}
      </span>
      <span
        className={cx("mt-[6px] h-1 w-1 shrink-0 rounded-full", look.dot)}
        aria-hidden="true"
      />
      <span className="min-w-0 text-[12px] leading-relaxed">
        <span className={look.verb}>{run.verb}</span>{" "}
        <span
          className="break-words text-ink-dim"
          // The untouched recorded detail, always one hover away.
          title={run.raw}
        >
          {run.object}
          {run.truncated && <span className="text-ink-faint">…</span>}
        </span>
        {run.repeats > 1 && (
          <span className="numeric text-ink-faint"> ×{run.repeats}</span>
        )}
      </span>
    </li>
  );
}

/**
 * The timeline, and the empty states that are NOT the same as each other.
 *
 * A running agent with nothing recorded yet, a finished agent that never used a
 * tool, and a node the server could only infer are three different facts. Printing
 * one "no activity" for all three is the conflation this codebase refuses
 * elsewhere (`heldOutPass: null` is not `false`), so each gets its own sentence.
 */
/**
 * How many steps show before the timeline folds.
 *
 * The orchestrator of the recorded run has **111** steps, which collapsed to 97 rows
 * and made the panel a wall to scroll past — the owner's words: "the history should
 * be collapsble". Twelve is enough to carry the shape of what the agent is doing
 * (on that run it reaches the end of the design set) without burying everything
 * below it.
 *
 * NOT A TRUNCATION. The fold says how many more there are and opens to all of them;
 * `activityDropped` is the separate, real truncation and is still reported.
 */
/**
 * The agent's closing message: readable, and two lines until asked.
 *
 * `readableSummary` collapses the absolute paths and strips the markdown nothing
 * renders; the clamp is here because even cleaned, a per-ref verdict list is longer
 * than a panel wants by default. Nothing is dropped — the unfold shows all of it.
 */
function ReportedSummary({ summary }: { summary: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const clean = readableSummary(summary);
  const long = clean.length > 180;

  return (
    <>
      <p
        className={cx(
          "text-[12px] leading-relaxed text-ink-dim",
          long && !open && "line-clamp-2",
        )}
      >
        {clean}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          className="mt-1 text-[11px] text-accent underline-offset-2 hover:underline"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </>
  );
}

const TIMELINE_FOLD_AT = 12;

function Timeline({ node }: { node: GraphNode }): ReactNode {
  const runs = useMemo(
    () => collapseAdjacent(node.activity.map(describeActivity)),
    [node.activity],
  );
  const [open, setOpen] = useState(false);

  /*
   * NEWEST STEPS WIN WHEN FOLDED, and that is the whole reason the fold shows the
   * TAIL rather than the head.
   *
   * The owner asked to see "what he is looking at right now". On a running agent the
   * current step is the LAST one, so a fold that kept the first twelve would hide the
   * only row that answers the question it was asked for. Opening restores full
   * chronological order from the beginning.
   */
  const folded = runs.length > TIMELINE_FOLD_AT && !open;
  const shown = folded ? runs.slice(runs.length - TIMELINE_FOLD_AT) : runs;
  const hidden = runs.length - shown.length;

  if (runs.length === 0) {
    return (
      <p className="text-[11.5px] leading-relaxed text-ink-faint">
        {node.state === "running"
          ? "Nothing recorded yet — this agent has not reported a tool call."
          : node.toolCalls > 0
            ? // Can only happen on a run recorded before `activity` existed: the
              // count survived in the old field, the steps were never stored.
              `${String(node.toolCalls)} tool ${node.toolCalls === 1 ? "call" : "calls"} were counted, but this run predates the step-by-step record.`
            : "This agent reported no tool calls at all."}
      </p>
    );
  }

  return (
    <>
      {folded && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mb-1 w-full rounded-sm border border-dashed border-line-strong py-1 text-[11px] text-ink-faint transition-colors hover:border-line-strong hover:text-ink-dim"
        >
          show {hidden} earlier {hidden === 1 ? "step" : "steps"}
        </button>
      )}
      <ol className="-mt-0.5">
        {shown.map((run, index) => (
          <TimelineRow key={`${String(index)}:${run.verb}:${run.object}`} run={run} />
        ))}
      </ol>
      {open && runs.length > TIMELINE_FOLD_AT && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-1 w-full rounded-sm border border-dashed border-line-strong py-1 text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
        >
          fold back to the last {TIMELINE_FOLD_AT}
        </button>
      )}
      {node.activityDropped > 0 && (
        /*
         * The cap bit. Saying so is the difference between a truncated list and a
         * list that lies about being complete — the same rule as `toolCalls` vs
         * `tools`.
         */
        <p className="mt-1.5 border-t border-line pt-1.5 text-[11px] text-ink-faint">
          {node.activityDropped} further {node.activityDropped === 1 ? "step" : "steps"}{" "}
          happened and were not recorded — this agent passed the per-node limit.
        </p>
      )}
    </>
  );
}

export function AgentInspector({
  node,
  onClose,
  /**
   * `false` when the caller has already drawn a header for this agent.
   *
   * `DetailSheet` puts the agent's name, its role chip and a close button in the
   * sheet's own chrome, so leaving this on printed "context-manager" and "close"
   * twice, twelve pixels apart. Default `true` so this stays the component's own
   * complete rendering for any caller that is not wrapping it.
   */
  header = true,
}: {
  node: GraphNode | null;
  onClose: () => void;
  header?: boolean;
}): ReactNode {
  if (node === null) {
    return (
      <EmptyState>
        Select an agent on the canvas, or in the list beside it, to see its skills,
        tools, hooks and result.
      </EmptyState>
    );
  }

  const look = stateLook(node.state);

  return (
    <div className="-mx-3 -my-2.5">
      {header ? (
        <header className="flex items-start justify-between gap-2 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold text-ink">
              {node.agent ?? "session"}
            </p>
            <MetaLine
              node={node}
              className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint"
            />
          </div>
          <Button variant="ghost" onClick={onClose} title="Clear the selection">
            close
          </Button>
        </header>
      ) : (
        /* The sheet draws its own name and close button, so this caller gets the
         * meta line alone — and nothing at all when there is no lane and no
         * housekeeping mark, which is why `MetaLine` owns the `<p>` and its
         * padding rather than the branch here. */
        <MetaLine
          node={node}
          className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint"
        />
      )}

      <div className="px-3 pb-2.5">
        <p
          title={look.meaning}
          className={cx(
            "text-[12px]",
            look.tone === "accent" && "text-accent",
            look.tone === "pass" && "text-pass",
            look.tone === "fail" && "text-fail",
            look.tone === "warn" && "text-warn",
            look.tone === "neutral" && "text-ink-dim",
          )}
        >
          {look.label} — {look.meaning}
        </p>
      </div>

      <Section title="Task">
        <p className="text-[12px] leading-relaxed text-ink-dim">
          {node.description === "" ? "No task description was reported." : node.description}
        </p>
      </Section>

      {/*
        * THE PANEL'S SUBJECT. Everything below it is reference material; this is what
        * the reader opened the node to see. `node.activity` is already in recorded
        * order, so there is no sort here — sorting would invite a comparator that
        * silently reorders steps whose timestamps tie.
        */}
      {node.activity.length === 0 ? (
        <Section title="Timeline">
          <Timeline node={node} />
        </Section>
      ) : (
        <Section title="Timeline" count={node.activity.length}>
          <Timeline node={node} />
        </Section>
      )}

      {/* The agent's own closing message, when it left one. Prose, so it stays up
        * here with the timeline rather than under the plumbing. */}
      {node.result !== null && node.result.summary !== "" && (
        <Section title="What it reported">
          <ReportedSummary summary={node.result.summary} />
        </Section>
      )}

      {/*
        * ────────── EVERYTHING BELOW IS DEMOTED, AND SHUT BY DEFAULT ──────────
        *
        * `<details>` rather than React state on purpose: the browser remembers
        * nothing, so every node opens closed, and the disclosure keeps working with
        * JavaScript mid-hydration. It is also focusable and toggles on Enter without
        * any handler of ours, which is the accessible behaviour we would otherwise
        * have to rebuild.
        *
        * WHAT IS IN HERE AND WHY IT IS STILL IN HERE AT ALL: counted tool/skill/hook
        * pills (the aggregate view the timeline replaces but does not contain — a
        * capped node's totals live here), the numbers the CLI reported, the inferred
        * attribution caveat, and the SDK ids. The last two are truthfulness
        * statements, not trivia. This repository's recorded signature defect is a
        * display that claims more than its data supports; deleting the sentence that
        * says "the link to its parent is a considered guess, not a fact" would make
        * every inferred edge read as measured.
        */}
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint hover:text-ink-dim">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">
            ▸
          </span>
          technical details
        </summary>

        <div className="pb-1">
          {node.attribution === "inferred" && (
            <div className="px-3 pb-2">
              <p className="rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-dim">
                This agent was attributed by the server rather than stated by the CLI.
                Hook messages carry no task identity, so the link to its parent is a
                considered guess, not a fact.
              </p>
            </div>
          )}

          {node.skills.length > 0 && (
            <Section title="Skills" count={node.skills.length}>
              <div className="flex flex-wrap gap-1">
                {node.skills.map((skill) => (
                  <Pill
                    key={`${skill.skill}:${skill.source}`}
                    tone="info"
                    title={`${skill.source} · used ${String(skill.count)}×`}
                  >
                    {skill.skill}
                    {skill.count > 1 && (
                      <span className="text-ink-faint numeric">×{skill.count}</span>
                    )}
                  </Pill>
                ))}
              </div>
            </Section>
          )}

          {node.tools.length > 0 && (
            <Section title="Tools, by name" count={node.tools.length}>
              <ul className="space-y-1">
                {node.tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="flex items-baseline justify-between gap-2 text-[11.5px]"
                  >
                    <span className="min-w-0 truncate">
                      {tool.mcpServer !== null && (
                        <span className="text-accent">{tool.mcpServer}/</span>
                      )}
                      <span className="text-ink-dim">
                        {shortToolName(tool.name, tool.mcpServer)}
                      </span>
                    </span>
                    <span className="shrink-0 text-ink-faint numeric">{tool.count}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {node.hooks.length > 0 && (
            <Section title="Hooks" count={node.hooks.length}>
              <ul className="space-y-1">
                {node.hooks.map((hook) => (
                  <li
                    key={`${hook.event}:${hook.tool}:${hook.decision}`}
                    className="flex items-baseline justify-between gap-2 text-[11.5px]"
                  >
                    <span className="min-w-0 truncate text-ink-dim">
                      {hook.event}
                      {hook.tool !== "" && (
                        <span className="text-ink-faint"> · {hook.tool}</span>
                      )}
                    </span>
                    <span
                      className={cx(
                        "shrink-0",
                        hook.decision === "deny" ? "text-fail" : "text-ink-faint",
                      )}
                    >
                      {hook.decision}
                      {hook.count > 1 && <span className="numeric"> ×{hook.count}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="What the CLI reported">
            {node.result === null ? (
              <p className="text-[11.5px] text-ink-faint">
                {node.state === "running"
                  ? "Still working."
                  : "No result message was recorded for this agent."}
              </p>
            ) : (
              <dl className="grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <dt className="text-ink-faint">tokens</dt>
                  <dd className="numeric text-ink">
                    {node.result.totalTokens === null
                      ? "not reported"
                      : formatTokens(node.result.totalTokens)}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">tool uses</dt>
                  <dd className="numeric text-ink">
                    {node.result.toolUses === null ? "not reported" : node.result.toolUses}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">duration</dt>
                  <dd className="numeric text-ink">
                    {node.result.durationMs === null
                      ? "not reported"
                      : formatDuration(node.result.durationMs)}
                  </dd>
                </div>
              </dl>
            )}
            <p className="mt-1.5 text-[11px] text-ink-dim numeric">
              {node.toolCalls} tool {node.toolCalls === 1 ? "call" : "calls"}
              {node.tools.length > 0 && (
                <span className="text-ink-faint">
                  {" "}
                  across {node.tools.length} distinct{" "}
                  {node.tools.length === 1 ? "name" : "names"}
                </span>
              )}
            </p>
          </Section>

          {/*
            * THE SDK REFERENCE SECTION IS GONE — 2026-07-30.
            *
            * It printed `task a775113161fe8998e` / `tool use toolu_01Br5g…` with a note
            * that both are redacted to one shared literal and are never identity. All
            * true, and all for cross-referencing a raw transcript by eye — a thing the
            * owner will never do: "so is sdk info. I am not interested in the specifics."
            *
            * DISTINGUISHED FROM THE `inferred` NOTE ABOVE, WHICH STAYS. That one is a
            * claim about how much the graph KNOWS ("the link to its parent is a
            * considered guess, not a fact") and removing it would let an inferred edge
            * read as measured. These ids assert nothing about correctness; they were a
            * debugging affordance. `GraphNode.sdk` is still on the wire for anyone who
            * needs it.
            */}
        </div>
      </details>
    </div>
  );
}
