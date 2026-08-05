"use client";

/**
 * orchestrator-chat.tsx — talking to a run that is already going.
 *
 * WHAT IT IS. The owner types an instruction (and optionally drops images) and it
 * goes into the RUNNING session, picked up at the agent's next step — the same
 * behaviour as typing into the interactive CLI while it works. Since 2026-07-31
 * the run can answer, and this panel renders both directions; see THE REPLY
 * DIRECTION below, which is the half with the traps in it.
 *
 * CORRECTION, 2026-07-30. This file used to say "there is no supported way to push a
 * turn into a running Claude Agent SDK session from outside it". That was wrong, and
 * was asserted without being checked. The SDK's signature is
 * `prompt: string | AsyncIterable<SDKUserMessage>`, and `SDKUserMessage` carries
 * `priority: 'now' | 'next' | 'later'` plus `shouldQuery`, documented as "appended to
 * the transcript without triggering an assistant turn. It will be merged into the next
 * user message that does query." OUR `SessionFactory` had narrowed `prompt` to
 * `string`; the limitation was ours. See `live-input.ts`.
 *
 * TWO DELIVERY PATHS, AND ONLY ONE OF THEM IS LIVE. (The heading here read "AND BOTH
 * ARE LIVE" until 2026-07-30, which contradicted the sentences under it.) A message
 * sent while a segment is running goes down the open channel and the agent picks it
 * up at its next step. A message sent while the run is PARKED (awaiting_input,
 * rate_limited) or between segments has no session to push into: `pushLiveMessage`
 * returns false, the row stays pending, and the segment-boundary drain folds it into
 * the prompt the NEXT segment is composed from — which for a parked run means it is
 * not read until someone resumes. Exactly one of the two stamps `deliveredAt`, which
 * is what keeps delivery at-most-once.
 *
 * THIS COMPONENT CANNOT TELL THE TWO APART BEFORE THE FACT. It is handed `runIsOver`
 * and a message list, not the run's status, so the send button's "i" describes both
 * paths (it was a permanent paragraph under the composer until 2026-08-05).
 * The per-message state line does NOT disambiguate them either: `deliveredAt` is a
 * single stamp written by whichever path took the message, so "read at 14:02" means
 * "it reached a prompt", not "it went down the live channel". An `isParked` prop from
 * `runs/[runId]/page.tsx` would let the promise name the single path that applies;
 * that is a caller change, and is deliberately not faked here with a default.
 *
 * THE THREE STATES A MESSAGE CAN BE IN ARE ALL RENDERED, because collapsing them is
 * how a tool lies to its owner:
 *
 *   - waiting     — sent, not yet picked up;
 *   - read at T   — the instant, off the server's own stamp;
 *   - never read  — the run ended first. This one MUST be visible: the owner
 *                   otherwise believes a redirection landed that no builder read.
 *
 * ============================================================================
 * THE REPLY DIRECTION, ADDED 2026-07-31 — AND THE SILENCE IS THE FEATURE
 * ============================================================================
 *
 * WHAT IT CLOSES, MEASURED. The owner asked a live run "Give me the link to the
 * website". The row shows it delivered and stamped read, and NOTHING came back —
 * not because the agent said nothing, but because no code path turned anything it
 * said into a `messages` row. He noticed and said so. `role: "run"` had been in
 * the type since the table existed with no producer behind it.
 *
 * WHAT A `run` ROW ACTUALLY IS, STATED EXACTLY, BECAUSE IT IS EASY TO OVERCLAIM.
 * `AgentReplyWatch` (`server/src/owner-message.ts`) stores THE AGENT'S OWN LAST
 * TEXT-BEARING TURN OF THE SEGMENT, verbatim, capped at 2000 characters. It is not
 * a generated answer, not a transcript, and not a guarantee the question was even
 * addressed — on a segment cut short by a cancel or a rate limit it is simply the
 * last thing the agent happened to narrate. SAYING SO IS STILL COMPULSORY, and
 * since 2026-08-05 it is said on the `run` ROW ITSELF, behind that row's "i"
 * ({@link Message}), instead of in a permanent paragraph under the composer. The
 * paragraph was a caption for a row that is often not on screen; the glyph is on
 * the row that can be misread as an answer. Deleting the fact outright is not
 * open to a later edit — without it the panel implies the run wrote back to him.
 *
 * NO DELIVERY LINE UNDER A `run` ROW, AND THIS FILE IS WHERE THAT RULE LIVES.
 * `ChatMessage.deliveredAt` is a property of an OWNER row: on a `run` row it is
 * always null and means NOTHING AT ALL — "delivered to whom?" has no answer for a
 * reply and this program has no signal that the owner read anything.
 * `server/src/db.ts:268-274` names `orchestrator-chat.tsx` as the enforcer, so the
 * `role === "owner"` gate in {@link Message} is load-bearing, not cosmetic: drop it
 * and every reply grows a "never read" line that measures nothing.
 *
 * "THE RUN HAS NOT ANSWERED" IS A RENDERED STATE, NOT AN EMPTY GAP — see
 * {@link replyGap}. The server deliberately stores nothing when a segment produced
 * no assistant text, so the absence of a reply is a designed outcome the owner
 * would otherwise sit and wait through. The row this panel draws for it says NO
 * REPLY WAS RECORDED and never "the agent said nothing": the client sees only the
 * absence of a row, and at least three different things produce it — a segment
 * with no text-bearing turn, a run that went terminal before `record` was reached,
 * and a segment that never ended at all. Naming the mechanism keeps the sentence
 * true under all three, the same discipline `RunSilence` uses.
 *
 * THIS PANEL CANNOT WATCH A REPLY ARRIVE, AND THE COPY MUST NOT PRETEND IT CAN.
 * `runs/[runId]/page.tsx:314-340` fetches messages on exactly three paths —
 * `openChat`, `changeRunSheetTab("chat")` and `onSendMessage`. There is no timer
 * and no SSE hook, and a reply is written at the END of a build segment, which can
 * be an hour after the question. So a chat left open shows the list as it was when
 * it was opened: the waiting row tells the owner to reopen the tab, because that
 * really does re-read, rather than promising an arrival this component cannot
 * observe. A poll while the tab is open is a caller change and is deliberately not
 * faked here — the server already emits `the run answered in the chat` on the event
 * stream, which is the hook a caller would refetch on.
 *
 * IT IS SHOWN ON THE ORCHESTRATOR NODE ONLY. A sub-agent has no session to inject
 * into — it is spawned with a prompt and it ends — so a chat box on one would be a
 * control that cannot do anything.
 *
 * DOCUMENTS: THE CODE IS HERE, THE CONTROL IS OFF, AND BOTH FACTS ARE DELIBERATE.
 * `POST /api/runs/:id/messages` accepts `documents` today. This component can take
 * them — same planner, same caps, same chips as the ticket form — but the intake
 * is gated behind {@link OrchestratorChat}'s `canAttachDocuments`, which DEFAULTS
 * TO FALSE, because the path from here to that route is not connected:
 *
 *   `api.ts#sendRunMessage(runId, text, images)` builds `{text, images}` by hand
 *   and has no `documents` parameter — `api-types.ts#SendMessageRequest` says so
 *   in its own docblock;
 *   `runs/[runId]/page.tsx:243`'s `onSendMessage` declares TWO parameters, so the
 *   third argument this component now passes is dropped by the language, silently
 *   and without a type error (a 2-ary function is assignable to a 3-ary type).
 *
 * (Both bullets above describe the WIRING, not copy: the sentence the owner reads
 * about a chat document now lives behind the "i" beside the attach button, and is
 * rendered only when `canAttachDocuments` is true — i.e. nowhere, today.)
 *
 * Shipping the control ACTIVE against that would be the exact defect
 * `ticket-references.browser.spec.ts` was written for — a chip that renders and
 * posts nothing — so it ships refused, with the reason on screen. Both files are
 * outside this change's scope; turning it on is a three-line handoff and all
 * three lines must land together (widen `sendRunMessage`, widen `onSendMessage`,
 * pass `canAttachDocuments`).
 *
 * AND EVEN THEN, "SENT" WOULD NOT MEAN "READ". The server stores a chat message's
 * documents under `runs/<id>/chat/` and emits a `warn` saying they were STORED,
 * NOT DELIVERED: the channel to a running agent carries text and image paths
 * only. That is the server's design, not a gap in this component, and it is why
 * the "i" beside the attach button says where a document that needs reading has to
 * go instead — the TICKET form, where it becomes part of the ticket's identity.
 *
 * ============================================================================
 * THE PROSE CUT, 2026-08-05 — WHAT LEFT THE SCREEN AND WHERE IT WENT
 * ============================================================================
 *
 * The owner screenshotted this panel as the worst instance of "these long
 * explanations for everything ... If something really must have a explanation it
 * should have little i icon". Two paragraphs, ninety words, permanently under the
 * send button. They are gone; the three facts inside them are not — each is behind
 * an {@link Explain} on the control it is about, and the block comment where the
 * paragraphs stood names every clause and its outcome. The banned words went with
 * them: "segment", "session", "the acceptance suite is frozen", "terminal run".
 *
 * WHAT MAY NOT COME BACK: a caption. If a future edit wants to explain something
 * here, the test is `explain.tsx`'s — a fact that changes what the reader DOES may
 * be hidden and may never be deleted; anything that restates a label on screen, or
 * describes a consequence of an action he has not taken, is deleted instead.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { formatTimeOnly } from "@/lib/format";
import { AttachmentChips } from "@/components/attachment-chips";
import { Explain } from "@/components/explain";
import { Button, cx } from "@/components/ui";
import {
  acceptAttribute,
  dataUrlsOfKind,
  planAttachmentIntake,
  readAttachments,
  releaseAttachments,
  type HeldAttachment,
  type IntakePolicy,
} from "@/lib/attachments";

/**
 * Mirrors the server's `ChatMessage` (`dashboard/server/src/db.ts:255`).
 *
 * IT IS THE THIRD COPY OF THIS SHAPE AND THAT IS WORTH KNOWING BEFORE EDITING IT.
 * The server owns it, `src/lib/api.ts:245` mirrors it for the fetch layer, and this
 * one is what the panel renders. `runs/[runId]/page.tsx` imports the api.ts one and
 * passes it here, so the two client copies meet only STRUCTURALLY — a field added
 * to one and not the other compiles clean and simply never arrives. NOTHING CHECKED
 * ON 2026-07-31 COMPARES THEM: `contract-parity.test.ts` does read `src/lib/api.ts`
 * as text, but only the `createRun` region for the design-lock policy, and neither
 * api-types file declares a chat message at all; no test reads this file. That is a
 * statement about the two files that were read, not a proof about the whole suite.
 *
 * `role` IS A DIRECTION, NOT AN AUTHOR: `run` is text the agent itself produced, and
 * the server refuses to write a row of its own composition under it.
 */
