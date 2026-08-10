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
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Explain } from "@/components/explain";
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
import { RAIL_LABEL, RunRail, type RailPanelId } from "@/components/canvas/rail";
import { RunHud } from "@/components/canvas/run-hud";
import {
  ActivityPanel,
  DetailSheet,
  FilesPanel,
  OverviewPanel,
  ResultPanel,
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
 * TWO FIELDS SINCE 2026-08-05, AND THE SPLIT IS THE POINT. `text` is the one line
 * that changes what the reader does next — whether it is worth typing at all —
 * and is on screen. `detail` is the mechanism behind it and lives behind the
 * `Explain` glyph at the call site: a reader who never opens it has been told
 * nothing false, and a reader who wants to know why gets the whole reason. The
 * three states used to spend 137 words on this paragraph permanently; they now
 * spend 41 on screen and keep every fact.
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
interface DeliveryNote {
  /** On screen, above the composer. One line, and it decides whether to type. */
  readonly text: string;
  /** Behind the glyph. Why the line above is true. */
  readonly detail: string;
  /** The glyph's accessible name: "Explain: <about>". */
  readonly about: string;
}

function chatDeliveryNote(run: RunDetail): DeliveryNote | null {
  if (isTerminalStatus(run.status)) return null;
  if (run.status === "queued") {
    return {
      // "the queue is serial" MOVED INTO THE DETAIL AND LOST THE WORD: a reader
      // who has not been told this app runs one build at a time cannot use
      // "serial", and what he can use is "waiting for the run ahead of it".
      text: "This run has not started yet, so anything you send is stored, not delivered.",
      detail:
        "It is waiting for the run ahead of it. What you send is added to the " +
        "instructions the first design or build agent gets, which is the earliest " +
        "anything you say can change what gets built.",
      about: "messages on a run that has not started",
    };
  }
  switch (run.phase) {
    case "spec":
      return {
        /*
         * "THE TESTS FOR THIS TICKET ARE BEING WRITTEN" — 2026-08-05, replacing
         * "The acceptance suite is being written". `suite` is on the owner's
         * banned list; the fact the sentence exists to carry is that the run is
         * in the phase BEFORE any agent is building, which is why a message
         * cannot be delivered live. The stage card for this phase already reads
         * "Writing the tests from your ticket, before any code exists"
         * (`server/src/graph.ts`), so this is the same phase named the same way
         * in both places.
         *
         * "no build session to push into" WENT WITH THE SAME PASS. It named the
         * `#liveInputs` channel in the vocabulary of the code that owns it; what
         * a reader can act on is that nothing is building yet, which is the
         * first line of the detail.
         */
        text: "The tests are still being written, so a message is stored rather than delivered.",
        detail:
          "No agent is building yet. What you send is added to the instructions the " +
          "first design or build agent gets, which is the earliest anything you say " +
          "can change what gets built.",
        about: "messages while the tests are being written",
      };
    case "gate":
    case "judge":
      return {
        /*
         * "PAST THE BUILD AND INTO TESTING" RATHER THAN "THE BUILD SEGMENTS ARE
         * OVER", and the wording is careful for a reason the shorter version got
         * wrong: the gate's FIX ROUNDS still change code, so "the building is
         * over" would be false. The run is past the build SEGMENTS — the ones
         * that read a stored message — which is what makes the warning true.
         *
         * "the gate's fix rounds and the judge" IS THE JARGON THIS SENTENCE WAS
         * CARRYING. Both are seat names from the orchestrator; on screen they are
         * "the test-fixing rounds" and "the final review", which is what they do.
         */
        text: "This run is past the build, so a message now will most likely never be read.",
        detail:
          "Only the design and build agents are given stored messages. The " +
          "test-fixing rounds and the final review write their own instructions and " +
          "read none.",
        about: "messages after the build",
      };
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
  /**
   * WHICH RAIL PANEL THE READER HAS CHOSEN — `undefined` until he chooses one.
   *
   * THREE VALUES, NOT TWO, and the third is what makes the auto-open below a
   * derivation rather than an effect: `undefined` means "nobody has picked yet",
   * `null` means "he closed it", and an id means he opened that one. Without the
   * distinction, a run whose dialogue arrives over a fetch could not be told from
   * a run whose panel the reader deliberately shut a moment earlier.
   */
  const [chosenPanel, setChosenPanel] = useState<RailPanelId | null | undefined>(
    undefined,
  );

  /**
   * HAS THE CHAT EVER BEEN OPENED — the flag that keeps it mounted afterwards.
   *
   * The chat has to stay mounted once it is open, because the composer's draft
   * lives in `OrchestratorChat`'s own state and unmounting throws a half-typed
   * instruction away. Mounting it from the START would do the same job and costs
   * something real that was measured rather than guessed: the transcript's own
   * rows are in the DOM, `display: none` or not, so a `getByText` for a question
   * the plan panel is showing matched THREE elements — the panel's card and the
   * two chat rows the seat posted it in. Locators match hidden nodes; only
   * assertions filter them.
   *
   * Deferring the mount to the first open costs nothing a reader can notice — a
   * draft cannot exist before the composer does — and a reader who never opens the
   * chat gets no second copy of the transcript on the page at all.
   */
  const [chatMounted, setChatMounted] = useState(false);

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

  /**
   * IS THERE A QUESTION SURFACE AT ALL, and is the run STOPPED on one right now.
   *
   * Derived above the early returns because the auto-open effect below is a hook.
   * `hasLockRecord` is deliberately "there is a design lock of any phase", not
   * "there is a pending one": a settled lock is the RECORD of a choice the owner
   * made, and this file's header has always said it stays on screen without a
   * click in all four of the shapes `RunDetail.designLock` arrives in.
   */
  const hasLockRecord = run !== undefined && run.designLock !== null;
  const hasQuestions = planDialogue !== null || hasLockRecord;

  /**
   * WHICH PANEL IS ACTUALLY OPEN — DERIVED, never set from an effect.
   *
   * QUESTIONS OPENS BY ITSELF WHEN THE RUN IS WAITING ON ONE, AND THAT IS A HARD
   * REQUIREMENT. The reason is already written into this file, at the pre-build
   * panel below: "A Plan panel that covered a plan park would mean clicking a card
   * on the canvas costs the owner the only control that can un-stick his run."
   * Behind an icon with no auto-open, that control is one click away from a reader
   * who does not know the icon exists — the same failure by a quieter mechanism.
   *
   * IT IS A DERIVATION AND NOT AN EFFECT, which is worth the extra state value:
   * the dialogue arrives over a FETCH, so an effect would have to fire on the
   * second render and would then be a `setState` inside an effect — a cascading
   * render the lint rule refuses, and a race with the reader's own first click.
   * Reading it during render means the panel is correct on the first paint after
   * the transcript lands, and the moment the reader picks anything his choice wins
   * for the rest of the session.
   *
   * OVERVIEW IS THE FALLBACK, not `null`: a run view that opens as a bare canvas
   * does not say which run it is, and the run chip's status was the one thing that
   * used to be visible without asking. Closing it is one click, and the status
   * survives on the Overview icon as a dot either way.
   *
   * IT ALSO OPENS FOR A SETTLED DESIGN LOCK, and that is a DEVIATION from the rail
   * spec, made because the code says otherwise and the code is tested. The spec
   * auto-opens only for a PENDING lock; this file's header records that the lock
   * "stays docked in its settled phases too … `design-lock.browser.spec.ts`
   * asserts the panel is visible without a click in all four of the shapes
   * `RunDetail.designLock` arrives in". A pending-only rule would silently delete
   * that property for three of the four.
   */
  const openPanel: RailPanelId | null =
    chosenPanel !== undefined
      ? chosenPanel
      : hasQuestions && (planAnswerable || hasLockRecord)
        ? "questions"
        : "overview";

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
   * FETCH WHEN THE CHAT PANEL IS BROUGHT TO THE FRONT, rather than on mount or on
   * selection. REWRITTEN 2026-07-30 with the chat's move off the node, and again
   * 2026-08-04 with the rail; both times because the reason it used to give
   * stopped being true.
   *
   * The first version said "fetch on select … the chat only exists inside the
   * detail sheet" and hung `loadMessages()` off node selection. The second listed
   * three tab callbacks. There is now ONE entry point — this one — and it fetches
   * only for the chat: opening Files or Result puts no transcript on screen, so
   * pulling one there would be a request for nobody. Together with `onSendMessage`
   * above and the mount fetch below, that is every moment the transcript is both
   * visible and possibly stale, which is what keeps `deliveredAt` current without
   * a timer.
   */
  const openRailPanel = useCallback(
    (next: RailPanelId | null): void => {
      setChosenPanel(next);
      if (next === "chat") {
        setChatMounted(true);
        loadMessages();
      }
    },
    [loadMessages],
  );

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

  /*
   * THE FLOATING STACK — the surfaces that may NOT go behind an icon.
   *
   * WHAT THIS WAS. Until 2026-08-04 the run view carried a permanent dock down the
   * left: the run chip, a `chat` button, any error, the rate-limit and
   * awaiting-input notices, the plan dialogue and the design lock, stacked and
   * always on screen. The owner's verdict was "but this looks terrible … I suggest
   * designing some icons … that then will sit on the left side of the canva and
   * when I click them they expand into different things." So the chip, the chat
   * button, the dialogue and the lock all moved behind the rail's icons.
   *
   * THESE THREE DID NOT, AND THE LINE IS NOT ARBITRARY: a notice is the run saying
   * it is STOPPED and needs the reader NOW. A notice behind an icon is a notice
   * that does not fire. They float over the canvas instead, which is why the fit
   * still reserves room for them (`orchestration-canvas.tsx`, `NOTICE_RESERVE`).
   *
   * `PreBuildPanel` FLOATS TOO, and that is where the owner put it: "when you
   * click on the plan node a menu on the left side of the screen comes up". It is
   * not a rail entry because it is not a run-level surface — it is the thing you
   * clicked, and it appears and disappears with the click. What it USED to do was
   * swap itself in where `RunHud` was; that swap is gone with `RunHud`, so it is
   * now simply a panel that opens rather than one surface standing in for another.
   *
   * `max-h-[88vh]` — MEASURED 2026-08-04, AND IT MOVED HERE WITH THE STACK RATHER
   * THAN BEING DELETED WITH THE DOCK. On the plan fixture with the pre-build panel
   * open the old dock came back 1198px tall with `scrollHeight === clientHeight`,
   * and the plan park's own send button sat 300px below the fold of a page that is
   * `overflow-hidden`: nothing scrolled, because the percentage caps that were
   * there before it resolved to `none` against an indefinite height. The control
   * was not hidden, it was gone. A `vh` cap is the one that binds, and it still
   * has to bind here for the same reason — this stack is still absolutely
   * positioned inside a pane whose height is indefinite to a percentage. The
   * dialogue panels it used to cap are no longer in it; the pre-build panel and a
   * stack of notices still are.
   */
  /**
   * The pre-build panel is genuinely on screen — the flag AND something to show.
   *
   * Read twice: once to render it, and once by the page heading below, which has
   * to stand down while this panel is up. `PreBuildPanel` renders an `h1` of its
   * own carrying the same ticket label, and two `h1`s on one document is a defect
   * `prebuild-lane.browser.spec.ts` measures directly.
   */
  const preBuildOpen = planPanelOpen && preBuildMembers.length > 0;

  const floating: ReactNode[] = [];
  if (preBuildOpen) {
    /*
     * `preBuildMembers` IS EMPTY FOR EVERY RUN WITH NO LANE — most of them, since
     * `foldGraph` only projects stages from `phase` and `log` rows. The Plan card
     * is not drawn for those runs either (`layout.ts`), so the panel is
     * unreachable and nothing renders.
     */
    floating.push(
      <PreBuildPanel
        key="prebuild"
        members={preBuildMembers}
        runIsActive={!isTerminalStatus(run.status)}
        ticketLabel={ticketLabel(run.ticketTitle)}
        ticketTooltip={ticketTooltip(run.ticketTitle, run.ticketText)}
        onClose={closePlanPanel}
      />,
    );
  }
  if (actionError !== null) {
    floating.push(
      /*
       * IT CARRIES CANCEL WHILE THE RUN CAN STILL BE CANCELLED — 2026-08-09.
       *
       * This notice suppresses the run chip (see `hudMounted` below) and used to
       * be a bare `<p>`, so a failed action left the screen with no way to stop
       * the run until the reader guessed that reopening a rail panel would bring
       * one back. It also does not clear on its own: `setActionError(null)` runs
       * only at the TOP of the next action, so the state persists until the
       * reader attempts something else — and the thing they most likely want to
       * attempt is exactly this.
       *
       * GATED ON THE RUN BEING NON-TERMINAL, because `actionError` is reachable
       * on a finished run too (a failed retry, say) and offering to cancel
       * something that has already stopped is a button that can only produce a
       * second error.
       */
      <Notice
        key="action-error"
        tone="fail"
        title="That action did not go through"
        actions={
          isTerminalStatus(run.status) ? undefined : (
            <Button variant="danger" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )
        }
      >
        <p>{actionError}</p>
      </Notice>,
    );
  }
  if (run.status === "rate_limited") {
    floating.push(
      <RateLimitNotice
        key="rate-limit"
        run={run}
        onResume={onResume}
        onCancel={onCancel}
        busy={busy}
      />,
    );
  }
  /*
   * THE THIRD KIND OF `awaiting_input`, AND IT IS SUPPRESSED FOR THE SAME REASON
   * THE DESIGN PARK IS.
   *
   * `AwaitingInputNotice` says the two moves are resume and cancel, which is true
   * of a run whose builder died with the server and false of a plan park: there
   * the moves are ANSWER, say "you decide", or ask what it means — and a bodyless
   * resume would close the dialogue with every open question recorded as an
   * assumption. Leaving a generic "answer it first, then resume" notice directly
   * above the surface that IS the answer is how an owner ends up resuming past his
   * own questions.
   *
   * IT IS GATED ON THE DIALOGUE ACTUALLY EXISTING, NOT ON THE RUN BEING
   * PLAN-PARKED, and those are different conditions on two real paths. The
   * transcript arrives over a fetch, so on first paint there is no dialogue yet;
   * and the orchestrator documents a window of its own — "Parking first leaves it
   * parked with the questions missing from the chat, which the timer resolves on
   * its own by expiring" — where `planDialogue` is null for the whole park. Gated
   * on `planParked` alone, both of those show a run stopped on `awaiting input`
   * with nothing on screen saying what it wants. Here the generic notice stands
   * in, and its Resume really is the right move.
   *
   * IT IS STILL A FLOATING NOTICE AND NOT A PANEL, and the rail made that more
   * important rather than less: this is precisely the state where the answer
   * surface has NOT rendered, so an icon the reader has to know about would be the
   * only thing between a stopped run and a reader who cannot tell why.
   */
  if (
    run.status === "awaiting_input" &&
    lockPhase !== "pending" &&
    !planAnswerable
  ) {
    floating.push(
      <AwaitingInputNotice
        key="awaiting-input"
        onResume={onResume}
        onCancel={onCancel}
        busy={busy}
      />,
    );
  }

  /*
   * `undefined`, NEVER AN EMPTY FRAGMENT. The canvas derives "is anything floating
   * over the graph" from `notices !== undefined` and reserves 428px of its fit for
   * it; a fragment that renders nothing would take that reservation on every run
   * and push the graph permanently right of centre.
   */
  const notices =
    floating.length === 0 ? undefined : (
      <div className="pointer-events-auto flex max-h-[88vh] w-full flex-col gap-2 overflow-y-auto">
        {floating}
      </div>
    );

  /*
   * THE RUN CHIP IS BACK, AND ONLY WHERE NOTHING ELSE IS SAYING WHO THIS IS —
   * 2026-08-09.
   *
   * WHAT WAS MEASURED. `RunHud` had NO IMPORTER: the icon rail took over its job
   * and `sheet.tsx` records the handover in as many words ("IT IS WHERE THE RUN
   * CHIP WENT"). That is right while a panel is OPEN. With every panel SHUT the
   * screen carried no run identity at all — no title, no status, no verdict, no
   * clock and, worse than any of those, no CANCEL. And shutting the panel is not
   * an eccentric thing to do: it is the only way to get the canvas above 0.51
   * zoom, so stopping a run that is going wrong required reopening a 400px panel
   * first. A control that stops a run does not belong behind two clicks.
   *
   * SO IT MOUNTS ON THE COMPLEMENT OF THE PANEL, WHICH IS WHY NOTHING IS SAID
   * TWICE. `OverviewPanel` carries the same five facts and the same two actions;
   * `openPanel === null` is exactly "that panel is not available", so the two can
   * never both be on screen. The rail's own status dot stays either way.
   *
   * `notices === undefined` IS THE SECOND HALF AND IT IS NOT BELT AND BRACES.
   * The floating stack — the rate-limit notice, the awaiting-input notice, the
   * plan dialogue, the design lock, the pre-build panel — is pinned to the
   * canvas's top-left at `left-3` (`orchestration-canvas.tsx`, "THE FLOATING
   * STACK. Top-left, over the flow"), which is where this chip goes. They do not
   * stack — both are absolutely positioned in the same corner of the same pane,
   * so mounting both puts one card on top of the other. Two 360px cards in one
   * corner is not a layout, and the chip is the one to yield.
   *
   * "AND NOTHING IT OFFERED IS LOST" WAS WRITTEN HERE AND IT WAS FALSE — the
   * correction, 2026-08-09, because the sentence it replaces named a fact about
   * a component that contradicted it. It read "`AwaitingInputNotice` and
   * `RateLimitNotice` carry their own Cancel and Resume". `AwaitingInputNotice`
   * did. `RateLimitNotice` took `{ run, onResume, busy }` and rendered ONE
   * button, and the action-error branch below was a bare `<p>`, so in two of the
   * four states that suppress this chip the screen carried NO CANCEL — the exact
   * defect the paragraph above says the chip exists to close, reappearing in the
   * states where the run is stopped and the reader most wants to stop it.
   *
   * SO THE CLAIM IS NOW TRUE BY CONSTRUCTION RATHER THAN BY ASSERTION. Cancel
   * was added to `RateLimitNotice` and to the action-error notice (non-terminal
   * runs only), so three of the four suppressing surfaces carry it:
   *
   *   `AwaitingInputNotice`  Resume + Cancel        (unchanged)
   *   `RateLimitNotice`      Resume + Cancel        (added 2026-08-09)
   *   action-error notice    Cancel, if non-terminal (added 2026-08-09)
   *   `PreBuildPanel`        NEITHER — see below
   *
   * `rail.browser.spec.ts` measures the rate-limited arm directly, with a notice
   * up and the panel shut, because that is the one of the three a reader arrives
   * in without asking.
   *
   * THE PRE-BUILD PANEL IS THE DELIBERATE REMAINDER. It is the only one of the
   * four the reader OPENS — it needs a click on the Plan card — and it closes on
   * its own header button or on Escape (`prebuild-panel.tsx`), which restores the
   * chip in one click from a control that is on screen and labelled. That is not
   * the two-click hunt the chip exists to remove: the way out is visible in the
   * surface the reader just opened. Carried forward as an owner decision rather
   * than papered over with a Cancel on a panel about planning.
   */
  const hudMounted = openPanel === null && notices === undefined;

  /*
   * THE QUESTIONS PANEL — the plan dialogue and the design lock, together, because
   * they are the same kind of thing: something the run stopped to ask.
   *
   * THE MEASURED HEIGHT CAPS ARE GONE FROM BOTH, and their removal is the point of
   * the move rather than a regression. `max-h-[62vh]`/`max-h-[200px]` existed
   * because these panels were docked OVER the graph: "docked unconstrained it came
   * out 880px wide and taller than the pane, covering the entire graph on the one
   * run this redesign was built against". Inside the rail's panel there is nothing
   * to cover — the panel is a layout sibling of the canvas with its own
   * `flex-1 min-h-0 overflow-y-auto` scroll — so a tall dialogue scrolls in its
   * own column and the graph is never touched. The RINGS survive, because they
   * were never about size: a decision the run is STOPPED on gets one and the
   * settled record of one does not.
   */
  const questionsBody = (
    <div className="space-y-3 p-3">
      {planDialogue !== null && (
        <div className={cx("rounded", planParked && "ring-2 ring-warn/40")}>
          <PlanDialoguePanel
            dialogue={planDialogue}
            nowMs={nowMs}
            onSend={onSendPlanReply}
          />
        </div>
      )}

      {lockPhase !== null && (
        <div className={cx("rounded", lockIsBlocking && "ring-2 ring-accent/50")}>
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
  );

  return (
    <div
      className={cx(
        // `AppShell` gives this route a full-bleed `main` with no cap and no
        // padding (see `isFullBleed`), so there is nothing left to cancel and
        // nothing to subtract: fill the parent.
        //
        // A FLEX ROW NOW: rail, then panel, then canvas. The panel is a SIBLING of
        // the canvas rather than something over it, which is what makes opening it
        // shrink the pane instead of hiding nodes — the canvas's own
        // `ResizeObserver` then re-fits the graph to the space that is left.
        "relative flex h-full overflow-hidden border-y border-line bg-canvas",
      )}
    >
      {/*
       * THE PAGE'S ONE HEADING, AND IT DOES NOT COME AND GO WITH A PANEL.
       *
       * `RunHud`'s `h1` used to be the run view's only top-level heading, and it
       * lived inside a dock that a click could replace. A document whose title
       * disappears when you open the file browser is a document with no title
       * some of the time. It is visually hidden because the name is already on
       * screen twice — in the Overview panel and on the browser tab — and a third
       * copy in display type is what the owner asked to be cut.
       *
       * IT STANDS DOWN FOR THE PRE-BUILD PANEL, which renders an `h1` of its own
       * with the same label — `RunHud`'s, inherited when that panel took over the
       * chip's place in the dock. Two `h1`s is worse than one that moves, and the
       * label is identical either way, so the document's title does not change.
       *
       * AND IT STANDS DOWN FOR THE CHIP ITSELF — 2026-08-09, now that `RunHud` is
       * mounted again with the rail's panel shut AND nothing floating over the
       * canvas. Same argument, same label, same `ticketLabel(run.ticketTitle)`:
       * whichever of the three is on screen, the document has exactly one
       * top-level heading and it says the same words. `hudMounted` already
       * excludes the pre-build panel — it is one of the floating entries — so the
       * two can never both claim the heading.
       */}
      {!preBuildOpen && !hudMounted && (
        <h1 className="sr-only">{ticketLabel(run.ticketTitle)}</h1>
      )}

      <RunRail
        open={openPanel}
        onOpen={openRailPanel}
        /*
         * THE BUTTON RENDERS WHEN THERE IS SOMETHING TO SHOW; the 44px slot is
         * reserved either way so nothing below it moves as a run progresses.
         */
        showQuestions={hasQuestions}
        /*
         * THE RUN'S STATUS, AS A DOT ON THE OVERVIEW ICON. This is the one piece of
         * the old always-visible run chip that survives as chrome, so a rail with
         * every panel closed still says how the run went.
         */
        statusDot={
          isTerminalStatus(run.status)
            ? run.status === "passed"
              ? "pass"
              : "fail"
            : run.status === "awaiting_input" || run.status === "rate_limited"
              ? "warn"
              : "live"
        }
        // Only while the run is actually stopped on the question. A settled
        // dialogue is a record, and a record does not need attention.
        questionsDot={planAnswerable || lockIsBlocking ? "warn" : null}
        panelTitle={RAIL_LABEL[openPanel ?? "overview"]}
        panelEyebrow="run"
      >
        {/*
         * THE CHAT IS MOUNTED WHENEVER THE RUN VIEW IS, AND MERELY HIDDEN — the one
         * place a panel body renders while it is not the open one, and it is bought
         * with a specific defect it is worth paying for.
         *
         * The composer's draft text lives in `OrchestratorChat`'s own state, and
         * that component has no `value`/`onChange` pair to lift it out through. The
         * old sheet already kept the chat mounted across TAB changes for this
         * reason and recorded what it did not survive: closing the sheet. A rail is
         * worse — closing a panel unmounts it — so the chat is mounted at the run
         * view's level instead and survives both. `hidden` is the HTML attribute,
         * so this is `display: none`: out of the layout, out of the tab order, out
         * of the accessibility tree, still mounted, draft intact.
         *
         * NOTHING ELSE IS WORTH IT. `CodeBrowser` in particular fetches on mount
         * and must not, so Files renders only while Files is open.
         *
         * THE STATE-SPECIFIC SENTENCE ABOVE THE COMPOSER is the one thing the
         * component cannot write for itself: `chatDeliveryNote` (top of this file)
         * returns null for every state `OrchestratorChat`'s own copy already
         * describes accurately, so this is usually just the composer.
         */}
        {chatMounted && (
        <div hidden={openPanel !== "chat"}>
          {deliveryNote !== null && (
            <p className="border-b border-line bg-canvas/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink-dim">
              {deliveryNote.text}
              <Explain
                about={deliveryNote.about}
                className="ml-1"
                testId="explain-delivery"
              >
                {deliveryNote.detail}
              </Explain>
            </p>
          )}
          <OrchestratorChat
            messages={messages}
            runIsOver={isTerminalStatus(run.status)}
            onSend={onSendMessage}
          />
        </div>
        )}

        {openPanel === "overview" && (
          <OverviewPanel
            run={run}
            model={model}
            nowMs={nowMs}
            busy={busy}
            onCancel={onCancel}
            onResume={onResume}
            graph={graph}
            selectedId={selectedId}
            onSelect={setSelectedId}
            showAmbient={showAmbient}
          />
        )}
        {openPanel === "questions" && questionsBody}
        {openPanel === "files" && <FilesPanel run={run} />}
        {openPanel === "result" && <ResultPanel run={run} />}
        {openPanel === "activity" && (
          <ActivityPanel trace={trace} stream={stream} onReconnect={reconnect} />
        )}
      </RunRail>

      {/*
       * THE CANVAS IS THE MAIN OBJECT ON THIS SCREEN and it gets everything the
       * rail and the panel leave. `min-w-0` is load-bearing in a flex row: without
       * it a flex item refuses to shrink below its content's intrinsic width, and
       * React Flow's pane would push the panel off the screen instead of yielding.
       */}
      <div className="relative min-w-0 flex-1">
        <OrchestrationCanvas
          graph={graph}
          ready={graphReady}
          selectedId={selectedId}
          onSelect={setSelectedId}
          showAmbient={showAmbient}
          onShowAmbient={setShowAmbient}
          /*
           * `DetailSheet`'s own width — `w-[min(420px,100%)]` — and only while it
           * is open. The canvas clamps this against its measured pane, because on a
           * viewport narrower than 420px the sheet IS the pane and there is nowhere
           * to pan a card to.
           */
          rightInset={selected === null ? 0 : 420}
          // An empty graph on a live run and on a dead one are the same value and
          // different facts; only this page knows which.
          runIsActive={!isTerminalStatus(run.status)}
          planPanelOpen={planPanelOpen}
          onPlanPanel={setPlanPanelOpen}
          /*
           * THE ~80 MINUTES BEFORE ANY NODE EXISTS. Measured on the run that
           * passed: the spec phase took 79.5 minutes of a 105-minute run, and for
           * all of it the canvas was a static box that looked the same whether the
           * run was working or dead. The trace is already streaming by then, so the
           * newest line is a liveness signal that costs no new plumbing.
           *
           * `trace` is capped and append-only, so the last entry is the newest.
           * `null` when nothing has arrived — the canvas renders nothing rather
           * than an empty row implying a message that did not come.
           */
          latestActivity={
            trace.length === 0
              ? null
              : {
                  text: trace[trace.length - 1]?.text ?? "",
                  atMs: trace[trace.length - 1]?.atMs ?? Date.now(),
                }
          }
          /*
           * `specStages` IS NO LONGER PASSED — 2026-08-04, and the reason is a
           * defect rather than a tidy-up. It was `specPipelineFrom(trace, …)`, and
           * `trace` is the LIVE SSE sink: `use-run-stream.ts` never opens a socket
           * for a terminal run, so the pre-build lane was empty on every run opened
           * after it finished. The canvas now reads `GraphState.stages`, folded by
           * the same reducer on the REST snapshot as on the socket.
           */
          notices={notices}
        />

        {/*
         * NO `chat` PROP ANY MORE — see this file's header and `DetailSheet`'s. The
         * composer was gated here on `selected.parent === null`; it is a rail panel
         * now, which is the only reason a run's first 80 minutes have a chat at
         * all. Nothing about a NODE decides anything about the chat.
         *
         * IT IS INSIDE THE CANVAS PANE rather than beside it, and that is the whole
         * left/right split: the rail carries run-level surfaces and docks on the
         * left; this sheet describes the card you clicked and docks on the right of
         * the graph it is annotating. Nested here so `absolute inset-y-0 right-0`
         * resolves against the pane and not against the panel's edge.
         */}
        {/*
         * THE RUN CHIP, FLOATING IN THE PANE'S TOP-LEFT CORNER.
         *
         * WHY IT IS HERE AND NOT IN `notices`. The canvas reserves 428px of its
         * fit for the floating stack, keyed on `notices !== undefined`, and the
         * comment on that value is explicit that a stack which renders on every
         * run "would take that reservation on every run and push the graph
         * permanently right of centre". The chip is on screen for most of a run's
         * life, so it may not join that stack. It is a plain overlay instead: no
         * reservation, no effect on the fit.
         *
         * THE OVERLAP IT ACCEPTS, stated rather than discovered later. Nothing
         * reserves space for this, so on a graph whose top-left node sits in this
         * corner the chip covers it — the same trade every notice already makes.
         * It is a small one HERE specifically: the chip only exists while the
         * rail's panel is shut, which is the widest the pane ever is, and the
         * pane's `ResizeObserver` has just re-fitted the graph centred in it.
         *
         * `w-[min(360px,calc(100vw-32px))]` IS THE WIDTH `run-hud.tsx`'s own
         * docblock is written against — its title's truncation budget and
         * `ticketLabel`'s character budget are both derived from it, so a
         * different number here would silently invalidate both.
         */}
        {hudMounted && (
          <div
            data-testid="run-chip"
            className="pointer-events-none absolute left-3 top-3 z-10 w-[min(360px,calc(100vw-32px))]"
          >
            <div className="pointer-events-auto shadow-[0_18px_44px_-26px_rgba(0,0,0,0.95)]">
              <RunHud
                run={run}
                model={model}
                nowMs={nowMs}
                busy={busy}
                onCancel={onCancel}
                onResume={onResume}
                /*
                 * "run detail" USED TO OPEN THE RIGHT-HAND SHEET, WHICH NO LONGER
                 * EXISTS. `sheet.tsx` deleted the button for exactly that reason —
                 * "it opened the right-hand sheet the rail replaces, so it now
                 * names nothing". Everything it used to reach is in the rail's
                 * Overview panel, so the handler opens that, and the label below
                 * names the panel it opens rather than a surface that is gone.
                 */
                onOpenDetail={() => {
                  openRailPanel("overview");
                }}
              />
            </div>
          </div>
        )}

        {selected !== null && <DetailSheet node={selected} onClose={clearSelection} />}
      </div>
    </div>
  );
}
