"use client";

/**
 * sheet.tsx — detail on demand, which is the whole shape of this screen now.
 *
 * WHAT THIS REPLACED. The run view used to put a TICKET card and an AGENTS list
 * down the left, the canvas in a squeezed middle track, and an INSPECTOR,
 * ENVIRONMENT and USAGE stack down the right. Five panels of run-level facts were
 * on screen at all times whether or not anyone was reading them, and the graph —
 * the thing the screen is for — got about a third of the width. The owner's
 * instruction was exact: "there is too much info that i dont need around the
 * sides… the info i require only comes up when i press on the node."
 *
 * `RunSheet` IS GONE — 2026-08-04 — AND ITS SEVEN TAB BODIES ARE STILL HERE.
 *
 * It was a 560px right-hand sheet with a tab strip reading Ticket / Chat / Verdict
 * / Code / Agents / Run / Trace, opened by a button labelled "run detail". The
 * owner's next instruction was about the OTHER side of the screen — "icons … on
 * the left side of the canva and when I click them they expand into different
 * things" — and a rail on the left plus a tab strip on the right is two navigations
 * for one set of facts. So `TABS`, `RunSheetTab` and the sheet itself retired
 * together; `canvas/rail.tsx` owns panel identity now, and the bodies below are
 * exported for it. They are RE-PARENTED, not rewritten: every component they mount
 * (`TicketAttachmentsPanel`, `MotionReadoutPanel`, `CriteriaPanel`,
 * `PublishedProjectPanel`, `ScreenshotsPanel`, `CodeBrowser`, `AgentRoster`,
 * `EnvironmentPanel`, `UsagePanel`, `TracePane`, `OutcomeNotice`) is untouched, and
 * so is the reasoning written above each of them.
 *
 * WHAT THE SHEET SHELL IS STILL FOR.
 *
 *   `DetailSheet` — one agent, opened by clicking or Entering its card. Right
 *     docked, 420px, and it deliberately does NOT cover the graph: the card it
 *     describes stays visible with its ring on and its connectors energised, so
 *     the sheet reads as an annotation of the canvas rather than as a page you
 *     navigated to. Left rail = run-level surfaces; right sheet = the thing you
 *     clicked. That split is the whole of the new shape.
 *
 * THE CHAT IS NOT ON A NODE — 2026-07-30, and this is a MOVE, not an addition. It
 * used to mount inside `DetailSheet`, gated on `node.parent === null`, which meant
 * there was no way to type anything at a run until the build segment emitted its
 * first `graph_agent` — 79.5 minutes into the owner's recorded run, and long past
 * the moment a message is most useful (the server queues one from the instant the
 * run is accepted, and the FIRST build prompt is where a queued one is folded in).
 * Messages are addressed to the run (`GET/POST /api/runs/:id/messages`), never to a
 * node. It was a tab here; it is a rail entry now, which is one permanent icon
 * rather than a button inside a scrolling dock.
 *
 * NEITHER SURFACE IS A MODAL AND NEITHER TRAPS FOCUS. There is no scrim, no
 * `aria-modal`, and nothing that swallows Tab: the canvas behind stays live and
 * keyboard-reachable, which matters because the agent index selects cards on it.
 * Escape closes, from anywhere inside.
 *
 * WHY THE AGENT INDEX SURVIVED. Spec §9.3 requires an accessible equivalent of
 * the canvas and the old left rail was it — its caption said the graph "offers
 * partial affordances only". The canvas is now properly navigable itself (roving
 * tabindex, arrow keys, Enter, Escape — see `orchestration-canvas.tsx`), so the
 * list is no longer the ONLY way in. It is still here — inside Overview now rather
 * than behind a tab of its own — for two reasons that are not accessibility
 * theatre: it is the faster read when you already know which agent you want, and
 * it is the ungrouped truth, so no agent can be reachable only by expanding
 * something.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";

import type {
  AdversaryFinding,
  AdversaryPass,
  GraphNode,
  GraphState,
  ModelOption,
  RunDetail,
} from "@/lib/api-types";
import type { StreamState, TraceEntry } from "@/lib/use-run-stream";
import { isTerminalStatus } from "@/lib/api-types";
import { elapsedBetween, formatDuration } from "@/lib/format";
import { designLockPhase } from "@/lib/mockups";
import { TONE_TEXT, phaseMeta, statusMeta, type Tone } from "@/lib/presentation";
import { ticketLabel, ticketTooltip } from "@/lib/ticket-title";
import { Explain } from "@/components/explain";
import { FalseFinishBadge, HeldOutBadge } from "@/components/outcome";
import { Badge, Button, Dot, MonoPath, Panel, cx } from "@/components/ui";
import { TicketAttachmentsPanel } from "@/components/run/attachments";
import { CodeBrowser } from "@/components/run/code-browser";
import { CriteriaPanel } from "@/components/run/criteria";
import { MotionReadoutPanel } from "@/components/run/motion";
import { OutcomeNotice } from "@/components/run/notices";
import { PublishedProjectPanel } from "@/components/run/published-project";
import { ProjectControls, useProjectControl } from "@/components/project/controls";
import { useProjects } from "@/lib/hooks";
import { ScreenshotsPanel } from "@/components/run/screenshots";
import { TracePane } from "@/components/run/trace";
import { UsagePanel } from "@/components/run/usage";
import { EnvironmentPanel } from "./environment";
import { AgentInspector } from "./inspector";
import { AgentRoster } from "./roster";
import { RoleChip } from "./agent-node";
import { roleOf } from "./roles";

/* ------------------------------------------------------------------ */
/* The shell                                                           */
/* ------------------------------------------------------------------ */