export interface ChatMessage {
  readonly seq: number;
  readonly at: string;
  readonly role: "owner" | "run";
  readonly text: string;
  readonly images: readonly string[];
  /**
   * OWNER ROWS ONLY. Always null on a `run` row, where it means nothing — see the
   * file header, and do not render a delivery line from it there.
   */
  readonly deliveredAt: string | null;
}

/**
 * The conversation is waiting on a reply that may never come.
 *
 * TWO KINDS, AND THE DIFFERENCE IS WHETHER ANYTHING CAN STILL CHANGE:
 * `waiting` is a live run (a reply may yet be recorded, or may not), `unanswered`
 * is a terminal one — nothing more will be written, so the gap is final.
 *
 * `read` IS TRUE IF **ANY** OWNER MESSAGE SINCE THE LAST REPLY WAS DELIVERED, not
 * just the newest one, and that is a correctness fix rather than a nicety. Take the
 * real shape of an unanswered conversation: "Give me the link to the website" is
 * delivered and stamped `read at 05:49`, nothing comes back, and the owner types
 * "hello?" which is still queued. Reading the tail alone gives `read: false` and the
 * row says "not read yet, so there is nothing to answer" DIRECTLY UNDER a message
 * this same panel has labelled `read at 05:49` — a self-contradiction on screen, and
 * it buries the one fact the row exists for: a message that WAS read went
 * unanswered. It is carried at all so the row can say WHY there is no answer;
 * nothing reached a prompt is a different fact from read-and-silent.
 */
