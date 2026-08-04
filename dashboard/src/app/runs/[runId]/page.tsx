"use client";

/**
 * The run view. THE CANVAS IS NOW LITERALLY THE PAGE.
 *
 * WHAT CHANGED AND WHY. This screen has been through three shapes and this is
 * the third. It began as a column of panels — trace, criteria, screenshots,
 * usage, ticket — which described a multi-agent run as a list of things that had
 * happened to it. It then became a three-column orchestration row: a TICKET card
 * and AGENTS list down the left, the canvas in the middle track, an INSPECTOR,
 * ENVIRONMENT and USAGE stack down the right, and the record underneath. The
 * owner's verdict on that shape was specific and correct:
 *
 *   "there is too much info that i dont need around the sides. The main screen is
 *   the canvas screen and the info i require only comes up when i press on the
 *   node… runs is permanently under fullscreen canvas with it been zoomed in on
 *   the whole flow by default."
 *
 * So: one canvas, the size of the viewport, fitted to the whole graph on load.
 * Every panel that used to flank it is behind one of two sheets — `DetailSheet`
 * for an agent, `RunSheet` for the run — and neither is open until asked for. See
 * `canvas/sheet.tsx` for what went where, and for why the agent index survived
 * the cut.
 *
 * FIVE THINGS ARE STILL UNCONDITIONALLY ON SCREEN, and each earns it:
 *
 *   - the canvas;
 *   - the run chip (`RunHud`): status, title, phase, clock, Cancel, Resume. A
 *     control that stops a run going wrong does not belong behind a click;
 *   - the `chat` control directly under it — see below, it is why this list says
 *     five rather than four;
 *   - the role legend, because colour that has to be looked up is not working;
 *   - a notice, WHEN the run is in a state that needs one.
 *
 * WHERE THE CHAT WENT AND WHY IT IS NOW ONE OF THE FIVE — 2026-07-30.
 *
 * It used to mount inside `DetailSheet`, and only for a node with
 * `parent === null`. That is a correct place for it and an unreachable one: no
 * node exists until the BUILD segment emits its first `graph_agent`, which on the
 * owner's recorded run was 79.5 minutes in. For those 79.5 minutes the screen
 * offered no way to say anything to a run that the SERVER was accepting messages
 * for the whole time (`postMessage` refuses a terminal run and nothing else), and
 * whose most valuable message is the earliest one — a queued message is folded
 * into the prompt the first design/build segment is composed from, i.e. into the
 * brief the builder actually works to.
 *
 * So the chat is a `RunSheet` tab (messages are addressed to the RUN, never to a
 * node), and the entry point is a control in this dock that is rendered in every
 * status, including terminal ones, where the composer shows itself disabled with
 * the reason on it. A feature invisible in the state the reader happens to be in
 * is not a tidy feature, it is a missing one — that was learned the expensive way
 * when the owner's only finished run reported "i dont see any chat anywhere".
 *
 * THE COMPOSER STILL CANNOT APPEAR ON A SUB-AGENT, and now for a structural
 * reason instead of a conditional one: `DetailSheet` no longer has a chat slot to
 * gate. A sub-agent is spawned with a prompt and ends; a chat box on one is a
 * control that cannot act.
 *
 * WHERE `CodeBrowser` WENT, because it was mounted here by another task while
 * this one was in flight and its call site has moved rather than vanished. It is
 * now the `RunSheet`'s "Code" tab, with the same one-prop contract — `runId`, and
 * nothing else. The reasoning it arrived with ("a tree plus a file needs two
 * columns of its own, so it gets the full width") is answered rather than
 * overruled: in the sheet it gets 560px and its own full-height scroll container,
 * which is more usable width than the 324px rail it was avoiding, and it is no
 * longer competing with the graph for the first screen. It is reachable in two
 * keystrokes from anywhere on the canvas.
 *
 * WHY THE NOTICES AND THE DESIGN LOCK ARE DOCKED RATHER THAN TABBED. Both are
 * about a run that is STOPPED and waiting on the reader. `awaiting_input`,
 * `rate_limited` and a pending design lock are not detail, they are the only
 * thing on the screen that matters at that moment, and a decision hidden behind a
 * tab is a decision nobody makes. The design lock stays docked in its settled
 * phases too: a lock that has already resolved is the record of a choice the
 * owner made, and `design-lock.browser.spec.ts` asserts the panel is visible
 * without a click in all four of the shapes `RunDetail.designLock` arrives in.
 *
 * FULL BLEED IS NOW THE SHELL'S JOB, AND HAD TO BECOME IT — 2026-07-30.
 *
 * This file used to say "the shell is not this task's file", and cancelled `main`'s
 * padding with `-mx-4 -mt-4` plus `100dvh - var(--run-chrome)`. That cannot work
 * and the reason is simple: `main` also carried `max-w-[1440px] mx-auto`, and NO
 * CHILD CAN CANCEL A max-width ON ITS PARENT. On the owner's 2000px window the
 * result was a 1440px canvas with 280px of dead gutter down each side — measured
 * in the browser, `mainLeft: 280, mainRight: 1720` — which is precisely the
 * "fullscreen canvas" this redesign claimed to have shipped.
 *
 * So `AppShell.isFullBleed` now drops the cap and the padding for `/runs/<id>`
 * only, and this wrapper is a plain `h-full`. The `--run-chrome` subtraction is
 * gone with it: it was a measured constant ("94px still produced a 1px document
 * overflow") whose defence — `run-canvas.browser.spec.ts` — DID NOT EXIST. Flex
 * fill has no constant to get wrong. `run-layout.browser.spec.ts` now measures the
 * bleed and the absence of a scrollbar, which is the guard that comment described.
 *
 * THE MOUNT ORDER STILL MATTERS. `run === undefined` early-returns above the
 * canvas, which is the boundary spec §9.3 requires the canvas to live below:
 * rendering it above would remount React Flow the moment the run detail arrived
 * and throw away the viewport.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { DesignLockPanel } from "@/components/run/design-lock";
import { PlanDialoguePanel } from "@/components/run/plan-dialogue";
import { PreBuildPanel } from "@/components/run/prebuild-panel";
import { ticketLabel, ticketTooltip } from "@/lib/ticket-title";
import { planDialogueFrom } from "@/lib/plan-dialogue";
import {
  ApiDownNotice,
  AwaitingInputNotice,
  RateLimitNotice,
} from "@/components/run/notices";
import { OrchestrationCanvas } from "@/components/canvas/orchestration-canvas";
import { RunHud } from "@/components/canvas/run-hud";
import {
  DetailSheet,
  RunSheet,
  type RunSheetTab,
} from "@/components/canvas/sheet";
import { Button, Notice, Panel, Skeleton, cx } from "@/components/ui";
import {
  ApiError,
  cancelRun,
  errorMessage,
  resumeRun,
  resumeWithDirection,
  runMessages,
  sendRunMessage,
  type ChatMessage,
} from "@/lib/api";
import { OrchestratorChat } from "@/components/canvas/orchestrator-chat";
import { findModel } from "@/lib/cost";
import { useModels } from "@/lib/hooks";
import { isTerminalStatus, type RunDetail } from "@/lib/api-types";
import { designLockPhase } from "@/lib/mockups";
import { useLiveRun, useNow } from "@/lib/use-run-stream";

/**
 * What actually happens to a message typed RIGHT NOW — or null when
 * `OrchestratorChat`'s own copy already covers this state correctly.
 *
 * READ OUT OF THE SERVER AT THE TWO SITES THAT DECIDE IT, because it is not
 * guessable from the status alone and this dashboard's worst habit is copy that
 * promises more than the mechanism:
 *
 *   · LIVE delivery needs an open input channel, and `#liveInputs.set` has
 *     exactly ONE call site (`server/src/orchestrator.ts`, inside the design/build
 *     segment run). Everywhere else `pushLiveMessage` returns false, the row keeps
 *     `delivered_at` NULL and the message is merely stored.
 *   · The QUEUE is drained at exactly one site too: `ownerMessageBlock(pending)`
 *     is appended to the design-segment and build-segment prompts inside
 *     `#buildPhase`, and the rows are stamped only after that prompt is on disk.
 *     The gate's fix rounds and the judge compose their own prompts and never
 *     read a pending message.
 *
 * WHY IT IS WRITTEN HERE. `OrchestratorChat` states both paths in general terms
 * and cannot state which one applies: it is handed `runIsOver` and a message list
 * rather than the run, and its own header says an `isParked` prop would be a
 * caller change and refuses to fake one with a default. This is that caller. Only
 * the states its general paragraph leaves open get a sentence — a running build
 * segment, a park and a terminal run are already described accurately there and
 * get nothing added, because four restatements of one fact is the defect this
 * screen has been cutting all week.
 *
 * IT PREDICTS NOTHING ABOUT A GIVEN MESSAGE. A run can be cancelled before it
 * composes another prompt, and `resume` requeues rather than guaranteeing a
 * segment. The only truthful record of one message's fate is the per-message state
 * line the component renders under it (queued / read at T / never read).
 */
