"use client";

/**
 * agent-node.tsx — one agent, as a card. And a run of identical ones, as a deck.
 *
 * WHAT IT SHOWS IS EXACTLY WHAT THE SERVER SENDS. Skills come from
 * `graph_skill`, tool and MCP chips from `graph_tool` (an MCP call IS a tool
 * call whose name matches `mcp__<server>__<tool>`; the server splits the server
 * name out into `mcpServer`), hooks from `graph_hook`, the counters from
 * `graph_result`. Nothing on this card is computed from something adjacent to
 * the data, and nothing is shown that no event carries — which is why there is
 * no per-agent elapsed clock: the parsed event union drops the row's timestamp,
 * so a timer here would be a number this program invented.
 *
 * THE ONE THING ON THE CARD THAT IS DERIVED IS THE ROLE, AND IT SAYS SO. The
 * spine down the left edge and the chip under the title are `roleOf(agent,
 * lane)` — see `roles.ts`. An agent whose name and lane mean nothing to this
 * dashboard gets the flat `unmapped` grey and the chip reads `unmapped`, which is
 * a statement about this dashboard's knowledge rather than about the agent.
 *
 * THE PILLS STAY ON THE CARD, and that is a decision rather than an oversight.
 * The owner asked for detail on demand, and everything that used to live in the
 * page's rails has gone behind a click. Tool pills did not, because they are the
 * only place a reader can see the SHAPE of an agent's work at a glance — and
 * because `graph-replay.browser.spec.ts` reads a tool pill's `title` to prove the
 * SSE watermark did not double-count. Moving them behind a click would move that
 * proof behind a click too, and a check that has to open a panel first is a
 * weaker check.
 *
 * NO ICONS, DELIBERATELY. The reference image gives every node a coloured glyph
 * tile. This app ships no icon library, and the anti-slop rules ban hand-drawn
 * SVG glyphs outright — so the tile is replaced by the role spine, the node's
 * lane and its server-assigned id in mono. That is strictly more information
 * than a picture of a gear, and it costs no dependency.
 */

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useMemo, type KeyboardEvent, type ReactNode } from "react";

import type { GraphNode, GraphNodeState } from "@/lib/api-types";
import type { Tone } from "@/lib/presentation";
import { formatTokens } from "@/lib/format";
import { cx } from "@/components/ui";
import { GROUP_PREVIEW, NODE_WIDTH, PILL_CAP } from "./layout";
import { ROLE_LABEL, ROLE_MEANING, roleColorVar, type AgentRole } from "./roles";

/**
 * The dom id of a card's focusable shell.
 *
 * The canvas moves focus by id rather than by holding refs to every node: React
 * Flow owns the node elements and unmounts them freely as the graph folds and
 * unfolds, so a ref map would go stale exactly when a group was expanded.
 */