export type ReplyGap =
  | { readonly kind: "waiting"; readonly read: boolean }
  | { readonly kind: "unanswered"; readonly read: boolean };

/**
 * Is the last thing in this conversation an unanswered owner message? `null` when
 * there is nothing to say.
 *
 * IT IS A PROPERTY OF THE TAIL, NOT OF EACH MESSAGE, and that is forced by the
 * server rather than chosen for tidiness: `AgentReplyWatch.record` fires ONCE PER
 * SEGMENT, gated on `ownerMessagesDeliveredSince`, so three messages sent inside one
 * segment are answered by at most one `run` row. Marking each owner message
 * answered/unanswered would attribute one reply to one question, which is a claim
 * the mechanism cannot support.
 *
 * IT RELIES ON `messages` BEING IN SEQ ORDER, which `RunStore.messages` guarantees
 * (`ORDER BY seq ASC`, db.ts:968) and `page.tsx` passes through untouched. Given
 * that, every row after the last owner row is a `run` row, so the tail element
 * decides it — and the deliberately naive `messages.some(m => m.role === "run")`
 * would answer a NEW question with an OLD reply, which is the case a test has to
 * cover.
 *
 * EXPORTED FOR A UNIT SPEC, which does not exist yet: this component's files were
 * the whole of the change that added it, so `dashboard/tests/chat-reply.unit.spec.ts`
 * is a handoff and the rule below is currently unwatched.
 */
export function replyGap(
  messages: readonly ChatMessage[],
  runIsOver: boolean,
): ReplyGap | null {
  const last = messages[messages.length - 1];
  // An empty conversation and one that ends in a reply are both "nothing to say".
  // The second is the whole reason this is not a `some()` over the list.
  if (last === undefined || last.role === "run") return null;

  /*
   * WALK BACK TO THE LAST REPLY, NOT JUST TO THE TAIL. Everything after it is the
   * unanswered run of owner messages, and one delivered message anywhere in that
   * run is enough for "it was read": the reply the segment owed covers the whole
   * group, so a newer queued message must not downgrade the sentence. See the
   * worked example on {@link ReplyGap}.
   */
  let read = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role === "run") break;
    if (message.deliveredAt !== null) read = true;
  }

  return runIsOver ? { kind: "unanswered", read } : { kind: "waiting", read };
}

const MAX_TEXT_CHARS = 8_000;

/*
 * THE IMAGE CAPS AND THE READER MOVED TO `@/lib/attachments`, and one of them was
 * WRONG while it lived here. This file filtered on `type.startsWith("image/")`
 * under a comment reading "Matches the server's caps, so the refusal happens
 * before the round trip" — it did not: `decodeReferenceDataUrl`
 * (`server/src/ticket-refs.ts:113`) accepts png/jpeg/jpg/webp/gif and nothing
 * else, so an SVG passed this pre-flight, was uploaded, and came back 400 with a
 * message the composer showed but could not have predicted. The comment claimed
 * what the mechanism did not do, which is the defect class this repository keeps
 * finding. The shared planner now decides for both intakes.
 */