function chatDeliveryNote(run: RunDetail): string | null {
  if (isTerminalStatus(run.status)) return null;
  if (run.status === "queued") {
    return (
      "This run has not started yet — the queue is serial, so it is waiting for the " +
      "run ahead of it. Anything you send now is stored, and travels into the prompt " +
      "its first segment is composed from."
    );
  }
  switch (run.phase) {
    case "spec":
      return (
        "The acceptance suite is being written and there is no build session to push " +
        "into yet, so a message now is stored rather than delivered. Stored messages " +
        "are folded into the next design or build segment's prompt — for a run at this " +
        "phase that is the first one it composes, which is the earliest point anything " +
        "you say can shape what gets built."
      );
    case "gate":
    case "judge":
      return (
        "The build segments are over. A stored message is only folded into a design or " +
        "build segment prompt — the gate's fix rounds and the judge compose their own " +
        "and read none — so a message sent now is likely to end up recorded as never " +
        "read."
      );
    default:
      // `build` (running, parked or between segments) and the momentary `done`
      // before a run turns terminal. The component's own two-path paragraph is
      // accurate for all of them.
      return null;
  }
}

function useRunIdParam(): string | null {
  const params = useParams();
  const raw = params["runId"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

export default function RunPage(): ReactNode {
  const runId = useRunIdParam();
  const { run, error, isLoading, trace, graph, graphReady, stream, refresh, reconnect } =
    useLiveRun(runId);
  const { data: models } = useModels();
  const nowMs = useNow(1_000);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAmbient, setShowAmbient] = useState(false);
  const [runSheetOpen, setRunSheetOpen] = useState(false);
  const [runSheetTab, setRunSheetTab] = useState<RunSheetTab>("ticket");

  /**
   * The pre-build panel is open on the left dock.
   *
   * A BOOLEAN HERE RATHER THAN A VALUE IN `selectedId`. Selection means "show me
   * this agent's detail" and every consumer of it — the sheet, the agent index,
   * the card ring — resolves the key against `graph.nodes`. A stage is not in
   * there and never will be: it is projected from `phase` and `log` rows, not
   * from `graph_agent`. Putting the Plan card in `selectedId` would open a sheet
   * that could find nothing to show.
   *
   * IT LIVES ON THE PAGE AND NOT IN THE CANVAS because the panel is docked by this
   * file and sourced by this file, from the same `graph` snapshot the canvas is
   * drawn from. The canvas is told, so it can draw the card as selected.
   */
  const [planPanelOpen, setPlanPanelOpen] = useState(false);
  const closePlanPanel = useCallback((): void => {
    setPlanPanelOpen(false);
  }, []);

  /**
   * The sections the Plan card stands for, straight off the graph snapshot.
   *
   * `graph.stages` AND NEVER `trace`. `use-run-stream.ts:820-822` refuses to open
   * an EventSource for a terminal run, so a panel derived from the live sink is
   * blank on every finished run — which is most of the runs anyone opens, and is
   * exactly how the pre-build lane shipped empty once already. The stages arrive
   * inside `graph`, folded by the same reducer on the REST snapshot as on the
   * socket, so this is populated on a cold open of a run that ended last week.
   *
   * The orchestrator is dropped because it is its own card on the canvas, not a
   * section of this one.
   */
  const preBuildMembers = useMemo(
    () => (graph.stages ?? []).filter((stage) => stage.id !== "orchestrator"),
    [graph.stages],
  );

  /*
   * THE OWNER↔RUN CHAT.
   *
   * Polled rather than pushed, and that is a deliberate scope line: the SSE stream
   * carries a `log` line when a message is queued and another when it is folded into
   * a prompt, so the trace is already live — but `deliveredAt` lives on the message
   * row, not on an event, and adding a message event type to the frozen `SseEvent`
   * union to save one fetch is not a trade worth making. The refetch runs on send and
   * whenever the Chat tab is brought to the front, which is every moment the panel is
   * readable and could be stale.
   *
   * IT IS ALSO FETCHED ON MOUNT NOW, AND THAT SUPERSEDES THE OLD "NOT UNTIL YOU
   * PRESS CHAT" RULE — 2026-08-02, with the plan phase. Those rows are no longer
   * only a transcript: the plan park's questions ARE `run` rows and the answers
   * ARE `owner` rows (`server/src/plan-dialogue.ts` — the host may not compose a
   * `run` row, so the chat is the phase's whole transport). A decision the run is
   * stopped on cannot be behind a click; see the docked panel below, and
   * `planDialogue` under it for what is read out of these rows.
   */
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const loadMessages = useCallback((): void => {
    if (runId === null) return;
    void runMessages(runId)
      /*
       * `Array.isArray` OVER A TYPE THAT SAYS IT IS ONE, and the guard was added
       * after it fired: `api.ts` casts every response with `parsed as T` and
       * validates nothing, so a body with no `messages` key put `undefined` into
       * this state and `planDialogueFrom` threw "input.messages is not iterable"
       * inside a render memo — a blank run page. It is the same class of absence
       * `canvas/sheet.tsx` already guards with `?? []`, and `design-lock.
       * browser.spec.ts` is what caught it.
       */
      .then((response) => setMessages(Array.isArray(response.messages) ? response.messages : []))
      // A failed poll must not blank the transcript the owner is reading.
      .catch(() => undefined);
  }, [runId]);

  const onSendMessage = useCallback(
    async (text: string, images: readonly string[]): Promise<void> => {
      if (runId === null) return;
      await sendRunMessage(runId, text, images);
      loadMessages();
      // The queued message also lands on the event stream, so pull the trace forward
      // rather than waiting for the next tick to explain the change in behaviour.
      refresh();
    },
    [runId, loadMessages, refresh],
  );

  const act = useCallback(
    (action: (id: string) => Promise<unknown>) => (): void => {
      if (runId === null || busy) return;
      setBusy(true);
      setActionError(null);
      void action(runId)
        .then(() => refresh())
        .catch((cause: unknown) => setActionError(errorMessage(cause)))
        .finally(() => setBusy(false));
    },
    [runId, busy, refresh],
  );

  const onCancel = act(cancelRun);
  const onResume = act(resumeRun);

  /*
   * NOT ROUTED THROUGH `act`, and not because of its signature.
   *
   * `act(resumeRun)` resumes with NO body, which hands the pick to `ui-designer`
   * and records it as automatic. A click that quietly did that would put the
   * owner's name on nobody's decision — or worse, `ui-designer`'s name on the
   * owner's. The choice travels or the request does not.
   */
  const onChooseMockup = useCallback(
    (chosenMockup: string): void => {
      if (runId === null || busy) return;
      setBusy(true);
      setActionError(null);
      void resumeRun(runId, chosenMockup)
        .then(() => refresh())
        .catch((cause: unknown) => setActionError(errorMessage(cause)))
        .finally(() => setBusy(false));
    },
    [runId, busy, refresh],
  );

  /**
   * Stage A's answer: a DIRECTION, by slug.
   *
   * IT SENDS `chosenDirection` AND NOT `chosenMockup`, and that is not
   * belt-and-braces territory. The resume route validates `chosenMockup` against
   * the manifest's refs — `design-lock.browser.spec.ts` records the 409 a
   * published copy earns there — so adding one to a request that is otherwise a
   * clean direction choice can only turn a valid answer into a refusal. The slug
   * is what the server resolves the direction from; the click carries that, or
   * the request does not go.
   */
  const onChooseDirection = useCallback(
    (chosenDirection: string): void => {
      if (runId === null || busy) return;
      setBusy(true);
      setActionError(null);
      void resumeWithDirection(runId, chosenDirection)
        .then(() => refresh())
        .catch((cause: unknown) => setActionError(errorMessage(cause)))
        .finally(() => setBusy(false));
    },
    [runId, busy, refresh],
  );

  // Looked up rather than stored: hiding the housekeeping agents, or a run that
  // ends and re-folds, must not leave the sheet holding a node the canvas no
  // longer draws.
  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const clearSelection = useCallback((): void => {
    setSelectedId(null);
  }, []);

  /*
   * THE PLAN PARK, DERIVED FROM THE TWO CHANNELS IT ACTUALLY USES.
   *
   * There is no `RunDetail.plan` — `lib/plan-dialogue.ts` opens with the check
   * and the reason a client-side mirror was refused — so the questions come out
   * of the chat rows and their outcomes out of the trace. Both are already in
   * this component's hands, which is why this is one pure call and not a fetch.
   *
   * `null` FOR EVERY RUN THAT NEVER PLANNED, including every run recorded before
   * the phase existed, and it falls out of the mechanism rather than a version
   * check: no plan phase, no `run` row whose every line is `PQ-n: …`.
   */
  const planDialogue = useMemo(
    () =>
      run === undefined
        ? null
        : planDialogueFrom({
            messages,
            trace,
            phase: run.phase,
            status: run.status,
          }),
    [messages, trace, run],
  );

  const planParked =
    run !== undefined && run.phase === "plan" && run.status === "awaiting_input";

  /**
   * The park is not merely open — there is a panel on screen offering the answer.
   *
   * The distinction decides whether the GENERIC park notice is suppressed; see
   * the comment at its call site for the two paths on which a run is plan-parked
   * and this is still false.
   */
  const planAnswerable = planParked && planDialogue !== null;

  /**
   * The DESIGN park, open right now.
   *
   * DERIVED BEFORE THE EARLY RETURNS because the poll below it is a hook, and
   * duplicated rather than lifted out of the render body for the same reason.
   */
  const designParked =
    run !== undefined &&
    run.designLock !== null &&
    designLockPhase(run.status, run.designLock) === "pending";

  /*
   * ONE POLL WHILE THE DESIGN PARK IS OPEN, and it is the design dialogue that
   * needs it rather than the cards.
   *
   * `pollIntervalFor` gives an `awaiting_input` run 20 seconds, which is right
   * for a park nobody is interacting with. This one the owner is: he asks for a
   * section to be rendered, the host generates it, publishes the copy and writes
   * the request onto `designLock.requests` — and until the next read, the panel
   * he is staring at shows neither. Twenty seconds of nothing after a click that
   * spends an image generation reads as a dropped request, which is the failure
   * the caps and the request log exist to prevent.
   *
   * It stops the instant the park closes, so a run that canvasses for two
   * minutes and then builds for two hours polls for two minutes.
   */
  useEffect(() => {
    if (runId === null || !designParked) return;
    const timer = window.setInterval(refresh, 6_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [runId, designParked, refresh]);

  /*
   * ONE POLL, BOUNDED BY THE ONE STATE THAT NEEDS IT.
   *
   * `OrchestratorChat`'s header states the constraint plainly: nothing refetches
   * the transcript while it sits open, because a reply is written at the END of a
   * build segment and can be an hour after the question. A PLAN turn is not that.
   * It is a single seat call that answers in seconds, the run is stopped waiting
   * for it, and the owner is looking straight at the panel — so a dialogue that
   * only updates when you leave and come back is this screen failing at the one
   * moment it exists for.
   *
   * SO: one fetch on mount for every run (a settled plan record has to render
   * without a click too), and a timer only while the run is actually parked on a
   * question. It stops the instant the park ends, so a run that plans for two
   * minutes and then builds for two hours polls for two minutes.
   */
  useEffect(() => {
    if (runId === null) return;
    loadMessages();
    if (!planParked) return;
    const timer = window.setInterval(loadMessages, 4_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [runId, planParked, loadMessages]);

  /**
   * One reply from the plan panel.
   *
   * IT IS THE SAME `sendRunMessage` THE CHAT COMPOSER USES, deliberately: the
   * panel's controls compose an addressed string (`PQ-2: six`, `you decide
   * (PQ-2)`) and post it down the ordinary channel, so a reply typed in the Chat
   * tab and a reply given here are the same kind of thing to the server. A second
   * intake would be a second thing to keep in step with `classifyOwnerReply`.
   *
   * IT REJECTS RATHER THAN SWALLOWING. The panel shows the server's own sentence;
   * a plan reply that 409s on a run that has just left the park must say so, not
   * look sent.
   */
  /**
   * One on-demand render request from the design park.
   *
   * THE SAME `sendRunMessage` THE CHAT AND THE PLAN PANEL USE, for the reason
   * `onSendPlanReply` gives directly below: the park's dialogue is a rung in the
   * server's existing message intake, so a request typed here and one typed in
   * the Chat tab are the same kind of thing to the run. A second intake would be
   * a second thing to keep in step with the parser.
   *
   * IT REJECTS RATHER THAN SWALLOWING. A refused ask keeps the owner's words in
   * the box; an ask that looked sent and was not would cost him a turn he never
   * spent and a still he never gets.
   */
  const onSendDesignRequest = useCallback(
    async (text: string): Promise<void> => {
      if (runId === null) return;
      await sendRunMessage(runId, text, []);
      loadMessages();
      // The host answers with a published still and a `requests[]` entry, both
      // of which arrive on the next read of the run — so pull it forward rather
      // than leaving the panel showing a request that appears to have vanished.
      refresh();
    },
    [runId, loadMessages, refresh],
  );

  const onSendPlanReply = useCallback(
    async (text: string): Promise<void> => {
      if (runId === null) return;
      await sendRunMessage(runId, text, []);
      loadMessages();
      // The turn's own log lines — `recorded against PQ-2 (answered, …)` — are
      // what moves a card from open to answered, so pull the trace forward with
      // the transcript rather than leaving the two out of step.
      refresh();
    },
    [runId, loadMessages, refresh],
  );

  /*
   * FETCH WHEN THE CHAT TAB IS BROUGHT TO THE FRONT, rather than on mount or on
   * selection. REWRITTEN 2026-07-30 WITH THE MOVE, because the reason it used to
   * give stopped being true.
   *
   * It said "fetch on select … the chat only exists inside the detail sheet", and
   * hung `loadMessages()` off node selection. The chat is now a run-sheet tab that
   * a node has nothing to do with, so selecting a card pulls no transcript.
   *
   * EXACTLY THREE PATHS FETCH, and `openRunSheet` — directly below, and the most
   * frequent of these four callbacks — is deliberately NOT one of them: it opens
   * the sheet on Ticket, where a transcript is not on screen. Reaching the chat
   * from there goes through `changeRunSheetTab`, which does fetch. The three are
   * `openChat`, `changeRunSheetTab("chat")` and `onSendMessage` above, which
   * together are every moment the transcript is both visible and possibly stale.
   * Re-fetching on them is what keeps `deliveredAt` current without a timer, and a
   * run whose chat is never opened still pulls nothing.
   */
  const openRunSheet = useCallback((): void => {
    setRunSheetTab("ticket");
    setRunSheetOpen(true);
  }, []);

  const openChat = useCallback((): void => {
    setRunSheetTab("chat");
    setRunSheetOpen(true);
    loadMessages();
  }, [loadMessages]);

  const changeRunSheetTab = useCallback(
    (next: RunSheetTab): void => {
      setRunSheetTab(next);
      if (next === "chat") loadMessages();
    },
    [loadMessages],
  );

  const closeRunSheet = useCallback((): void => {
    setRunSheetOpen(false);
  }, []);

  if (runId === null) {
    return (
      <Notice tone="fail" title="No run id in the URL">
        <Link href="/runs" className="text-accent underline underline-offset-2">
          Back to runs
        </Link>
      </Notice>
    );
  }

  if (run === undefined) {
    if (error instanceof ApiError && error.status === 0) {
      return <ApiDownNotice message={error.message} />;
    }
    if (error !== undefined) {
      return (
        <Notice tone="fail" title="Cannot load this run">
          <p>{errorMessage(error)}</p>
          <p className="mt-1.5">
            <Link href="/runs" className="text-accent underline underline-offset-2">
              Back to runs
            </Link>
          </p>
        </Notice>
      );
    }
    return <Panel title="Run">{isLoading ? <Skeleton rows={6} /> : null}</Panel>;
  }

  const model = findModel(models, run.modelId);
  // Cheap, pure and read off the run this render is already drawing — never a
  // second copy of the run's state that could disagree with the badge above it.
  const deliveryNote = chatDeliveryNote(run);

  /*
   * WHICH KIND OF `awaiting_input` THIS IS, WHICH IS THE ONLY REASON THE NOTICE
   * BELOW IS CONDITIONAL.
   *
   * `awaiting_input` is also what `reconcileOnBoot` sets for any run whose
   * builder subprocess died with the dashboard, and that run has no mockups and
   * no question these cards can answer — its two moves really are resume and
   * cancel, which is what `AwaitingInputNotice` says. Only a DESIGN park may
   * replace it: there, the notice's "this dashboard has no channel to answer a
   * mid-run question" is false, and the cards are the channel.
   */
  const lockPhase =
    run.designLock === null ? null : designLockPhase(run.status, run.designLock);
  const lockIsBlocking = lockPhase === "pending" || lockPhase === "closing";

  return (
    <div
      className={cx(
        // `AppShell` gives this route a full-bleed `main` with no cap and no
        // padding (see `isFullBleed`), so there is nothing left to cancel and
        // nothing to subtract: fill the parent.
        "relative h-full overflow-hidden border-y border-line bg-canvas",
      )}
    >
      <OrchestrationCanvas
        graph={graph}
        ready={graphReady}
        selectedId={selectedId}
        onSelect={setSelectedId}
        showAmbient={showAmbient}
        onShowAmbient={setShowAmbient}
        /*
         * `DetailSheet`'s own width — `w-[min(420px,100%)]` — and only while it is
         * open. The canvas clamps this against its measured pane, because on a
         * viewport narrower than 420px the sheet IS the pane and there is nowhere
         * to pan a card to.
         */
        // An empty graph on a live run and on a dead one are the same value and
        // different facts; only this page knows which.
        runIsActive={!isTerminalStatus(run.status)}
        planPanelOpen={planPanelOpen}
        onPlanPanel={setPlanPanelOpen}
        /*
         * THE ~80 MINUTES BEFORE ANY NODE EXISTS. Measured on the run that
         * passed: the spec phase took 79.5 minutes of a 105-minute run, and for
         * all of it the canvas was a static box that looked the same whether the
         * run was working or dead. The trace is already streaming by then, so
         * the newest line is a liveness signal that costs no new plumbing.
         *
         * `trace` is capped and append-only, so the last entry is the newest.
         * `null` when nothing has arrived — the canvas renders nothing rather
         * than an empty row implying a message that did not come.
         */
        /*
         * `specStages` IS NO LONGER PASSED — 2026-08-04, and the reason is a
         * defect rather than a tidy-up.
         *
         * It was `specPipelineFrom(trace, run.phase, run.ticketText, …)`, and
         * `trace` is the LIVE SSE sink: `use-run-stream.ts` never opens a socket
         * for a terminal run, so the pre-build lane was empty on every run opened
         * after it finished — which is most of the runs anyone looks at. The
         * derivation also returned `[]` for every phase past `spec`, so the lane
         * deleted itself at the build boundary.
         *
         * The canvas now reads `GraphState.stages`, folded by `foldGraph` from the
         * same `phase` and `log` rows this page's `trace` is built from — but on
         * the REST snapshot as well as the socket, which is what makes it survive a
         * reload. Nothing has to be threaded through this component any more.
         */
        latestActivity={
          trace.length === 0
            ? null
            : {
                text: trace[trace.length - 1]?.text ?? "",
                atMs: trace[trace.length - 1]?.atMs ?? Date.now(),
              }
        }
        rightInset={selected === null ? 0 : 420}
        hud={
          /*
           * THE DOCK IS CAPPED IN BOTH AXES, and both caps were added after
           * looking at it.
           *
           * Width is the same 360px the canvas's fit reserves on the left, so the
           * two cannot disagree about how much room this takes. Height is 62% of
           * the canvas with its own scroll: a run parked on a design choice has a
           * panel taller than the pane, and unconstrained it covered the graph
           * completely — which is the complaint this redesign exists to answer,
           * reintroduced by the fix for it.
           *
           * Below 900px there is no room to flank anything, so the fit reserves
           * the TOP instead and this dock overlaps the graph. That is the honest
           * outcome of a 375px canvas rather than a defect: the reader pans, and
           * every card is still reachable from the keyboard without touching the
           * pane at all.
           *
           * A `{/* … *\/}` COMMENT CANNOT GO HERE. `hud={…}` is an expression
           * position, not a JSX children position, so a JSX comment there parses
           * as an object literal followed by an element with no operator between
           * them: "Expected '</', got 'ident'". It cost a whole screenshot pass.
           */
          /*
           * `max-h-[40%]`/`62%` ARE INERT HERE AND HAVE ALWAYS BEEN — MEASURED
           * 2026-08-02, and the comment above is corrected rather than deleted
           * because the number in it was load-bearing in an argument.
           *
           * `OrchestrationCanvas` mounts this in `absolute left-3 top-3` with no
           * height and no `bottom`, so the containing block's height is
           * INDEFINITE and a percentage `max-height` resolves to `none`. Measured
           * in the browser on the plan fixture at 900px: this element's height
           * came back 1198.8px inside a 900px viewport, with `scrollHeight ===
           * clientHeight` — so it neither capped nor scrolled, and the document
           * did not scroll either. Anything past the fold was unreachable.
           *
           * WHAT ACTUALLY KEPT THE DESIGN LOCK OFF THE GRAPH is the PIXEL cap on
           * its own wrapper below (`max-h-[200px]`/`380px`), which resolves
           * against nothing. Every panel docked here needs one of its own; the
           * plan panel uses a `vh` cap for the same reason.
           *
           * The classes are left as they are: they cost nothing, and removing
           * them changes the box for every other run in a way this pass did not
           * measure.
           */
          /*
           * 360 -> 400 ON 2026-08-04, WITH `HUD_WIDTH` IN THE CANVAS, and the two
           * numbers have to move together: the canvas reserves this much of its
           * pane on the left when it fits the graph, so a dock wider than the
           * reservation covers cards the fit believed were visible.
           */
          <div className="pointer-events-auto flex max-h-[40%] w-[min(400px,calc(100vw-32px))] flex-col gap-2 overflow-y-auto min-[900px]:max-h-[62%]">
            {/*
             * THE SWAP THE OWNER ASKED FOR, AND EXACTLY HOW FAR IT GOES.
             *
             * "When you click on the plan node a menu on the left side of the
             * screen comes up … replacing this." What it replaces is the run chip
             * and the chat button. It does NOT replace the notices,
             * `PlanDialoguePanel` or `DesignLockPanel` below, and that limit is
             * load-bearing rather than cautious: those two are the ANSWER surfaces
             * for a run that is stopped waiting on him. A Plan panel that covered a
             * plan park would mean clicking a card on the canvas costs the owner
             * the only control that can un-stick his run. The note further down
             * this file records what it cost the last time a generic notice sat
             * where an answer surface belonged.
             *
             * `preBuildMembers` IS EMPTY FOR EVERY RUN WITH NO LANE — most of them,
             * since `foldGraph` only projects stages from `phase` and `log` rows.
             * The Plan card is not drawn for those runs either (`layout.ts`), so
             * the panel is unreachable and the fallback is the chip.
             */}
            {planPanelOpen && preBuildMembers.length > 0 ? (
              <PreBuildPanel
                members={preBuildMembers}
                runIsActive={!isTerminalStatus(run.status)}
                ticketLabel={ticketLabel(run.ticketTitle)}
                ticketTooltip={ticketTooltip(run.ticketTitle, run.ticketText)}
                onClose={closePlanPanel}
              />
            ) : (
              <>
                <RunHud
                  run={run}
                  model={model}
                  nowMs={nowMs}
                  busy={busy}
                  onCancel={onCancel}
                  onResume={onResume}
                  onOpenDetail={openRunSheet}
                />

                {/*
             * THE CHAT ENTRY POINT. Two things about it are load-bearing.
             *
             * IT IS DIRECTLY UNDER THE CHIP, ABOVE EVERY NOTICE. This dock is
             * `max-h-[40%]`/`62%` with its own scroll, and a parked run stacks a
             * notice AND `DesignLockPanel` — five mockup cards — underneath. Any
             * control placed after those is off the bottom of the dock in exactly
             * the state where typing at the run matters most, which is how "i dont
             * see any chat anywhere" happens a second time.
             *
             * IT IS NOT CONDITIONAL ON STATUS, unlike `RunHud`'s Cancel and Resume
             * two lines above. Those are refused by the server in the states they
             * are hidden in; this one is not. On a terminal run the composer
             * renders itself disabled with the reason on it (`runIsOver`), which is
             * a reader who learns what the chat is over a reader who never finds
             * it.
             *
             * IT STILL CARRIES NO UNREAD COUNT, and the reason has changed rather
             * than gone. The transcript IS fetched now — on mount, and on a timer
             * while a plan park is open — so "we do not have the rows" is no
             * longer the argument. What is missing is the other half: nothing
             * records which rows this reader has seen, so any number here would
             * be a count of messages, not of unread ones, and it would sit at a
             * permanent non-zero on every run that ever spoke.
             */}
                <Button
                  onClick={openChat}
                  className="w-full justify-between"
                  title="Send this run an instruction or a reference image. Whether it is delivered live or queued for the next prompt depends on the run's state; the panel says which, and every message carries its own delivery state."
                >
                  chat
                  <span className="font-normal text-ink-faint">instruct · attach</span>
                </Button>
              </>
            )}

            {actionError !== null && (
              <Notice tone="fail" title="That action did not go through">
                <p>{actionError}</p>
              </Notice>
            )}

            {run.status === "rate_limited" && (
              <RateLimitNotice run={run} onResume={onResume} busy={busy} />
            )}
            {/*
             * THE THIRD KIND OF `awaiting_input`, AND IT IS SUPPRESSED FOR THE
             * SAME REASON THE DESIGN PARK IS.
             *
             * `AwaitingInputNotice` says the two moves are resume and cancel,
             * which is true of a run whose builder died with the server and false
             * of a plan park: there the moves are ANSWER, say "you decide", or
             * ask what it means — and a bodyless resume would close the dialogue
             * with every open question recorded as an assumption. Leaving a
             * generic "answer it first, then resume" notice directly above the
             * panel that IS the answer surface is how an owner ends up resuming
             * past his own questions.
             *
             * IT IS GATED ON THE PANEL ACTUALLY RENDERING, NOT ON THE RUN BEING
             * PLAN-PARKED, and those are different conditions on two real paths.
             * The transcript arrives over a fetch, so on first paint there is no
             * dialogue yet; and the orchestrator documents a window of its own —
             * "Parking first leaves it parked with the questions missing from the
             * chat, which the timer resolves on its own by expiring" — where
             * `planDialogue` is null for the whole park. Gated on `planParked`
             * alone, both of those show a run stopped on `awaiting input` with
             * nothing on screen saying what it wants. Here the generic notice
             * stands in, and its Resume really is the right move: on a plan park
             * that closes the dialogue and records the assumptions (see the
             * tooltip in `run-hud.tsx`).
             */}
            {run.status === "awaiting_input" &&
              lockPhase !== "pending" &&
              !planAnswerable && (
              <AwaitingInputNotice onResume={onResume} onCancel={onCancel} busy={busy} />
            )}

            {planDialogue !== null && (
              <div
                className={cx(
                  "overflow-y-auto rounded",
                  /*
                   * THE SAME TWO WEIGHTS `DesignLockPanel` GETS, and the same
                   * measured cap: a decision the run is STOPPED on gets room and a
                   * ring, the settled record of one gets less and dims. The dock
                   * is `max-h-[40%]`/`62%` with its own scroll, so an open
                   * dialogue that grows past the cap scrolls inside this box and
                   * the graph stays visible behind it.
                   */
                  /*
                   * A `vh` CAP, NOT A PERCENTAGE — see the block on the dock
                   * above, where the percentage was measured inert. 62vh leaves
                   * the run chip, the chat button and the canvas controls at the
                   * bottom-left clear at 900px, and it is the panel that
                   * scrolls rather than the dock.
                   *
                   * An open park gets more room than a settled record for the
                   * same reason `DesignLockPanel` does: a decision the run is
                   * stopped on is the only thing on the screen that matters.
                   */
                  planParked
                    ? "max-h-[62vh] ring-2 ring-warn/40"
                    : "max-h-[200px] opacity-90 min-[900px]:max-h-[300px]",
                )}
              >
                <PlanDialoguePanel
                  dialogue={planDialogue}
                  nowMs={nowMs}
                  onSend={onSendPlanReply}
                />
              </div>
            )}

            {lockPhase !== null && (
              <div
                className={cx(
                  "overflow-y-auto rounded",
                  /*
                   * CONSTRAINED, AND MEASURED BEFORE IT WAS.
                   *
                   * `DesignLockPanel` renders five mockup cards at full size. Docked
                   * unconstrained it came out 880px wide and taller than the pane,
                   * covering the entire graph on the one run this redesign was built
                   * against — the exact complaint the redesign exists to answer,
                   * reintroduced by the fix for it. It keeps its own internal scroll
                   * instead: every element the four `design-lock.browser.spec.ts`
                   * shapes assert on is still rendered and still visible (Playwright's
                   * visibility is a non-empty box, not in-viewport), and the reader
                   * gets a panel rather than a takeover.
                   *
                   * A decision the run is STOPPED on gets more room and a ring; the
                   * same panel as a record gets less. Same panel, two weights.
                   */
                  lockIsBlocking
                    ? /*
                       * A `vh` CAP ON THE BLOCKING WEIGHT TOO, ADDED 2026-08-03 —
                       * and for the same measured reason the plan panel has one.
                       * A canvassed park stacks three directions of full-aspect
                       * stills in this 360px column; uncapped, that panel is
                       * thousands of pixels tall and simply runs off the bottom of
                       * the viewport, because the percentage caps on the dock
                       * itself resolve to `none` against an indefinite height (see
                       * the block above). The comparison layer is where the deck is
                       * meant to be read; this keeps the dock's copy of it a panel
                       * rather than a takeover.
                       */
                      "max-h-[62vh] ring-2 ring-accent/50"
                    /*
                     * RAISED 132/200 → 200/380 ON 2026-07-30, because the cap was
                     * doing two jobs and only one of them was wanted.
                     *
                     * It exists so a SETTLED record cannot cover the graph, which is
                     * right. But 200px also clipped `ui-designer`'s 480-character
                     * reason mid-word, and clipping is what made it read as a wall of
                     * text rather than a paragraph. The reason is now clamped to three
                     * lines with its own unfold (`ReasonBlock`), so the panel is short
                     * BY DEFAULT and this cap only has to be big enough for the
                     * unfolded state to be readable instead of a 200px peephole.
                     *
                     * Still capped, still `overflow-y-auto`: the graph stays visible.
                     */
                    : "max-h-[200px] opacity-90 min-[900px]:max-h-[380px]",
                )}
              >
                <DesignLockPanel
                  run={run}
                  busy={busy}
                  nowMs={nowMs}
                  trace={trace}
                  onChoose={onChooseMockup}
                  onChooseDirection={onChooseDirection}
                  onSendRequest={onSendDesignRequest}
                  onRefresh={refresh}
                />
              </div>
            )}
          </div>
        }
      />

      {/*
       * NO `chat` PROP ANY MORE — see this file's header and `DetailSheet`'s. The
       * composer was gated here on `selected.parent === null`; it is now a tab on
       * the run sheet, which is the only reason a run's first 80 minutes have a
       * chat at all. Nothing about a NODE decides anything about the chat now.
       */}
      {selected !== null && <DetailSheet node={selected} onClose={clearSelection} />}

      {runSheetOpen && (
        <RunSheet
          run={run}
          model={model}
          graph={graph}
          trace={trace}
          stream={stream}
          onReconnect={reconnect}
          selectedId={selectedId}
          onSelect={setSelectedId}
          showAmbient={showAmbient}
          onClose={closeRunSheet}
          tab={runSheetTab}
          onTab={changeRunSheetTab}
          /*
           * THE CHAT, BUILT HERE AND HANDED OVER, with the one state-specific
           * sentence the component cannot write for itself above it.
           *
           * `chatDeliveryNote` (top of this file) returns null for every state
           * `OrchestratorChat`'s own copy already describes accurately, so this is
           * usually just the composer. When it does return a sentence it is because
           * the component would otherwise leave the reader to assume the message is
           * going somewhere — the spec phase being the whole reason this item was
           * raised.
           */
          chat={
            <>
              {deliveryNote !== null && (
                <p className="border-b border-line bg-canvas/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink-dim">
                  {deliveryNote}
                </p>
              )}
              <OrchestratorChat
                messages={messages}
                runIsOver={isTerminalStatus(run.status)}
                onSend={onSendMessage}
              />
            </>
          }
        />
      )}
    </div>
  );
}