export function shellIdFor(key: string): string {
  return `agent-shell-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * A type alias, not an interface: React Flow's `Node<T>` constrains `T` to
 * `Record<string, unknown>`, and only type aliases get the implicit index
 * signature that satisfies it.
 */
export type AgentNodeData = {
  readonly graphNode: GraphNode;
  readonly role: AgentRole;
  /**
   * Selection is owned by the canvas, not by React Flow.
   *
   * `elementsSelectable` stays off — the spec's measured configuration — so
   * `NodeProps.selected` never becomes true. One value read by the card ring,
   * the sheet and the roster row beats three that can disagree.
   */
  readonly isSelected: boolean;
  /**
   * Roving tabindex: exactly ONE card on the canvas is in the tab order, and
   * arrow keys move which one. Thirty cards each holding a tab stop would mean
   * thirty presses to get past the graph, which is the failure mode that makes
   * people call a canvas inaccessible even when every element is reachable.
   */
  readonly tabbable: boolean;
  readonly onCardKeyDown: (event: KeyboardEvent<HTMLElement>, key: string) => void;
};

export type AgentFlowNode = Node<AgentNodeData, "agent">;

export interface StateLook {
  readonly label: string;
  readonly tone: Tone;
  /** What the state MEANS, in the tooltip. Never marketing, never a guess. */
  readonly meaning: string;
  readonly live: boolean;
  readonly card: string;
}

/**
 * State -> appearance, in ONE table.
 *
 * `unresolved` is the row worth reading. It means the run ended while this
 * agent still read `running` and the stream never said how it finished. It is
 * NOT failed — a cancelled run's in-flight agents did not fail — so it gets the
 * neutral palette and a dashed edge to the card, which reads as "we stopped
 * watching" rather than as an error.
 */
export function stateLook(state: GraphNodeState): StateLook {
  switch (state) {
    case "running":
      return {
        label: "running",
        tone: "accent",
        meaning: "This agent is working now.",
        live: true,
        card: "border-accent/55 shadow-[0_0_0_1px_rgba(110,168,254,0.10),0_14px_38px_-18px_rgba(110,168,254,0.75)]",
      };
    case "completed":
      return {
        label: "completed",
        tone: "pass",
        meaning: "The agent returned a result.",
        live: false,
        card: "border-pass/30",
      };
    case "failed":
      return {
        label: "failed",
        tone: "fail",
        meaning: "The agent reported a failure.",
        live: false,
        card: "border-fail/45 shadow-[0_12px_34px_-20px_rgba(248,113,113,0.6)]",
      };
    case "stopped":
      return {
        label: "stopped",
        tone: "warn",
        meaning: "The agent was stopped before it returned.",
        live: false,
        card: "border-warn/40",
      };
    case "unresolved":
      return {
        label: "unresolved",
        tone: "neutral",
        meaning:
          "The run ended while this agent still read running, and the stream never said how it finished. Not a failure — nobody was watching by then.",
        live: false,
        card: "border-dashed border-line-strong",
      };
    default:
      return {
        label: String(state),
        tone: "neutral",
        meaning: "A state this dashboard does not recognise, shown verbatim.",
        live: false,
        card: "border-line-strong",
      };
  }
}

const PILL_TONE: Readonly<Record<Tone, string>> = {
  pass: "border-pass/30 bg-pass-dim/70 text-pass",
  fail: "border-fail/40 bg-fail-dim/70 text-fail",
  warn: "border-warn/35 bg-warn-dim/60 text-warn",
  info: "border-info/30 bg-info-dim/60 text-info",
  accent: "border-accent/35 bg-accent-dim/45 text-accent",
  neutral: "border-line-strong bg-canvas/70 text-ink-dim",
};

export function Pill({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full border px-2 py-[2px] text-[10.5px] leading-[15px] whitespace-nowrap",
        PILL_TONE[tone],
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * The role spine and the role chip.
 *
 * `data-role` is for a test to FIND this element by. The assertion is on the
 * computed colour, never on the attribute or the class: an attribute says what
 * the code intended, and the thing that has to be true is that two roles resolve
 * to two different pixels.
 */
/**
 * THE BREATHING RIM — the only thing on a card that moves.
 *
 * The owner asked for it by name: "there will be some sort of border around the
 * orchestration to indicate that he is doing something, for example pulsating
 * bordering or something". The card already carried a 5px pulsing DOT inside a
 * status chip, which is a lot of signal to put in twenty-five square pixels; this
 * puts the same signal on the whole card edge, where it is legible at the zoom
 * levels this canvas is actually read at.
 *
 * WHAT IT DOES NOT CLAIM, AND THIS IS THE IMPORTANT PARAGRAPH. It does NOT mean
 * "work is happening now". It means "the last thing the stream said about this
 * agent was `running`", which is exactly what the status chip and the connector's
 * travelling comet already meant. That distinction is not pedantry: a real run in
 * this repo sat at `running` for 7h48m with an IDLE subprocess, and no timer,
 * watchdog or heartbeat exists anywhere in this app that could tell working from
 * hung. A breathing border on that run would have breathed all night. It is added
 * here because it is strictly no weaker a claim than the dot it joins — NOT
 * because anything now detects liveness. When a stall detector lands, THIS is the
 * element that should stop breathing and go still or amber; until then, do not
 * write a comment anywhere that says this rim means the agent is alive.
 *
 * WHY `motion-safe:` AND NOT A BARE `animate-*`. Under
 * `prefers-reduced-motion: reduce` the rim must hold still, and the two ways to
 * get there are not equivalent. `globals.css` has a blanket
 * `.animate-pulse { animation: none }` inside its reduced-motion block, so a bare
 * `animate-pulse` would be stilled by that rule — but only by coincidence of
 * sharing Tailwind's class name, and any future swap to a different keyframe
 * would silently escape it. `motion-safe:` compiles the animation INSIDE
 * `@media (prefers-reduced-motion: no-preference)`, so the rim is stilled by its
 * own definition rather than by a rule in another file. Same reasoning as
 * `orchestration-canvas.tsx:307`, which is the pattern this follows.
 *
 * WHY TAILWIND'S `pulse` AND NOT A PURPOSE-BUILT KEYFRAME. A named keyframe would
 * have to live in `globals.css`, which was outside this change's file scope. That
 * is a constraint, not a preference — if this rim is ever tuned, a dedicated
 * `@keyframes` with a slower, asymmetric ease (in slower than out) would read more
 * like breathing than `pulse`'s symmetric 2s cubic-bezier(.4,0,.6,1) does.
 *
 * WHY NOTHING HERE FORCES LAYOUT. `pulse` animates `opacity` only, and the rim's
 * own paint is a 1px border plus two inset shadows on an element that is already
 * `absolute inset-0`. No width, no size, no offset changes, so twenty of these on
 * one canvas cost compositing and never reflow.
 *
 * THE COLOURS ARE THE ACCENT TOKEN, WRITTEN TWO WAYS, AND THAT IS DELIBERATE.
 * `border-accent/55` is the theme utility. The two inset glows are
 * `rgba(110, 168, 254, ...)` — the literal value of `--color-accent` (#6ea8fe),
 * matching the two existing accent rgba call sites in this file (`stateLook`'s
 * running shadow and the card's radial highlight), because an arbitrary Tailwind
 * shadow cannot take a token-with-alpha. THE DEBT IS STATED RATHER THAN HIDDEN:
 * if `--color-accent` moves in `globals.css`, these three literals do not follow
 * it. Naming a colour that does not exist in `@theme` is the failure that has
 * already bitten this app once — `bg-run` was written in three places, no
 * `--color-run` existed, Tailwind emitted nothing, and the marker shipped
 * INVISIBLE. A literal rgba cannot fail that way; it can only go stale, which is
 * visible.
 *
 * GATED ON `look.live`, NOT ON A STATE STRING. `stateLook` sets `live` true for
 * `running` and for nothing else, and the same flag already drives the connector's
 * `is-live` handles. One flag means a card that breathes and an edge that flows
 * cannot disagree about which agents are working. `completed`, `failed`,
 * `stopped` and `unresolved` get no rim — a settled card that breathes is a lie
 * about its state, and on a canvas that holds twenty cards it is also noise that
 * would destroy the signal for the one card that is genuinely running.
 *
 * `aria-hidden`, because the state is already in `agentLabel` as the word
 * "running". A screen reader gains nothing from a second, wordless assertion of
 * the same fact.
 */
export function LiveRim(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid="live-rim"
      className={cx(
        // `inset-0` on a child of a 1px-bordered box lands on the parent's
        // padding box, so this border sits flush INSIDE the card's own border and
        // the two read as one thickening line rather than as two rules. 9px is
        // the concentric inner radius of the card's 10px outer one, not a new
        // radius: 10 minus the 1px border it nests inside.
        "pointer-events-none absolute inset-0 rounded-[9px] border border-accent/55",
        // Two inset stops, INTENDED as a tight edge-hug plus a wider, dimmer
        // bloom behind it — the reason being that a hard line switching
        // brightness reads as a rendering fault, while a rim with a bloom behind
        // it reads as something being on. STATED AS INTENT, NOT AS MEASUREMENT:
        // the blur/spread pair was reasoned about, not eyeballed, because this
        // change shipped without a browser (a real run was building on :4176 and
        // could not be disturbed). The blur radii and the two alphas are the
        // numbers most likely to need one tuning pass against real pixels; the
        // structure around them is not.
        "shadow-[inset_0_0_9px_-3px_rgba(110,168,254,0.45),inset_0_0_26px_-10px_rgba(110,168,254,0.5)]",
        // NO base `opacity` here on purpose: Tailwind's `pulse` keyframe declares
        // only its 50% stop (`opacity: .5`) and inherits 0%/100% from the
        // element. Setting `opacity-60` would make it breathe 0.6 -> 0.5 -> 0.6,
        // which is a change nobody can see. All the alpha lives in the colours.
        "motion-safe:animate-pulse",
      )}
    />
  );
}

export function RoleSpine({ role }: { role: AgentRole }): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-role={role}
      data-testid="role-spine"
      className="absolute inset-y-0 left-0 w-[3px]"
      style={{ backgroundColor: roleColorVar(role) }}
    />
  );
}

export function RoleChip({ role }: { role: AgentRole }): ReactNode {
  return (
    <span
      title={ROLE_MEANING[role]}
      data-role={role}
      className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.16em]"
      style={{ color: roleColorVar(role) }}
    >
      <span
        aria-hidden="true"
        className="inline-block size-[5px] rounded-[1px]"
        style={{ backgroundColor: roleColorVar(role) }}
      />
      {ROLE_LABEL[role]}
    </span>
  );
}

/** `mcp__github__create_issue` reads as `create_issue` once the server is a chip of its own. */
export function shortToolName(name: string, mcpServer: string | null): string {
  if (mcpServer === null) return name;
  const prefix = `mcp__${mcpServer}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function Count({ value }: { value: number }): ReactNode {
  if (value <= 1) return null;
  return <span className="text-ink-faint numeric">×{value}</span>;
}

/**
 * A group of pills with a `+N` chip once it passes the display cap.
 *
 * The overflow chip is not decoration: the reducer keeps up to 64 distinct
 * names per node and the card shows a handful, so without it a node that used
 * thirty tools would look like a node that used six.
 */
function PillGroup({
  label,
  hidden,
  children,
}: {
  label: string;
  hidden: number;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap gap-1" aria-label={label}>
      {children}
      {hidden > 0 && (
        <Pill title={`${String(hidden)} more not shown`}>+{hidden}</Pill>
      )}
    </div>
  );
}

export function AgentCard({
  node,
  role,
}: {
  node: GraphNode;
  role: AgentRole;
}): ReactNode {
  const look = stateLook(node.state);

  const skills = node.skills.slice(0, PILL_CAP.skills);
  const tools = node.tools.slice(0, PILL_CAP.tools);
  const hooks = node.hooks.slice(0, PILL_CAP.hooks);

  const denied = useMemo(
    () => node.hooks.some((hook) => hook.decision === "deny"),
    [node.hooks],
  );

  return (
    <article
      style={{ width: NODE_WIDTH }}
      className={cx(
        "relative overflow-hidden rounded-[10px] border bg-surface py-4 pl-[19px] pr-4 text-left transition-colors",
        // A single low radial highlight instead of a flat fill or a 45-degree
        // gradient — the card reads as lit from above without becoming glassy.
        "bg-[radial-gradient(120%_80%_at_18%_0%,rgba(110,168,254,0.05),transparent_60%)]",
        look.card,
      )}
    >
      {/* BEFORE the spine, and that ordering is load-bearing. Both are
          absolutely positioned with `z-index: auto`, so the later one paints on
          top; the rim's glow is strongest at the edges, including the 3px strip
          the spine occupies. Spine last keeps the role hue unmixed on a running
          card, which matters because role hue and state chroma are the canvas's
          two independent channels. */}
      {look.live && <LiveRim />}
      <RoleSpine role={role} />

      <header className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            {node.lane ?? "no lane"}
          </span>
          <span className="font-mono text-[9.5px] text-ink-faint/60">{node.id}</span>
        </span>
        <span
          title={look.meaning}
          className={cx(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[1px] text-[10px] font-medium",
            PILL_TONE[look.tone],
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "inline-block size-[5px] rounded-full",
              look.tone === "accent" && "bg-accent motion-safe:animate-pulse",
              look.tone === "pass" && "bg-pass",
              look.tone === "fail" && "bg-fail",
              look.tone === "warn" && "bg-warn",
              look.tone === "neutral" && "bg-ink-faint",
            )}
          />
          {look.label}
        </span>
      </header>

      <h3 className="mt-2 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink">
        {node.agent ?? "session"}
      </h3>

      <p className="mt-1">
        <RoleChip role={role} />
      </p>

      <p className="mt-1 line-clamp-2 h-[32px] text-[11.5px] leading-[16px] text-ink-dim">
        {node.description === "" ? "No task description was reported." : node.description}
      </p>

      {node.attribution === "inferred" && (
        <p className="mt-1.5">
          <Pill
            title="This agent was attributed by the server, not stated by the CLI. Hook messages carry no task identity."
          >
            <span className="underline decoration-dotted underline-offset-2">inferred</span>
          </Pill>
        </p>
      )}

      {(skills.length > 0 || tools.length > 0 || hooks.length > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3">
          {skills.length > 0 && (
            <PillGroup label="Skills" hidden={node.skills.length - skills.length}>
              {skills.map((skill) => (
                <Pill
                  key={`${skill.skill}:${skill.source}`}
                  tone="info"
                  title={`Skill ${skill.skill}, ${skill.source}`}
                >
                  {skill.skill}
                  <Count value={skill.count} />
                </Pill>
              ))}
            </PillGroup>
          )}

          {tools.length > 0 && (
            <PillGroup label="Tools" hidden={node.tools.length - tools.length}>
              {tools.map((tool) => (
                <Pill
                  key={tool.name}
                  tone={tool.mcpServer === null ? "neutral" : "accent"}
                  title={
                    tool.mcpServer === null
                      ? `${tool.name}, called ${String(tool.count)}×`
                      : `MCP server ${tool.mcpServer}: ${tool.name}, called ${String(tool.count)}×`
                  }
                >
                  {tool.mcpServer !== null && (
                    <span className="text-accent/70">{tool.mcpServer}/</span>
                  )}
                  {shortToolName(tool.name, tool.mcpServer)}
                  <Count value={tool.count} />
                </Pill>
              ))}
            </PillGroup>
          )}

          {hooks.length > 0 && (
            <PillGroup label="Hooks" hidden={node.hooks.length - hooks.length}>
              {hooks.map((hook) => (
                <Pill
                  key={`${hook.event}:${hook.tool}:${hook.decision}`}
                  tone={hook.decision === "deny" ? "fail" : "neutral"}
                  title={`${hook.event} on ${hook.tool === "" ? "any tool" : hook.tool} → ${hook.decision}`}
                >
                  {hook.event}
                  {hook.tool !== "" && (
                    <span className="text-ink-faint">·{hook.tool}</span>
                  )}
                  <Count value={hook.count} />
                </Pill>
              ))}
            </PillGroup>
          )}
        </div>
      )}

      {(node.toolCalls > 0 || node.result !== null) && (
        <footer className="mt-3 flex items-center gap-2 border-t border-line pt-2 text-[10.5px] text-ink-faint">
          <span className="numeric">
            {node.toolCalls} {node.toolCalls === 1 ? "call" : "calls"}
          </span>
          {node.result?.totalTokens != null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="numeric">{formatTokens(node.result.totalTokens)} tok</span>
            </>
          )}
          {denied && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-fail">hook denied a call</span>
            </>
          )}
        </footer>
      )}
    </article>
  );
}