/**
 * Why a document cannot be attached HERE, today. See the file header for the
 * three-line handoff that removes it.
 *
 * IT IS THE OWNER'S SENTENCE, NOT A DEVELOPER'S: it says where the document has
 * to go instead, because the ticket form is the surface that does read one into
 * the run's identity. The wiring detail belongs in the header, above.
 *
 * SHORTENED 2026-08-05 AND IT STAYS INLINE. It is a REFUSAL — it appears only
 * after he has already dropped a file, and a refusal that hides behind an "i"
 * is a file that vanished for no stated reason. What went is "to the server
 * yet, so it was not attached", which restated the failure the sentence is
 * already reporting.
 */
const DOCUMENTS_NOT_WIRED =
  "this page cannot send a document yet. Attach it to the ticket when you start a run.";

/**
 * One message in either direction, with an OWNER message's delivery state spelled
 * out under it.
 *
 * ONE COMPONENT FOR BOTH ROLES, deliberately: the two rows differ by three class
 * strings and one gated line, and splitting them would put the `role === "owner"`
 * rule the server points at (`db.ts:268-274`) in a file where a reply row could
 * later be built without it.
 *
 * `runIsOver` is what turns a null stamp from "waiting" into "never seen", and it is
 * a prop rather than derived here because only the caller knows the run's status. It
 * says nothing about a `run` row, which carries no delivery state at all.
 */
function Message({
  message,
  runIsOver,
}: {
  message: ChatMessage;
  runIsOver: boolean;
}): ReactNode {
  const mine = message.role === "owner";
  /*
   * THREE STATES, AND THE MIDDLE ONE IS WHY `deliveredAt` EXISTS.
   *
   * A stamp means the text reached a prompt — either pushed straight into the running
   * session (streaming input) or folded in at a segment boundary. No stamp on a live
   * run means it is still waiting. No stamp on a FINISHED run means it was never read,
   * and saying "sent" there would be the tool lying about the one thing the owner
   * needs to know.
   *
   * THE MIDDLE LABEL SAYS "QUEUED", NOT "waiting for the agent's next step", CHANGED
   * 2026-07-30. `runIsOver` is the only run state this component is given, so the
   * not-yet-delivered case covers both a running segment (where the next step really
   * is what picks it up) and a PARKED run, where nothing is stepping and the message
   * waits for a resume. The old wording promised imminent pickup on a run that was
   * not moving at all; "queued — not read yet" is true in both.
   */
  const state =
    message.deliveredAt !== null
      ? { label: `read at ${formatTimeOnly(message.deliveredAt)}`, tone: "text-pass" }
      : runIsOver
        ? {
            label: "never read — the run ended first",
            tone: "text-warn",
          }
        : { label: "queued — not read yet", tone: "text-ink-faint" };

  return (
    /*
     * THREE DISTINCTIONS, NOT ONE, BECAUSE COLOUR ALONE IS NOT A DISTINCTION.
     * The two directions differ by INDENT (owner rows are pushed right, run rows
     * left), by surface (accent tint vs raised panel) and by the role label. A
     * reader with a colour deficiency, or reading a greyscale screenshot in a
     * findings doc, still sees whose turn a row is.
     */
    <li
      className={cx(
        "rounded-sm border px-2 py-1.5",
        mine
          ? "ml-5 border-accent/30 bg-accent/[0.06]"
          : "mr-5 border-line-strong bg-surface-raised",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          {mine ? "you" : "the run"}
          {/*
            * WHAT A REPLY IS, ON THE ROW THAT COULD BE MISREAD AS AN ANSWER —
            * MOVED HERE 2026-08-05 out of the permanent paragraph under the
            * composer. The fact changes what the reader DOES with a reply: a
            * `run` row is the agent's own last narration of that stretch of
            * work, so taking it as a reply to the question above it is how he
            * concludes something the run never said. It is on the `run` row and
            * not on the panel heading because it is untrue of an owner row, and
            * `plan-dialogue.tsx` draws the same label over rows where the seat
            * really did answer him.
            */}
          {!mine && (
            <Explain
              about="what the run sends back"
              /*
               * ONE TESTID PER ROW, AND IT IS NOT A CONVENIENCE. A shut bubble
               * is inline inside its own trigger's wrapper; an OPEN one is
               * portaled to `document.body`, i.e. to the end of the document.
               * With a shared testid, `getByTestId("explain-reply-body")
               * .first()` therefore resolves to a DIFFERENT row's bubble the
               * moment one opens — and since every one of these carries the same
               * sentence, the text assertion still passes while the width
               * assertion reads a shut bubble. Found by running it.
               */
              testId={`explain-reply-${String(message.seq)}`}
              className="ml-1"
            >
              This is the last thing the agent wrote in that stretch of work, word for
              word — not an answer written for you.
            </Explain>
          )}
        </span>
        <span className="numeric text-[10px] text-ink-faint">
          {formatTimeOnly(message.at)}
        </span>
      </div>
      {message.text !== "" && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-dim">
          {message.text}
        </p>
      )}
      {message.images.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-faint">
          {message.images.length} image{message.images.length === 1 ? "" : "s"} attached
        </p>
      )}
      {/*
        * THE DELIVERY LINE IS GATED ON `owner` AND MUST STAY THAT WAY. A reply's
        * `deliveredAt` is always null and carries no meaning (`db.ts:268-274`
        * names this file as the enforcer); ungated, every reply would grow a
        * "never read" line describing nothing.
        */}
      {mine && <p className={cx("mt-1 text-[10.5px]", state.tone)}>{state.label}</p>}
    </li>
  );
}