function Sheet({
  title,
  eyebrow,
  width,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  width: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const shell = useRef<HTMLDivElement | null>(null);

  /*
   * Escape closes, and the listener is on the sheet rather than on the window.
   *
   * A window listener would also close the sheet when the reader pressed Escape
   * with focus on a canvas card — which already means something else there
   * (clear the selection) and would fire both.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    },
    [onClose],
  );

  /*
   * Focus moves into the sheet on open, so Escape works without a click first
   * and a screen reader is told something appeared. `preventScroll` because the
   * sheet is inside a fixed-height canvas and scrolling it into view would move
   * the whole page by a pixel.
   */
  useEffect(() => {
    shell.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={shell}
      tabIndex={-1}
      role="region"
      aria-label={title}
      onKeyDown={onKeyDown}
      className={cx(
        "sheet-in absolute inset-y-0 right-0 z-20 flex flex-col border-l border-line bg-surface/97 backdrop-blur",
        "shadow-[-24px_0_48px_-32px_rgba(0,0,0,0.9)]",
        width,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
            {eyebrow}
          </p>
          <h2 className="truncate text-[13.5px] font-semibold text-ink">{title}</h2>
        </div>
        <Button variant="ghost" onClick={onClose} title="Close (Escape)">
          close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One agent                                                           */
/* ------------------------------------------------------------------ */

/**
 * WHERE THE CHAT WENT, because it was mounted here until 2026-07-30 and its call
 * site has moved rather than vanished: it is now the RAIL's "Chat" entry —
 * `canvas/rail.tsx`, mounted by `runs/[runId]/page.tsx` — one click from a
 * permanent icon on the left edge, on every run view.
 *
 * THAT SENTENCE NAMED TWO DELETED THINGS UNTIL 2026-08-05. It said "`RunSheet`'s
 * 'Chat' tab, reached in one click from the control under the run chip", and by
 * then the seven-tab sheet and the run chip had both gone (see this file's own
 * header). The destination is corrected; the reasoning below is not touched,
 * because every word of it is still true of the rail — including the cost in the
 * last paragraph, which the rail pays in exactly the same coin.
 *
 * WHY IT LEFT A NODE. The `chat?: ReactNode` prop this component used to take was
 * passed by `runs/[runId]/page.tsx` only for a node with `parent === null`, which
 * bought two things and cost one:
 *
 *   + it never appeared on a sub-agent, which is correct — a sub-agent is spawned
 *     with a prompt and ends, so a chat box on one is a control that cannot act;
 *   + it sat beside the session it addressed.
 *   − it did not exist until a node did, and no node exists until the build
 *     segment emits its first `graph_agent`. On the owner's recorded run that was
 *     79.5 minutes of a run with no way to say anything to it, while the server
 *     accepted messages the whole time.
 *
 * The "never on a sub-agent" property is now STRUCTURAL rather than conditional:
 * there is no chat slot on this sheet to gate, so no node of any shape can grow
 * one. (That also settles the open question about the human-factors pass, which
 * emits `parent: null` and would otherwise have inherited a composer.)
 *
 * WHAT THIS COSTS, said plainly: the chat is one click further away when you are
 * already reading the orchestrator node, and the two entry points that used to
 * exist are now one. That is the trade — a control that is always reachable beats
 * one that is closer to hand for the last fifth of a run and absent for the rest.
 */
export function DetailSheet({
  node,
  onClose,
}: {
  node: GraphNode;
  onClose: () => void;
}): ReactNode {
  const role = roleOf(node.agent, node.lane);
  return (
    <Sheet
      eyebrow="agent"
      title={node.agent ?? "session"}
      width="w-[min(420px,100%)]"
      onClose={onClose}
    >
      <div className="border-b border-line px-3 py-2">
        <RoleChip role={role} />
      </div>
      <div className="px-3 py-2.5">
        {/* `header={false}`: the sheet's own chrome already carries this agent's
            name and its close button. */}
        <AgentInspector node={node} onClose={onClose} header={false} />
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

/*
 * `TABS` AND `RunSheetTab` ARE DELETED — 2026-08-04, with the sheet that carried
 * them. The list was `ticket · chat · verdict · code · agents · env(label "Run") ·
 * trace`, and the note that sat here argued for the ORDER: "the ticket is what you
 * asked for and the chat is how you amend it; they are the same question a day
 * apart, and the amendment is the only tab here that is an ACTION rather than a
 * record."
 *
 * THE ARGUMENT SURVIVES THE DELETION AND IS HONOURED BY THE RAIL'S OWN ORDER —
 * Overview, then Chat, then the records (Files, Result) with Activity pinned to the
 * bottom. What changed is that four of the seven were never peers of the other
 * three: `env` and `agents` are facts ABOUT the run and are now sections of
 * Overview, and `ticket` is the first section of it. See `canvas/rail.tsx` for the
 * whole mapping and for which word replaced which.
 */

function TabBody({ children }: { children: ReactNode }): ReactNode {
  return <div className="space-y-3 p-3">{children}</div>;
}

/**
 * One card inside a rail panel.
 *
 * A HEADING STRIP AND A BORDER, reusing the eyebrow treatment the sheet header
 * already uses (`font-mono 9.5px uppercase tracking-[0.18em] text-ink-faint`) and
 * the app's existing `rounded` — no third radius, no new type size. Overview is
 * five of these stacked; every other panel is one body with no card at all,
 * because a single card wrapping a whole panel is a border for its own sake.
 *
 * `explain` IS A SLOT IN THE HEADING STRIP — 2026-08-05, and it is where two of
 * this panel's paragraphs went. It takes an `<Explain>` and nothing else. In the
 * heading rather than in the body because the fact is ABOUT the section, and a
 * glyph at the end of a body is a glyph nobody scanning headings will find. The
 * uppercase/tracking on this `h3` is safe for it: `explain.tsx` draws a vector
 * circle-i rather than a letterform precisely so a call site's casing cannot
 * reach it, and the bubble resets `normal-case tracking-normal` itself.
 */
function PanelSection({
  title,
  explain,
  children,
  testId,
  bodyClassName = "p-[10px]",
}: {
  title: string;
  /** An `<Explain>` for a fact about this section. Not for a second heading. */
  explain?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** `p-0` for a body that needs edge-to-edge rows — the agent roster does. */
  bodyClassName?: string;
}): ReactNode {
  return (
    <section
      data-testid={testId}
      className="overflow-hidden rounded border border-line bg-canvas/40"
    >
      <h3 className="border-b border-line px-[10px] py-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
        {title}
        {explain}
      </h3>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The human-factors pass                                              */
/* ------------------------------------------------------------------ */

/**
 * THIS RENDERING HAS NEVER BEEN SEEN WITH REAL DATA. First sentence, because it
 * is the first thing anyone reading or changing this block needs: the lane that
 * produces `RunDetail.adversary` (`server/src/adversary.ts#adversaryLane`,
 * reached from `orchestrator.ts#adversaryPhase`) HAS NEVER EXECUTED on this
 * machine — it needs a running loopback preview, which needs a scored run with
 * `deploy` set, and no run has got there. The wire contract, the server's mapper
 * (`adversaryPassFromRecord`) and its tests are real; the WRITER is not. Every
 * state below was derived from that contract by reading it, not by watching a
 * run produce one, and NO SPEC IN THIS REPO RENDERS THIS PANEL. So: unverified
 * against real findings, and nothing here may be described as proven.
 *
 * WHAT THE PANEL IS FOR. `#adversaryPhase` points a separate reader at the
 * finished site and asks what got in the way of using it. Until now the answer
 * reached the UI as a count in the log wall (`3 finding(s) — 1 HIGH, 2 MEDIUM`)
 * and the sentences lived in two files no route serves. `results/` is NOT
 * browsable and MUST NOT BECOME browsable — it holds held-out test titles, and
 * the workspace-only fence in `code-files.ts` is a security control — so the four
 * values the server puts on the wire are the whole of what can be shown.
 *
 * THE DISTINCTION THIS WHOLE BLOCK EXISTS TO KEEP, from `AdversaryPass`:
 *
 *   `ran: false`, `findings: null`   considered and DECLINED; `stop` says why.
 *   `ran: true`,  `findings: null`   it ran and LEFT NO REPORT — the report is a
 *                                    file the session writes, and a missing file
 *                                    means this program cannot see what it found.
 *   `ran: true`,  `findings: []`     it ran, reported, and FOUND NOTHING.
 *
 * The last two get different sentences and neither is an empty panel. The count
 * in the header is rendered ONLY for a non-empty list, which is the other half of
 * the same rule: `0 filed` above "left no report" would say "found nothing" in
 * the one place a reader actually looks.
 *
 * NON-GATING, AND THEREFORE NOT RED. `withAdversaryFindings` copies `heldOutUnmet`
 * unchanged and the pass runs after scoring, so nothing here can move
 * `heldOutPass`, `status` or `failureReason`. On this tab red means the run
 * failed (`OutcomeNotice`, `CriteriaPanel`'s gating rows), so severity tops out
 * at warn. THE COST, NAMED: CRITICAL and HIGH share a colour. The severity word
 * is printed in full on every row and the list is sorted by rank, which is what
 * carries the distinction instead.
 *
 * PLACED LAST ON THE TAB, under the captures of the site it is judging, and
 * deliberately not next to `CriteriaPanel` — "never beside a criterion result"
 * is the wire contract's own instruction, and a graded criterion and a
 * non-gating opinion sitting in one column is how the opinion becomes a verdict.
 *
 * READ DEFENSIVELY, AND HERE IS WHY IT IS NOT PARANOIA. `lib/api.ts` does
 * `parsed as T` with NO runtime validation, and `tests/fixtures/run-fixture.ts`
 * still serves a `RunDetail` with no `adversary` key at all — the same trap the
 * `GateHealth` docblock names for `health.gate`. So the field is read through
 * `?? null` at the one call site and `findings` through `?? null` again: an
 * absent key becomes "no record" and renders nothing, rather than a TypeError on
 * the Result panel (which is where this renders now; it was the Verdict tab when
 * this was written). `stop`/`stopDetail` are NOT re-guarded, because
 * `adversaryPassFromRecord` refuses a record missing either one and always writes
 * a string for the detail — a record that arrives at all carries both.
 *
 * WHAT THIS DOES NOT COVER, so nothing implies otherwise:
 *   · `adversary: null` renders NOTHING. That is the state of every run today,
 *     and a panel on every run announcing a lane that has never run is noise on
 *     100% of them. The cost is real: "the pass left no record" and "this build
 *     does not show it" look identical from the outside.
 *   · A record with `ran: false` and a non-empty list would render rows under a
 *     "did not run" stop line. The server has no path that produces it (every
 *     refusal sets `findings: []` and `reportWritten: false`, which the mapper
 *     turns into `null`), so it is left contradictory rather than papered over.
 *   · Nothing here re-checks the server's claim that these are non-gating; it
 *     repeats it. The mechanism is on the server and is tested there.
 */

/** Sort rank. Anything this build does not recognise sorts LAST, not first. */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/**
 * Severity -> tone, and the ceiling is `warn` on purpose. See the block docblock:
 * red on this tab is reserved for a run that failed, and these findings cannot
 * fail a run. An unrecognised severity gets `neutral` and its own raw text.
 */
const SEVERITY_TONE: Readonly<Record<string, Tone>> = {
  CRITICAL: "warn",
  HIGH: "warn",
  MEDIUM: "info",
  LOW: "neutral",
};

/**
 * The lane's `stop` vocabulary in plain language, WITH A REACHABLE DEFAULT.
 *
 * `stop` is typed `string` on both sides deliberately (`AdversaryStop` in
 * adversary.ts lists nine values and neither api-types file imports the other),
 * so a value this build has never heard of is a newer server rather than a bug
 * and is shown as the server sent it.
 *
 * `ran` HAS NO ENTRY: it is the clean completion, and the caller renders no stop
 * line at all for it. The three sentences that are not refusals — timeout, failed,
 * cancelled — are written to be true whether or not a partial report survived,
 * because `adversaryLane` returns `ran: true` with findings on the timeout path.
 *
 * REWORDED 2026-08-05 AND NOT SHORTENED MUCH, because the length was never the
 * problem here: exactly one of these renders at a time and it is the whole answer
 * to "why is this panel empty". What went was the vocabulary — "denylist",
 * "unbound", "wall-clock", "scratch directory", "artefact" — none of which the
 * owner has any way to read. Every refusal still says WHAT was wrong and that the
 * pass was refused RATHER THAN run anyway, which is the distinction that stops a
 * refusal reading as a crash.
 */
const STOP_SENTENCE: Readonly<Record<string, string>> = {
  "not-applicable": "There was no running preview of the site to review.",
  "agent-missing":
    "The reviewer agent could not be read on the machine that ran it, so the pass was refused rather than run with a different one.",
  "agent-denylist-drift":
    "The reviewer agent's permissions no longer block what this pass needs blocked, so it was refused rather than run unrestricted.",
  "denylist-incomplete":
    "This build no longer blocks every tool that can write, so the pass was refused rather than let near the work it judges.",
  "workspace-not-isolated":
    "The pass's own folder overlapped the work it was meant to judge, so it was refused before anything started.",
  timeout: "The pass ran out of time and was stopped before it finished.",
  failed: "The pass errored out.",
  cancelled: "The run was cancelled, so the pass did not finish.",
};

/**
 * Why the pass stopped — the mapped sentence, then the lane's own words.
 *
 * BOTH, AND LABELLED, which is `OutcomeNotice`'s precedent for `failureReason`
 * rather than a third pattern. On `not-applicable` the server's detail is already
 * a full sentence and this reads as a near-duplicate; suppressing it by comparing
 * the two strings would break silently the first time either is reworded, and the
 * label is what turns a restatement into provenance.
 *
 * TRUNCATION IS NAMED. `adversaryPassFromRecord` cuts `stopDetail` at 2000
 * characters and a `failed` stop carries an unbounded error message, so this can
 * arrive cut off mid-sentence; the caption says so rather than presenting it as
 * the complete cause. Scrolled and wrapped for the same reason `OutcomeNotice`
 * scrolls its cause: the string is machine text of unknown shape.
 */
function StopBlock({ stop, stopDetail }: { stop: string; stopDetail: string }): ReactNode {
  const sentence = STOP_SENTENCE[stop];
  return (
    <div className="mt-2 rounded border border-line bg-canvas/40 px-3 py-2">
      {/* The unrecognised-stop fallback lost its second sentence on 2026-08-05:
          "It is shown as the server sent it" was a claim about the token already
          printed two words earlier, which is the definition of restating a
          label. The token itself is what a reader would quote in a bug report,
          and it is still here. */}
      <p className="text-[12px] leading-snug text-ink-dim">
        {sentence ??
          `The pass stopped for a reason this build does not recognise: ${stop}`}
      </p>
      {stopDetail !== "" && (
        <>
          {/*
           * "CAPPED AT", NOT "TRUNCATED TO": the server slices at 2000
           * characters and nothing on the wire says whether the cut fired, so a
           * caption claiming this text WAS cut would be a claim about data this
           * component cannot see.
           *
           * "The lane's own words" became "In its own words" on 2026-08-05 — a
           * "lane" is a thing in this program's source, not on this screen, and
           * the only antecedent a reader has here is the pass. The cap stays: it
           * is a fact about the text directly below it, while they are reading
           * it, so it is not a candidate for an `<Explain>`.
           */}
          <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            In its own words, capped at 2000 characters
          </div>
          <pre className="mt-1 max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-dim">
            {stopDetail}
          </pre>
        </>
      )}
    </div>
  );
}

/**
 * One finding: severity, one sentence, and the evidence behind a disclosure.
 *
 * `klass` IS ON THE ROW, NOT IN IT — the same demotion `CriterionRow` gives the
 * grader's `REQ-013`, and with a second reason on top of that one. The server's
 * parser writes `logic` for any class it does not recognise AND for a finding
 * that named none (`findingsFrom`, adversary.ts), so a `logic` token is not
 * evidence that the finding is about logic. As a visible column it would be a
 * label that is wrong some unknown fraction of the time; in the row's `title` it
 * is still there for whoever is matching this against `adversary.json`.
 *
 * `detail === ""` IS A STATEMENT, NOT A BLANK. The wire's own docblock: empty
 * means "it reported a finding and no evidence text", and it renders as that
 * absence rather than as an empty disclosure the reader opens for nothing. Its
 * sentence said "No repro text" until 2026-08-05; "repro" is a word from bug
 * trackers, and the sentence is unchanged in meaning without it.
 */
function FindingRow({ finding }: { finding: AdversaryFinding }): ReactNode {
  const tone = SEVERITY_TONE[finding.severity] ?? "neutral";
  return (
    <li
      title={finding.klass === "" ? undefined : `class: ${finding.klass}`}
      className="flex items-start gap-2.5 border-b border-line/70 px-3 py-2 last:border-b-0"
    >
      <span
        className={cx(
          "mt-[2px] w-[54px] shrink-0 font-mono text-[10px] uppercase tracking-[0.04em]",
          TONE_TEXT[tone],
        )}
      >
        {finding.severity}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug text-ink-dim">{finding.summary}</p>
        {finding.detail === "" ? (
          <p className="mt-1 text-[11px] leading-snug text-ink-faint">
            No detail was filed with this one.
          </p>
        ) : (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-ink-dim marker:text-ink-faint">
              What it says it saw
            </summary>
            <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-dim">
              {finding.detail}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

/**
 * The panel. `null` in, nothing out — see the block docblock for that cost.
 *
 * THE THREE BODIES ARE THREE DIFFERENT SENTENCES and that is the requirement, not
 * a style choice. Read them side by side rather than reading this branch: "did
 * not run", "ran and left no report", "reported and listed nothing" must not be
 * substitutable for one another, and the header count exists only when there is
 * a list to count.
 */
function AdversaryPanel({ pass }: { pass: AdversaryPass | null }): ReactNode {
  if (pass === null) return null;

  // The second `?? null`: an older server's body could carry the record without
  // the key. `null` here means "no report", which is the safe reading of an
  // absence — never "found nothing".
  const findings = pass.findings ?? null;
  const stopDetail = pass.stopDetail ?? "";
  const showStop = pass.stop !== "ran";

  /*
   * Sorted by severity on a COPY (`sort` mutates, and the prop is the wire's own
   * readonly array). `Array.prototype.sort` is stable, so findings of equal
   * severity keep the order the pass filed them in. Findings carry no id — the
   * index of this sorted, static list is the key, which holds because nothing
   * re-orders or splices it after render.
   */
  const ordered =
    findings === null
      ? []
      : [...findings].sort(
          (a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4),
        );

  return (
    <Panel
      /*
       * "HUMAN-FACTORS PASS" WAS THE HEADING UNTIL 2026-08-05. It is a term of
       * art for a discipline, not a description of what this panel holds; what
       * the lane actually does is read the finished site and report what got in
       * the way of using it, which is what "usability" means in plain English.
       * Nothing about the mechanism changed, so nothing about the claim did.
       *
       * THE SENTENCE DESCRIBING THE MECHANISM IS BEHIND THE `i`. It answers
       * "where did this come from", which a reader wants once and then never
       * again, and it was the first half of a 30-word subtitle sitting above
       * every finding forever.
       */
      title={
        <span className="flex items-center">
          Usability review
          <Explain about="the usability review" className="ml-1" testId="explain-usability">
            A separate reader is pointed at the finished site and asked what got in
            the way of using it.
          </Explain>
        </span>
      }
      /*
       * "THE PASS OR FAIL ABOVE", NOT "the verdict above" — 2026-08-05. The
       * sentence's job is unchanged and is the reason it exists at all: nothing
       * in this list moved `heldOutPass`, `status` or `failureReason`, so a
       * reader must not take a HIGH finding here as the reason the run failed.
       * The thing it points at is the outcome notice at the top of this same
       * panel, which says "Passed"/"Failed" — so it is now named by the words
       * that are actually printed up there.
       *
       * AND IT STAYS INLINE, WHICH IS THE ONE THING ON THIS PANEL THAT DOES.
       * Everything else here was deleted or hidden. This is not decoration and
       * it is not a consequence of a later action: a reader looking at a CRITICAL
       * row has ALREADY misread it by the time an `i` would have told him
       * otherwise, and what he does next — go hunting for the finding that failed
       * his run — is wasted on a run this list never touched. It must be readable
       * without interaction, above the list, every time.
       */
      subtitle="Reported only. Nothing here changed the pass or fail above."
      /*
       * THE COUNT EXISTS ONLY WHEN THERE IS A LIST TO COUNT, and this is the
       * other half of the no-report/found-nothing rule rather than a cosmetic
       * choice. `0 filed` in a header slot reads as "found nothing" from across
       * the room, and it would sit directly above a body saying the pass left no
       * report — the header is where a reader actually looks, so the two states
       * would collapse there no matter how carefully the body is worded.
       */
      actions={
        ordered.length === 0 ? undefined : (
          <span className="text-[11.5px] text-ink-faint">
            <span className="numeric">{ordered.length}</span> filed
          </span>
        )
      }
      /*
       * `p-0` UNCONDITIONALLY, with each body carrying its own padding: the rows
       * need edge-to-edge separators, the sentences need a gutter, and
       * `exactOptionalPropertyTypes` refuses a conditional `undefined` on a
       * `string` prop anyway.
       */
      bodyClassName="p-0"
    >
      {/*
       * THE THREE SENTENCES STAY INLINE AND THEIR THREE PARAGRAPHS DO NOT —
       * 2026-08-05, and the split is not the same in all three cases.
       *
       *   ran/no report   The paragraph's job was "this is not the same as
       *                   finding nothing", which is exactly the misreading the
       *                   whole block exists to prevent — a reader who takes it
       *                   for a clean bill has drawn a conclusion. Kept, hidden.
       *   did not run     DELETED OUTRIGHT. "Nothing was reviewed, so this says
       *                   nothing about the site either way" is what "did not
       *                   run" already means; and the stop line rendered
       *                   immediately below says WHY it did not run, so the
       *                   reader is not left with a bare denial.
       *   listed nothing  "An empty report, not a missing one" restates the
       *                   sentence above it and is deleted with it; the
       *                   calibration that survives is "not a guarantee there is
       *                   nothing to find", which is the difference between one
       *                   reader's opinion and a clean bill.
       */}
      {findings === null ? (
        pass.ran ? (
          <div className="px-3 py-2.5">
            <p className="flex items-start text-[12.5px] leading-snug text-ink">
              The pass ran and left no report.
              <Explain about="the missing report" className="ml-1" testId="explain-no-report">
                That is not the same as finding nothing. The report is a file the
                session writes, and this run has none.
              </Explain>
            </p>
          </div>
        ) : (
          <div className="px-3 py-2.5">
            <p className="text-[12.5px] leading-snug text-ink">The pass did not run.</p>
          </div>
        )
      ) : ordered.length === 0 ? (
        <div className="px-3 py-2.5">
          <p className="flex items-start text-[12.5px] leading-snug text-ink">
            The pass filed its report and listed nothing.
            <Explain about="an empty report" className="ml-1" testId="explain-empty-report">
              One reader&rsquo;s pass over the finished site — not a guarantee there
              is nothing to find.
            </Explain>
          </p>
        </div>
      ) : (
        <ul>
          {ordered.map((finding, index) => (
            <FindingRow key={`${finding.severity}:${String(index)}`} finding={finding} />
          ))}
        </ul>
      )}

      {/*
       * Composes with every body above rather than replacing one: `adversaryLane`
       * returns `ran: true` WITH findings on the timeout path, so a partial list
       * and a "stopped early" line are a real pair, not a contradiction.
       */}
      {showStop && (
        <div className="px-3 pb-3">
          <StopBlock stop={pass.stop} stopDetail={stopDetail} />
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* The rail panels                                                     */
/* ------------------------------------------------------------------ */

/**
 * OVERVIEW — the default panel, and the one the owner asked for by name: "maybe
 * like a overview of the project and what has been entered".
 *
 * IT IS WHERE THE RUN CHIP WENT. `RunHud` floated in the canvas's top-left corner
 * carrying the status, the ticket's name, the phase, the model, the clock, Cancel,
 * Resume and a "run detail" button. Four of those are its "This run" section here;
 * the STATUS also survives as a 6px dot on this panel's own rail icon
 * (`canvas/rail.tsx`), so a rail with everything closed still says how the run
 * went. The "run detail" button is deleted outright — it opened the right-hand
 * sheet the rail replaces, so it now names nothing.
 *
 * `run-hud.tsx` IS LEFT STANDING WITH NO IMPORTER, deliberately and not silently:
 * it is another lane's file this pass, so it is not deleted here, and the two
 * pieces of reasoning inside it that this section depends on are reproduced below
 * with attribution rather than re-derived.
 *
 * THE FIVE SECTIONS, AND WHY THIS ORDER. Status first because it is the question
 * the screen is opened with; then what was asked for; then who did it; then what
 * it ran on and cost. Actions live with the status they act on rather than in a
 * toolbar somewhere else.
 */
export interface OverviewPanelProps {
  readonly run: RunDetail;
  readonly model: ModelOption | null;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onResume: () => void;
  readonly graph: GraphState;
  readonly selectedId: string | null;
  readonly onSelect: (nodeId: string | null) => void;
  readonly showAmbient: boolean;
}

export function OverviewPanel({
  run,
  model,
  nowMs,
  busy,
  onCancel,
  onResume,
  graph,
  selectedId,
  onSelect,
  showAmbient,
}: OverviewPanelProps): ReactNode {
  const meta = statusMeta(run.status);
  const phase = phaseMeta(run.phase);
  const elapsed = elapsedBetween(run.startedAt, run.endedAt, nowMs);
  const terminal = isTerminalStatus(run.status);

  /*
   * WHICH KIND OF `awaiting_input` THIS IS, which is the only reason `Resume`
   * below is conditional on more than the status. Carried over from
   * `run-hud.tsx`, whose docblock has the whole argument; the short version is
   * that a BODYLESS resume during a design park locks `manifest.refs[0]` "with no
   * judgement applied", so the owner's click would record a pick the owner did not
   * make. The answer to a design park is a card in `DesignLockPanel`, which is the
   * Questions panel now.
   *
   * `designLockPhase` is one comparison chain in `lib/mockups.ts` and is derived
   * here rather than threaded in as a prop for the reason that file's callers all
   * give: a prop would be a second value that can disagree with the `run` this
   * panel is already rendering.
   */
  const lockPhase =
    run.designLock === null ? null : designLockPhase(run.status, run.designLock);

  /*
   * THE OPEN-THE-SITE CONTROL LIVES HERE TOO — owner's finding, 2026-08-18:
   * three separate hunts ended on the wrong tab. Overview is where the eye
   * lands first, so the same one-click control the Result panel's Project card
   * carries is repeated beside the run's name. Same hook, same SWR key, same
   * dedupe — two mounts of one mechanism, not a second mechanism.
   */
  const projects = useProjects();
  const projectControl = useProjectControl(async () => projects.mutate());
  const project =
    projects.data?.projects.find((candidate) => candidate.runId === run.runId) ?? null;

  return (
    <TabBody>
      <PanelSection title="this run" testId="overview-this-run">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone} title={meta.meaning}>
            <Dot tone={meta.tone} pulse={meta.live} />
            {meta.label}
          </Badge>
          <HeldOutBadge heldOutPass={run.heldOutPass} />
          <FalseFinishBadge falseFinish={run.falseFinish} />
        </div>

        {/*
         * THE RUN'S NAME, DERIVED AND NEVER THE RAW TICKET. `ticketLabel` drops a
         * recognised opener, keeps the first clause, reduces a URL to its host and
         * cuts on WORD boundaries — it deletes, it never writes, so nothing here
         * can be wrong ABOUT the run. The whole brief is on the tooltip, and
         * verbatim in "what you asked for" two sections down, which is the copy
         * that reaches touch and a screen reader.
         *
         * IT IS NOT AN `h1` ANY MORE. `RunHud`'s was the run page's only top-level
         * heading; the page now renders one of its own that does not come and go
         * with a panel. Two `h1`s on one document is worse than a `p` here.
         */}
        <p
          className="mt-2 truncate text-lede font-semibold text-ink"
          title={ticketTooltip(run.ticketTitle, run.ticketText)}
        >
          {ticketLabel(run.ticketTitle)}
        </p>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
          <span title={phase.blurb}>{phase.label}</span>
          <span aria-hidden="true">·</span>
          <span title={run.modelId}>{model?.label ?? run.modelId}</span>
          <span aria-hidden="true">·</span>
          <span className="numeric" title={run.endedAt === null ? "Elapsed" : "Took"}>
            {elapsed === null ? "n/a" : formatDuration(elapsed)}
          </span>
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{run.runId}</p>

        {project !== null && (
          <div className="mt-2" data-testid="overview-open-site">
            <ProjectControls project={project} control={projectControl} />
          </div>
        )}

        {/*
         * THE ACTIONS SIT WITH THE STATUS THEY ACT ON. Cancel is offered on every
         * non-terminal run; Resume only in the two states the server will honour a
         * bodyless one in — `rate_limited`, and an `awaiting_input` that is NOT a
         * design park. `failed` was dropped from this pair on 2026-07-30 because
         * `Orchestrator.resume` returns false on `isTerminal` before it does
         * anything else and the route answers 409, so the button could only ever
         * produce an error notice.
         *
         * NEITHER IS THE ONLY WAY TO REACH THEM. `RateLimitNotice` and
         * `AwaitingInputNotice` carry their own Resume and they FLOAT over the
         * canvas rather than living in a panel — a run that is stopped waiting on
         * the owner must not need an icon click to say so.
         */}
        {(!terminal ||
          run.status === "rate_limited" ||
          run.status === "awaiting_input") && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {!terminal && (
              <Button variant="danger" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            )}
            {(run.status === "rate_limited" ||
              (run.status === "awaiting_input" && lockPhase !== "pending")) && (
              <Button
                variant="primary"
                onClick={onResume}
                disabled={busy}
                /*
                 * TRIMMED 2026-08-05, NOT DEMOTED. The plan-park sentence ended
                 * "— the same place the run lands if the window simply closes",
                 * which describes what happens if the reader does NOTHING; it
                 * cannot change the decision this button is about. Deleted. What
                 * is left is the consequence of the CLICK, and it stays on a
                 * `title` rather than moving behind an `<Explain>` because an
                 * `<Explain>` inside a `<button>` is a button inside a button.
                 * `AwaitingInputNotice` (run/notices.tsx) carries the same
                 * warning in full, inline, and floats over the canvas.
                 */
                title={
                  run.phase === "plan" && run.status === "awaiting_input"
                    ? "Carry on without answering. Every open question is recorded as an assumption."
                    : "Put this run back in the queue."
                }
              >
                Resume
              </Button>
            )}
          </div>
        )}
      </PanelSection>

      {/*
       * WHAT YOU ASKED FOR — THE WORDS, AND THE FILES.
       *
       * This was the `ticket` tab, moved whole. `OutcomeNotice` and
       * `DeliveryNotice` used to render above the brief — so the pass/fail of the
       * run was announced on the surface about what was ASKED FOR, and the one
       * called Verdict carried criteria and captures but no verdict. Both moved to
       * Result; see the comment there for what happened to the delivery half.
       *
       * `TicketAttachmentsPanel` IS HERE AND NOT ON RESULT, and the placement is
       * the whole anti-confusion mechanism rather than a layout preference. Result
       * already renders a disclosure called "Design references" inside
       * `ScreenshotsPanel` — `ui-designer`'s GENERATED mockups. These are the
       * owner's UPLOADS. Two panels means no screen can ever show them under one
       * heading; read `attachments.tsx`'s header before moving either.
       */}
      <PanelSection title="what you asked for" testId="overview-ticket">
        {/*
         * ABOVE THE BRIEF, AND THAT ORDER WAS CHANGED AFTER LOOKING AT IT.
         *
         * It was mounted under the ticket text first. On the owner's own run the
         * brief is 1,100 words — three sentences the owner typed, then the
         * intake's whole "WHAT THE DASHBOARD READ FROM THE PAGE THIS TICKET NAMES"
         * dump — so the panel rendered roughly 900px below the fold. Playwright
         * still called it visible (a non-empty box is visible), which is exactly
         * how a feature ships and is then reported missing; this screen has paid
         * that bill once already, in the 80 minutes when the chat was mounted
         * somewhere nobody could reach.
         *
         * IT COSTS NOTHING WHEN THERE IS NOTHING, which is what makes the order
         * free: the panel returns `null` for two empty lists, so a ticket with no
         * attachments opens on the brief exactly as before. The brief is unbounded
         * and the file list is short — the short, scannable half goes first.
         *
         * `?? []` FLATTENS AN ABSENT KEY, and it is load-bearing rather than
         * belt-and-braces. `lib/api.ts` does `parsed as T` with no runtime
         * validation, and EVERY run recorded before these routes existed answers
         * with a body carrying neither field — measured 2026-08-02 against the
         * running backend. Without it the panel reads `.length` off `undefined`
         * and takes the whole panel down.
         */}
        <TicketAttachmentsPanel
          references={run.references ?? []}
          documents={run.documents ?? []}
        />

        {/*
         * WHAT THE REFERENCE PAGE WAS OBSERVED TO DO — a sibling of the
         * attachments panel because it answers the same question about the same
         * surface: what did this ticket arrive carrying. Attachments are the files
         * the owner handed over; this is the page he pointed at.
         *
         * `?? null` FOR THE SAME REASON THE LINE ABOVE SPREADS `?? []`, and it is
         * the same measured hazard rather than a copied habit. `RunDetail.motion`
         * is DECLARED required, so `run.motion` is `ApiMotionSpec | null` to the
         * compiler and this flattening looks redundant to it — but `lib/api.ts`
         * casts with `parsed as T` and validates nothing, and every run recorded
         * before 2026-08-04 answers with no `motion` key at all. Without the `??`,
         * `undefined` walks past the panel's `=== null` guard and
         * `.entries.length` throws, which blanks the whole panel rather than one
         * box. `motion-readout.browser.spec.ts`'s `MISSING_KEY` case is the only
         * check in the tree that goes red when this operator is deleted — verified
         * by deleting it, not by reasoning about it.
         */}
        <div className="mt-2.5">
          <MotionReadoutPanel motion={run.motion ?? null} />
        </div>

        <div className="mt-2.5 rounded border border-line bg-surface">
          <p className="border-b border-line px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
            the ticket, verbatim
          </p>
          <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-ink-dim">
            {run.ticketText}
          </pre>
        </div>
      </PanelSection>

      {/*
       * WHO WORKED ON IT — the `agents` tab, buried on purpose and with its job
       * intact.
       *
       * It is not a rail entry because THE CANVAS IS THE AGENT LIST: an icon that
       * opens a list of the things already drawn on screen is the definition of a
       * redundant entry. What the list is genuinely for is unchanged and is
       * written on it — the faster read when you already know the name, and the
       * ungrouped truth, so a folded deck cannot hide an agent from it. The
       * component is not modified, only re-parented; clicking a row still selects
       * the card on the canvas.
       *
       * THE 41-WORD CAPTION THAT USED TO SIT ABOVE THE ROSTER IS BEHIND THE `i` —
       * 2026-08-05. It said three things: that the list is in arrival order and
       * never folded, that picking a row selects the card, and that the canvas is
       * arrow-key navigable. The third is a property of the CANVAS and is
       * discoverable by pressing an arrow key on it, so it is DELETED. The first
       * two are the answer to "why is this list here when the graph is right
       * there" — it is where you look when the canvas has folded the agent you
       * want into a deck — and that changes where a reader goes, so they are KEPT
       * and hidden rather than deleted.
       */}
      <PanelSection
        title="who worked on it"
        explain={
          <Explain about="the agent list" className="ml-1" testId="explain-roster">
            In arrival order and never grouped — the canvas folds some of these
            into decks, and picking one here selects its card on the canvas.
          </Explain>
        }
        testId="overview-agents"
        bodyClassName="p-0"
      >
        <AgentRoster
          graph={graph}
          selectedId={selectedId}
          onSelect={onSelect}
          showAmbient={showAmbient}
        />
      </PanelSection>

      {/*
       * MACHINE AND COST — the `env` tab, whose own tab label was already "Run".
       *
       * The word "Env" is gone from this app entirely, and burying the surface is
       * the other half of that: what a run was executed on and what it cost is a
       * property OF the run, and this panel is the run. It was never a peer of
       * Chat.
       *
       * THE SECOND EYEBROW IS BEHIND THE `i` — 2026-08-05. "reported once, by the
       * CLI, at the start of the run" was a second uppercase mono strip directly
       * under the first one, which reads as a heading that failed to render. The
       * FACT is kept because it is the difference between a stale reading and a
       * live one: a reader who takes this for the machine's state now will act on
       * it. Hidden, not deleted.
       *
       * AND THE FACT ITSELF WAS WRONG, WHICH IS WHY THE HIDDEN SENTENCE IS LONGER
       * THAN THE EYEBROW IT REPLACED. "Reported once … at the start of the run"
       * is not what the server does. `graph_inventory` is emitted from
       * `builders/claude-builder.ts:1420`, inside the `system/init` branch of the
       * per-SEGMENT message loop — so it fires once for every CLI session a run
       * opens, not once for the run. And `graph.ts:960` REPLACES `state.inventory`
       * wholesale on each one. What this panel shows is therefore the most recent
       * segment's reading, not the run's first.
       *
       * The first draft of the replacement said "…and not updated since", which
       * would have made a false claim shorter and friendlier than the true one.
       * It says what the code does instead. A plain word that misleads is worse
       * than the jargon it replaced.
       */}
      <PanelSection
        title="machine and cost"
        explain={
          <Explain about="machine and cost" className="ml-1" testId="explain-env">
            The CLI reports this each time it starts a step. What is shown is the
            latest reading, not a live one.
          </Explain>
        }
        testId="overview-env"
      >
        <EnvironmentPanel inventory={graph.inventory} />
        <div className="mt-2.5">
          <UsagePanel run={run} model={model} />
        </div>
      </PanelSection>
    </TabBody>
  );
}

/**
 * RESULT — was "Verdict", and the rename is a correction rather than a softening.
 *
 * "Checks" was the obvious plain word and it is WRONG about this panel: it carries
 * the artifact path and the published copy as well as the graded criteria, and a
 * friendly label that misleads is worse than the jargon it replaced. "Result"
 * covers all of it — whether it passed, what it was checked against, and where the
 * work landed.
 */
export function ResultPanel({ run }: { run: RunDetail }): ReactNode {
  return (
    <TabBody>
      {/* Whether it passed — first, above the evidence for it. `OutcomeNotice`
          prints "Passed"/"Failed"/"FALSE FINISH"; the panel is called Result
          because it carries the artefact path and the published copy as well. */}
      <OutcomeNotice run={run} />

      {/*
       * WHERE THE WORK LANDED — THE ARTEFACT PATH ONLY, AND THAT IS A DELIBERATE
       * HALF OF `DeliveryNotice`.
       *
       * That component renders two things: this path, and `run.previewUrl` as a
       * link. The preview link is dead by construction — the server that answered
       * that address was the run's, and it went down with the run — so it is a
       * historical record rather than somewhere to click, and it is not carried
       * here. It is a known-open item with its own owner; deciding what a dead
       * address should say instead is that item's call, not this move's.
       *
       * THE CONSEQUENCE, SAID OUT LOUD: with this panel rendering the path itself,
       * `DeliveryNotice` has no importer left and `previewUrl` now renders nowhere
       * in the app. `notices.tsx` is another agent's file in this pass, so the
       * component is left standing rather than deleted.
       *
       * The path is an absolute HOST path — copyable text, never a link.
       *
       * THE LABEL WAS "ARTIFACT" UNTIL 2026-08-05, and the owner named it as a
       * word that means nothing to him. It is `runPaths.workspace`
       * (`server/src/orchestrator.ts:1766`) — the builder's own working
       * directory — and "Workspace" is both plainer and the word the rest of the
       * app already uses for the same directory: the Files panel is headed "The
       * run's workspace, read-only" and `PublishedProjectPanel` says "the
       * workspace at …". One directory, one word.
       *
       * THE `i` CARRIES THE DISTINCTION THIS PAIRING EXISTS TO MAKE, which the
       * two labels alone do not: both rows are folders, and a reader who opens
       * this one has opened the evidence rather than the copy that was made for
       * him. That changes which folder he opens, so it is hidden rather than
       * deleted.
       */}
      {run.artifactPath !== null && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded border border-line bg-surface px-3 py-2">
          <span className="flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Workspace
            <Explain about="the workspace folder" className="ml-1" testId="explain-workspace">
              The folder this run worked in, kept as evidence. The copy meant for
              you is the project below.
            </Explain>
          </span>
          <MonoPath path={run.artifactPath} max={80} />
        </div>
      )}

      {/*
       * DIRECTLY UNDER THE ARTIFACT PATH, AND THAT PAIRING IS THE POINT.
       *
       * Both answer "where did the work land". The artifact is the run's own
       * workspace — evidence, kept for re-scoring, named by a 44-character run id
       * — and this is the COPY made for the owner, under the ticket's name, which
       * is the one he is meant to open. Put anywhere else they read as two
       * unrelated paths.
       *
       * IT IS UNCONDITIONAL, unlike the row above it, because all four states of
       * `RunDetail.publishedProject` are worth a sentence: a run that has not
       * finished, a run with no record, a publish that was refused and a copy that
       * exists. The panel decides which; see its docblock for why "no record" and
       * "refused" may never be drawn the same way.
       *
       * IT IS THE ONLY THING HERE THAT ACTS ON THE WORLD — it can spawn and kill a
       * process — so it sits under the verdict and the evidence rather than above
       * them.
       */}
      <PublishedProjectPanel run={run} />

      {/*
       * `machineChecks ?? null` FOR THE SAME REASON `designLock ?? null` AND
       * `adversary ?? null` BELOW: `lib/api.ts` casts the response without
       * validating it, and every run recorded before this field existed answers
       * with a body that has no such key. `undefined` and `null` mean the same
       * thing to the panel — this run has no gate result to show — and the
       * flattening is done here rather than inside it so the component's own
       * contract stays two-valued.
       */}
      <CriteriaPanel criteria={run.criteria} machineChecks={run.machineChecks ?? null} />

      {/*
       * `designLock` IS NULL FOR A RUN WITH NO DESIGN LANE, which is not the same
       * as a lane that published nothing — but the panel only needs the published
       * set to tell a mockup from a capture of the built site, and both cases
       * yield an empty one. `?? []` rather than an optional prop:
       * `exactOptionalPropertyTypes` is on, so the prop is required and the caller
       * does the flattening.
       */}
      {/*
       * THE WHOLE LOCK, NOT JUST ITS MOCKUPS, SINCE 2026-08-03. A canvassed run
       * publishes stills from directions it OFFERED AND DISCARDED and stills the
       * owner ASKED FOR at the park, and the panel's disclosure calls all of them
       * "the mockups the run was built to" — a false claim about two thirds of
       * them, and the discarded ones are precisely what the run was NOT graded
       * against. Which is which is only decidable from `directions[]` and
       * `requests[]`.
       */}
      <ScreenshotsPanel
        runId={run.runId}
        screenshots={run.screenshots}
        designLock={run.designLock ?? null}
      />

      {/*
       * LAST, UNDER THE CAPTURES OF THE THING IT IS JUDGING, and separated from
       * `CriteriaPanel` by the whole screenshots panel on purpose —
       * `AdversaryPass`'s own instruction is "never beside a criterion result".
       * `?? null` because `lib/api.ts` casts the response without validating it
       * and the browser fixtures still serve a body with no `adversary` key; see
       * the block docblock above. It renders nothing at all for a run with no
       * record, which is every run today.
       */}
      <AdversaryPanel pass={run.adversary ?? null} />
    </TabBody>
  );
}

/**
 * FILES — was "Code", and it is the surface the owner pointed at a screenshot of
 * VS Code's explorer to describe: "the index where the code structure is".
 *
 * THE CONTRACT IS UNCHANGED FROM THE TAB, so the component arriving here needs no
 * coordination beyond it: this panel renders exactly one child, it is handed the
 * run id and nothing else, and it owns its own fetching, loading, empty and error
 * states. It gets a full-height scroll container with no padding — the tree and
 * the file pane manage their own — and it must not assume a width above 320px,
 * because at a 375px viewport this panel is very nearly the viewport. Nothing in
 * the canvas reads anything back out of it, and it is not told which agent is
 * selected: the workspace is a fact about the RUN, and a file tree that changed
 * under you as you clicked cards on the graph would be a worse tool, not a better
 * one. If a per-agent view is ever wanted it should arrive as its own prop rather
 * than by reusing the selection.
 *
 * IT IS MOUNTED ONLY WHILE IT IS OPEN, and that is deliberate: `CodeBrowser`
 * fetches the workspace tree on mount, so an always-mounted one would pull a tree
 * for every run view whether or not anyone asked for the files.
 */
export function FilesPanel({ run }: { run: RunDetail }): ReactNode {
  return (
    <div className="h-full min-h-[420px]">
      <CodeBrowser runId={run.runId} />
    </div>
  );
}

/**
 * ACTIVITY — was "Trace", and neither "Log" nor "History" would have been true.
 *
 * It is the whole event record, oldest first, AND a live tail with its own
 * reconnect control. "Log" describes only the record and "History" only the past;
 * "Activity" is the one plain word that covers a stream that is still arriving.
 */
export function ActivityPanel({
  trace,
  stream,
  onReconnect,
}: {
  readonly trace: readonly TraceEntry[];
  readonly stream: StreamState;
  readonly onReconnect: () => void;
}): ReactNode {
  return (
    <div className="p-3">
      <TracePane trace={trace} stream={stream} onReconnect={onReconnect} />
    </div>
  );
}