/**
 * The shell every card sits in: the focus target, the click target, and the
 * anchor the connectors plug into.
 *
 * `role="button"` with `aria-pressed` rather than a real `<button>`: a button
 * cannot legally contain the card's `<article>`, `<h3>` and `<footer>`, and
 * flattening the card into spans to satisfy that would cost the heading a screen
 * reader can jump to. The keyboard contract a button would have given is
 * implemented explicitly — Enter and Space open, arrows move, Escape closes.
 */
function NodeShell({
  nodeKey,
  data,
  label,
  live,
  children,
}: {
  nodeKey: string;
  data: { isSelected: boolean; tabbable: boolean; onCardKeyDown: AgentNodeData["onCardKeyDown"] };
  label: string;
  live: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      id={shellIdFor(nodeKey)}
      role="button"
      tabIndex={data.tabbable ? 0 : -1}
      aria-pressed={data.isSelected}
      aria-label={label}
      onKeyDown={(event) => data.onCardKeyDown(event, nodeKey)}
      className={cx(
        "node-shell cursor-pointer rounded-[10px] transition-transform active:scale-[0.985]",
        data.isSelected && "ring-2 ring-accent/70 ring-offset-2 ring-offset-canvas",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={cx(live && "is-live")}
      />
      {children}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={cx(live && "is-live")}
      />
    </div>
  );
}

/** What a screen reader hears instead of the card. */
function agentLabel(node: GraphNode, role: AgentRole): string {
  const look = stateLook(node.state);
  const parts = [
    `${node.agent ?? "session"}, ${ROLE_LABEL[role]} role, ${look.label}`,
    node.lane === null ? "no lane" : `${node.lane} lane`,
    node.description === "" ? "no task description" : node.description,
  ];
  if (node.attribution === "inferred") parts.push("parent link inferred");
  return `${parts.join(". ")}. Press Enter for detail.`;
}

export function AgentNode({ id, data }: NodeProps<AgentFlowNode>): ReactNode {
  const node = data.graphNode;
  const look = stateLook(node.state);
  return (
    <NodeShell nodeKey={id} data={data} label={agentLabel(node, data.role)} live={look.live}>
      <AgentCard node={node} role={data.role} />
    </NodeShell>
  );
}

/* ------------------------------------------------------------------ */
/* The fold                                                            */
/* ------------------------------------------------------------------ */

export type GroupNodeData = {
  readonly members: readonly GraphNode[];
  readonly role: AgentRole;
  readonly expanded: boolean;
  readonly isSelected: boolean;
  readonly tabbable: boolean;
  readonly onCardKeyDown: AgentNodeData["onCardKeyDown"];
};

export type GroupFlowNode = Node<GroupNodeData, "group">;

/**
 * A run of identical siblings, as one card.
 *
 * WHY A DECK AND NOT A LIST WITH A COUNT. The thing being communicated is
 * "there are more of these behind this one", and two offset cards peeking out
 * behind the front one say that before any text is read — which is the whole
 * point, because the reader's complaint was about SHAPE, not about information.
 * The count and the captions are then there for the reader who has decided to
 * care.
 *
 * WHAT IT PROMISES. Every member shares a parent, a column, a role, a STATE and
 * an attribution — see `groupKeyOf` in layout.ts. So the deck's border tone is
 * honest for all of them, its single edge to the parent is honest for all of
 * them, and a failure among six successes cannot be inside it: it would have a
 * different state and would still be on the canvas as its own card.
 */
export function GroupNode({ id, data }: NodeProps<GroupFlowNode>): ReactNode {
  const members = data.members;
  const first = members[0];
  const look = stateLook(first?.state ?? "unresolved");
  const preview = members.slice(0, GROUP_PREVIEW);
  const hidden = members.length - preview.length;

  const label = `${String(members.length)} identical ${ROLE_LABEL[data.role]} tasks, all ${look.label}. ${
    data.expanded ? "Expanded. Press Enter to fold them back." : "Folded. Press Enter to expand."
  }`;

  if (data.expanded) {
    return (
      <NodeShell nodeKey={id} data={data} label={label} live={look.live}>
        <div
          style={{ width: NODE_WIDTH }}
          className="relative flex items-center gap-2 overflow-hidden rounded-[10px] border border-line-strong bg-surface/70 px-3 py-2.5"
        >
          <RoleSpine role={data.role} />
          <span className="numeric text-[12px] font-semibold text-ink">
            {members.length}
          </span>
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            identical tasks
          </span>
          <span className="ml-auto font-mono text-[9.5px] uppercase tracking-[0.14em] text-accent">
            fold
          </span>
        </div>
      </NodeShell>
    );
  }

  return (
    <NodeShell nodeKey={id} data={data} label={label} live={look.live}>
      <div style={{ width: NODE_WIDTH }} className="relative">
        {/* The deck. Two cards, offset down-right, behind the front one. They
            carry no content — they are the only thing on this canvas that is
            purely a shape, and they are the reason it reads as a stack. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-3 top-[14px] block h-full rounded-[10px] border border-line bg-surface/40"
        />
        <span
          aria-hidden="true"
          className="absolute inset-x-1.5 top-[7px] block h-full rounded-[10px] border border-line bg-surface/70"
        />

        <article
          className={cx(
            "relative overflow-hidden rounded-[10px] border bg-surface py-4 pl-[19px] pr-4",
            "bg-[radial-gradient(120%_80%_at_18%_0%,rgba(110,168,254,0.05),transparent_60%)]",
            look.card,
          )}
        >
          {/* The deck breathes too, and only the FRONT card of it does. Every
              member of a group shares a state by construction (`groupKeyOf` in
              layout.ts keys on it), so `look.live` here is honest for all of
              them — a folded group is running exactly when all six of its
              members are. Leaving it off would make six running agents look
              calmer than one, which inverts the signal the rim exists to carry.
              The two offset cards behind stay static: they are pure shape and
              carry no state of their own. */}
          {look.live && <LiveRim />}
          <RoleSpine role={data.role} />

          <header className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
              folded
            </span>
            <span
              title={look.meaning}
              className={cx(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[1px] text-[10px] font-medium",
                PILL_TONE[look.tone],
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "inline-block size-[5px] rounded-full",
                  look.tone === "accent" && "bg-accent motion-safe:animate-pulse",
                  look.tone === "pass" && "bg-pass",
                  look.tone === "fail" && "bg-fail",
                  look.tone === "warn" && "bg-warn",
                  look.tone === "neutral" && "bg-ink-faint",
                )}
              />
              all {look.label}
            </span>
          </header>

          <h3 className="mt-1.5 flex items-baseline gap-2">
            <span className="numeric text-[22px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {members.length}
            </span>
            <span className="text-[12.5px] text-ink-dim">identical tasks</span>
          </h3>

          <p className="mt-1.5">
            <RoleChip role={data.role} />
          </p>

          <ul className="mt-1.5 space-y-[2px]">
            {preview.map((member) => (
              <li
                key={member.id}
                title={member.description}
                className="truncate text-[11px] leading-[18px] text-ink-faint"
              >
                {member.description === "" ? member.id : member.description}
              </li>
            ))}
            {hidden > 0 && (
              <li className="text-[11px] leading-[18px] text-ink-faint/70 numeric">
                +{hidden} more
              </li>
            )}
          </ul>

          <p className="mt-2.5 border-t border-line pt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-accent">
            expand
          </p>
        </article>
      </div>
    </NodeShell>
  );
}

/* ------------------------------------------------------------------ */
/* The column header                                                   */
/* ------------------------------------------------------------------ */

/** A node so it pans and zooms with the column it labels. */
export type ColumnNodeData = {
  readonly label: string;
  readonly note: string;
  readonly count: number;
};

export type ColumnFlowNode = Node<ColumnNodeData, "column">;

export function ColumnNode({ data }: NodeProps<ColumnFlowNode>): ReactNode {
  return (
    <div style={{ width: NODE_WIDTH }} className="select-none" title={data.note}>
      <div className="flex items-baseline gap-2 border-b border-line pb-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-dim">
          {data.label}
        </span>
        <span className="numeric text-[10.5px] text-ink-faint">{data.count}</span>
      </div>
    </div>
  );
}