/**
 * The row that stands where a reply would be — the point of the whole feature.
 *
 * IT IS AN ABSENCE DRAWN AS A ROW, so it is dashed, carries the label NO REPLY
 * rather than "the run", and sits on the run's side of the list. Nothing here may
 * read as the run speaking: it is this panel's statement about the record, not a
 * message.
 *
 * EVERY SENTENCE BELOW IS ABOUT WHAT WAS RECORDED, NEVER ABOUT WHAT THE AGENT DID.
 * The client cannot tell a segment that produced no assistant text from a run that
 * went terminal before the reply was written, so "no reply was recorded" is the
 * strongest true form. "The agent said nothing" would be a diagnosis from the one
 * bit this component has.
 *
 * THE REOPEN INSTRUCTION IS CHECKABLE, WHICH IS WHY IT IS THERE INSTEAD OF A
 * PROMISE: `page.tsx` refetches on `openChat` and on `changeRunSheetTab("chat")`,
 * so leaving the Chat tab and coming back really does re-read the list. Nothing
 * refetches while it sits open.
 */
function ReplyGapRow({ gap }: { gap: ReplyGap }): ReactNode {
  /*
   * THE SENTENCES SAY "WHAT YOU SENT", NOT "YOUR MESSAGE". `gap.read` describes the
   * whole unanswered run of owner messages, which can be more than one and can be
   * mixed — read and queued — so a singular possessive would name a specific row the
   * row above may be contradicting. Each message's own state stays under it.
   */
  /*
   * ALL FOUR TRIMMED 2026-08-05, AND ALL FOUR STAYED INLINE. This row is the
   * one place an ABSENCE is stated; hiding it behind an "i" would put the
   * silence back to being a gap the reader sits and waits through, which is the
   * defect the row was built for. What went was the mechanism behind each
   * sentence, not its claim:
   *
   *   · "Nothing more can arrive" — the badge above already reads THE RUN DID
   *     NOT ANSWER on a run that has ended, in the past tense.
   *   · "One is stored when a build segment ends, and only if the agent
   *     produced text" — the first half survives in plain words ("when the run
   *     next stops"), the second is what the `run` row's own "i" says.
   *
   * "REOPEN THIS TAB" SURVIVES IN BOTH LIVE SENTENCES and is the reason they
   * are not shorter still: nothing refetches while this panel sits open
   * (`page.tsx:314-340`), so a reader who is not told to reopen waits on an
   * arrival this component cannot observe.
   */
  const final = gap.kind === "unanswered";
  const sentence = final
    ? gap.read
      ? "It was read, and no reply was recorded before the run ended."
      : "The run ended before reading it, so there was nothing to answer."
    : gap.read
      ? "It reached the run. A reply is only stored when the run next stops — reopen this tab to check."
      : "Not read yet, so there is nothing to answer — reopen this tab to check.";

  return (
    <li className="mr-5 rounded-sm border border-dashed border-line-strong px-2 py-1.5">
      <span
        className={cx(
          "text-[10px] font-semibold uppercase tracking-[0.1em]",
          final ? "text-warn" : "text-ink-faint",
        )}
      >
        {final ? "the run did not answer" : "no reply yet"}
      </span>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">{sentence}</p>
    </li>
  );
}

export function OrchestratorChat({
  messages,
  runIsOver,
  onSend,
  canAttachDocuments = false,
}: {
  messages: readonly ChatMessage[];
  runIsOver: boolean;
  /**
   * Rejects with a message the panel shows verbatim.
   *
   * THE THIRD PARAMETER IS NEW AND IS NOT YET RECEIVED BY ANYBODY. The only
   * caller declares two, so `documents` is discarded at the call site with no
   * type error — which is precisely why `canAttachDocuments` defaults to false
   * and nothing can reach this argument until that caller is widened. See the
   * file header.
   */
  onSend: (
    text: string,
    images: readonly string[],
    documents: readonly string[],
  ) => Promise<void>;
  /**
   * May this composer take documents? DEFAULT FALSE.
   *
   * IT IS A STATEMENT ABOUT THE CALLER, NOT A FEATURE FLAG: pass `true` only
   * from a caller whose `onSend` actually forwards its third argument to
   * `POST /api/runs/:id/messages`. Passing it from a caller that does not turns
   * this into a chip list that posts nothing.
   */
  canAttachDocuments?: boolean;
}): ReactNode {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<readonly HeldAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * THE OBJECT URLS DIE WITH THIS PANEL. It is mounted inside the run sheet, which
   * the reader closes with Escape or the × — so unmount with images still staged is
   * the ORDINARY path here, not an edge case, and nothing else would ever free them.
   *
   * The sweep is keyed on `[]` so it runs at unmount only; a cleanup keyed on
   * `[attachments]` would revoke the previous list on every add and blank the
   * thumbnails already on screen. The mirror is what gives that cleanup the list it
   * cannot close over.
   */
  const held = useRef<readonly HeldAttachment[]>([]);
  useEffect(() => {
    held.current = attachments;
  }, [attachments]);
  useEffect(() => () => releaseAttachments(held.current), []);

  const gap = replyGap(messages, runIsOver);

  /**
   * ONE FIELD CARRIES BOTH THE POLICY AND THE SENTENCE — `null` accepts
   * documents, a string refuses them AND is what the owner is shown. A boolean
   * would let this control go quietly inert.
   */
  const policy: IntakePolicy = {
    documentsRefused: canAttachDocuments ? null : DOCUMENTS_NOT_WIRED,
  };

  /**
   * Take files from any of the three intakes — paste, drop, file picker.
   *
   * TWO BEHAVIOURS CHANGED HERE AND BOTH WERE BUGS. The type filter was wider
   * than the server's (see the note by `MAX_TEXT_CHARS`), and the overflow was a
   * bare `.slice(0, MAX_IMAGES)` with no message — so a drop of eight images left
   * six chips and no way to learn the other two had ever been read. The planner
   * names every file it drops; `error` shows the sentence.
   */
  const addFiles = useCallback(
    (files: readonly File[]): void => {
      setError(null);
      if (files.length === 0) return;
      const plan = planAttachmentIntake(files, attachments, {
        // Rebuilt here rather than closed over: an object literal in the render
        // body is a new identity every pass, which would make this memo useless
        // and the dependency list a lie.
        documentsRefused: canAttachDocuments ? null : DOCUMENTS_NOT_WIRED,
      });
      setError(plan.refusal);
      if (plan.take.length === 0) return;
      void readAttachments(plan.take)
        .then((read) => {
          setAttachments((previous) => [...previous, ...read]);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [attachments, canAttachDocuments],
  );

  /**
   * Drop one chip, and hand its object URL back before the render that forgets it.
   *
   * OUTSIDE THE UPDATER, for the reason `releaseAttachments` states: React
   * re-invokes updaters, and a side effect in one is how a thumbnail goes blank for
   * reasons nobody can reproduce.
   */
  const removeAttachment = useCallback(
    (index: number): void => {
      const doomed = attachments[index];
      if (doomed !== undefined) releaseAttachments([doomed]);
      setAttachments((previous) => previous.filter((_unused, i) => i !== index));
    },
    [attachments],
  );

  const send = useCallback((): void => {
    const trimmed = text.trim();
    if (busy) return;
    if (trimmed === "" && attachments.length === 0) return;
    /*
     * WHAT IS BEING SENT, PINNED HERE, AND EVERY LINE BELOW IS ABOUT THIS LIST
     * AND NOT ABOUT `attachments`.
     *
     * A REQUEST TAKES TIME AND THE COMPOSER STAYS LIVE FOR ALL OF IT. The send
     * button disables while busy; the file input, the paste handler and the drop
     * handler do not, deliberately — a reader who spots a second screenshot
     * while the first is uploading should be able to add it. So by the time this
     * promise settles, component state may hold attachments this request never
     * carried, and the previous version ended in `setAttachments([])`, which
     * dropped them: the chip vanished from the box he had just attached it to,
     * and its `blob:` URL was never revoked because nothing held it any more.
     * The cap is six images at 8 MB, so up to 48 MB pinned for the life of the
     * document. Measured in Chromium; `chat-attachments.browser.spec.ts`.
     */
    const sent = attachments;
    setBusy(true);
    setError(null);
    void onSend(trimmed, dataUrlsOfKind(sent, "image"), dataUrlsOfKind(sent, "document"))
      .then(() => {
        setText("");
        // HANDED BACK BEFORE THE STATE FORGETS THEM, and OUTSIDE the updater for
        // the reason `releaseAttachments` states — React re-invokes updaters, and
        // a side effect in one is how a thumbnail goes blank unreproducibly. Only
        // on SUCCESS: a rejected send keeps the chips and their previews.
        releaseAttachments(sent);
        // BY IDENTITY, NOT BY INDEX OR BY NAME. A `HeldAttachment` is created once
        // in `readAttachment` and never copied, so `has` is exact — where an index
        // would be shifted by a removal made mid-flight and a name would drop a
        // second file the reader picked with the same one.
        const posted = new Set(sent);
        setAttachments((previous) => previous.filter((one) => !posted.has(one)));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [text, attachments, busy, onSend]);

  return (
    <section className="border-b border-line px-3 py-2.5">
      {/*
        * CALLED "CHAT", NOT "STEER THIS RUN" — the owner could not find it under the
        * clever name. A section heading is a label, not a description of intent.
        */}
      <h4 className="flex items-baseline justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        <span>
          Chat
          {/*
            * WHAT THIS CHAT CAN AND CANNOT CHANGE — MOVED HERE 2026-08-05 from
            * the second permanent paragraph under the composer, and reworded
            * out of "the acceptance suite is frozen", which used two words the
            * owner does not use. The claim is `owner-message.ts:84-101`
            * verbatim: the instruction is applied wherever the sealed tests are
            * indifferent to it, and one that contradicts the ticket is done as
            * far as it safely can be, the original requirement kept working,
            * and the conflict named in the final summary. It changes what he
            * TYPES — "drop the contact page" is a different request from "make
            * the hero warmer" — so it is hidden, not deleted.
            */}
          <Explain
            about="what this chat can change"
            testId="explain-scope"
            className="ml-1"
          >
            The tests this run is graded on were written before any code and cannot be
            edited. Ask for changes they do not cover; one that contradicts the ticket is
            reported back, not made quietly.
          </Explain>
        </span>
        {messages.length > 0 && (
          <span className="numeric text-ink-faint/70">{messages.length}</span>
        )}
      </h4>

      {messages.length > 0 && (
        <ul className="mt-1.5 max-h-[220px] space-y-1.5 overflow-y-auto">
          {messages.map((message) => (
            <Message key={message.seq} message={message} runIsOver={runIsOver} />
          ))}
          {/*
            * LAST IN THE LIST, WHERE THE MISSING REPLY WOULD BE. Derived on every
            * render rather than memoised: it is one array-tail read, and a stale
            * "the run did not answer" under a reply that has since arrived is the
            * exact lie this row exists to prevent.
            */}
          {gap !== null && <ReplyGapRow gap={gap} />}
        </ul>
      )}

      {/*
        * THE COMPOSER IS ALWAYS RENDERED — CORRECTED 2026-07-30.
        *
        * The first version replaced it with a single sentence on a terminal run, on
        * the reasoning that a control which cannot act should not be shown. That was
        * wrong in practice for a reason worth recording: the owner's only run had
        * FINISHED, so the sentence was all there was, and the verdict was "i dont see
        * any chat anywhere". A feature that is invisible in the one state the reader
        * happens to be in is not a tidy feature, it is a missing one.
        *
        * So the box stays, disabled, with the reason ON it. The reader can see what
        * the chat is, that it takes images, and why it is not accepting one right now.
        */}
      <div className="mt-1.5 space-y-1.5">
        {/*
          * ONE SENTENCE, AND THE MOVE IS THE HALF THAT SURVIVED. It said "the
          * server refuses a message to a terminal run rather than queueing it
          * into nothing" — the mechanism behind a box that is already visibly
          * disabled, and "terminal run" is not a phrase the owner uses. What is
          * left is the state and the way out of it, which is all a reader can
          * act on here.
          */}
        {runIsOver && (
          <p className="rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-dim">
            This run has finished. Start a new run to use this.
          </p>
        )}
        <fieldset disabled={runIsOver} className="space-y-1.5 disabled:opacity-50">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT_CHARS))}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline — the convention every chat
              // uses, so it needs no label.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            onPaste={(event) => {
              // A pasted screenshot is the fastest way to hand over a reference, and
              // is the one this owner is most likely to reach for.
              const files = [...event.clipboardData.files];
              if (files.length > 0) {
                event.preventDefault();
                addFiles(files);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              addFiles([...event.dataTransfer.files]);
            }}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            rows={3}
            placeholder={
              canAttachDocuments
                ? "Tell it what to change. Paste or drop an image or a document."
                : "Tell it what to change. Paste or drop images to show it an example."
            }
            className="w-full resize-y rounded-sm border border-line bg-canvas px-2 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />

          {/*
            * THE SAME CHIPS AS THE TICKET FORM — NOW THE SAME COMPONENT, WHICH
            * CORRECTS WHAT STOOD HERE. The markup was a hand copy of `app/page.tsx`'s,
            * justified in a comment by the two chips differing "in width and text
            * size": they never differed in text size — both were `text-[10.5px]` —
            * and the only real difference was the filename's `max-w`, 120 here
            * against 160 there. A thumbnail, a lightbox and an object-URL lifetime
            * are not a width's worth of markup to keep in step by hand, so the
            * duplication is gone rather than re-argued. This composer is 360px of
            * sheet and the shared chip is 40px tall; it wraps.
            */}
          <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

          {error !== null && <p className="text-[11px] text-fail">{error}</p>}

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={send} disabled={busy}>
              {busy ? "sending…" : "send"}
            </Button>
            {/*
              * THE TIMING FACT, ON THE CONTROL IT IS ABOUT — MOVED HERE
              * 2026-08-05 out of the first permanent paragraph under this row.
              * It is the one clause in either paragraph that changes the ORDER
              * of two things the reader is about to do, so it is hidden and not
              * deleted; `explain.tsx` names it as the type specimen.
              *
              * IT STILL DESCRIBES BOTH PATHS, WHICH IS THE PART THAT MAY NOT BE
              * CUT. `pushLiveMessage` refuses when there is no open segment and
              * the row sits pending until a resume composes the next prompt;
              * this composer renders on parked runs too and is not told the
              * status (see the file header), so a bubble describing only the
              * live path would be a false claim on exactly the runs where he
              * most needs to type.
              *
              * WHAT WAS DELETED AROUND IT: "goes into the open session", "there
              * is no session to push into", "folded into the next prompt" —
              * three ways of naming a mechanism whose OUTCOME is already
              * reported per message, under the message, as `queued — not read
              * yet` or `read at 14:02`.
              */}
            {/*
              * `-ml-1` PULLS IT ONTO THE SEND BUTTON. The row is `gap-2` with
              * "attach images" on the other side, and at an even gap the glyph
              * reads as belonging to whichever control the eye reaches first.
              * Half the gap on the left and the full gap on the right is what
              * binds it to `send`, which is the control it is about.
              *
              * NOT RENDERED ON A FINISHED RUN, AND THAT WAS FOUND BY CLICKING
              * IT RATHER THAN BY READING IT. Everything in this row lives inside
              * `<fieldset disabled={runIsOver}>`, which disables a <button>
              * DESCENDANT — so on a terminal run the trigger was on screen,
              * greyed, and refused every pointer and keyboard event: a fact
              * moved behind a control nobody can open is a fact deleted with
              * extra steps. The fact is about WHEN A MESSAGE IS READ, and on a
              * finished run no message can be sent at all — the dashed notice
              * above says so — so the honest fix is no glyph rather than a dead
              * one.
              */}
            {!runIsOver && (
              <Explain
                about="when the run reads this"
                testId="explain-timing"
                className="-ml-1"
              >
                While the run is working it reads this at its next step. While it is
                stopped the message waits — send it before you resume, or that prompt is
                composed without it.
              </Explain>
            )}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="text-[11px] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
            >
              {canAttachDocuments ? "attach images or documents" : "attach images"}
            </button>
            {/*
              * SHOWN ONLY WHERE IT IS TRUE, AND IT IS A WARNING RATHER THAN A
              * FEATURE NOTE. When documents are refused the refusal itself says
              * where to put one, so this sentence would be a second copy. When
              * they are accepted the owner needs the fact the server states on
              * the run's own stream: a chat document is STORED under
              * `runs/<id>/chat/` and is NOT delivered into the session — the
              * live channel carries text and image paths only — so a scope sent
              * here is filed, not read.
              *
              * BEHIND THE "i" SINCE 2026-08-05, ON THE INTAKE IT DESCRIBES,
              * where a permanent paragraph used to sit under the composer. It
              * is a property of a control he has to reach for before it can
              * bite, and `canAttachDocuments` is false at every call site today.
              * The fact survives because it changes where he puts a document the
              * run has to READ.
              */}
            {canAttachDocuments && (
              <Explain about="documents sent here" testId="explain-documents">
                A document sent here is stored with the run and is not handed to the agent.
                One the run has to read belongs on the ticket.
              </Explain>
            )}
            <input
              ref={fileInput}
              type="file"
              /*
               * `accept` FOLLOWS THE POLICY, so the picker does not offer a
               * document this composer would then refuse. It is only a hint —
               * every browser has an "all files" escape, and drop and paste never
               * consult it — which is why the refusal exists at all.
               */
              accept={acceptAttribute(policy)}
              multiple
              hidden
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
          </div>

          {/*
            * ═══ THE TWO PARAGRAPHS THAT USED TO LIVE HERE ARE GONE ═══
            *
            * 2026-08-05. Ninety words of permanent prose under the send button,
            * screenshotted by the owner as the worst instance of "these long
            * explanations for everything". Every clause is accounted for; none
            * of the three facts among them was dropped:
            *
            *   MOVED, to the "i" on the SEND BUTTON — "send before you resume,
            *     or that prompt is composed without it", plus the running/
            *     stopped distinction it depends on. It changes the ORDER of two
            *     things he is about to do.
            *   MOVED, to the "i" on the CHAT HEADING — the sealed-tests scope
            *     rule, reworded out of "the acceptance suite is frozen".
            *   MOVED, to the "i" on each `run` ROW — "what comes back is the
            *     agent's own last message … not an answer written for you". It
            *     sits on the row that could be misread rather than in a caption
            *     for a row that may not be on screen.
            *   DELETED — "While a segment is running this goes into the open
            *     session"; "there is no session to push into"; "it is queued and
            *     folded into the next prompt". The OUTCOME of all three is
            *     already printed under each message as `queued — not read yet`,
            *     `read at 14:02` or `never read — the run ended first`.
            *   DELETED — "Images are read before it acts on them." A promise
            *     about a consequence of an action he has not taken yet, next to
            *     a placeholder already inviting him to drop one.
            *
            * IF THIS EVER GROWS BACK: the test that stops it is
            * `chat-plan-copy.browser.spec.ts`, which asserts the composer's own
            * prose stays under a word count and that each moved fact is still
            * reachable through its glyph.
            */}
        </fieldset>
      </div>
    </section>
  );
}
