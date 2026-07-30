"use client";

/**
 * orchestrator-chat.tsx — talking to a run that is already going.
 *
 * WHAT IT IS. The owner types an instruction (and optionally drops images) and it
 * goes into the RUNNING session, picked up at the agent's next step — the same
 * behaviour as typing into the interactive CLI while it works.
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
 * and a message list, not the run's status, so the copy below describes both paths.
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
 * the copy under the composer says where a document that needs reading has to go
 * instead — the TICKET form, where it becomes part of the ticket's identity.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";

import { formatTimeOnly } from "@/lib/format";
import { Button, cx } from "@/components/ui";
import {
  acceptAttribute,
  dataUrlsOfKind,
  documentTag,
  planAttachmentIntake,
  readAttachment,
  type Attachment,
  type IntakePolicy,
} from "@/lib/attachments";

/** Mirrors the server's `ChatMessage`. */
export interface ChatMessage {
  readonly seq: number;
  readonly at: string;
  readonly role: "owner" | "run";
  readonly text: string;
  readonly images: readonly string[];
  readonly deliveredAt: string | null;
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
 */
const DOCUMENTS_NOT_WIRED =
  "this run page cannot carry a document to the server yet, so it was not attached. " +
  "Attach it to the ticket when you start a run.";

/**
 * One message, with its delivery state spelled out.
 *
 * `runIsOver` is what turns a null stamp from "waiting" into "never seen", and it is
 * a prop rather than derived here because only the caller knows the run's status.
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
    <li
      className={cx(
        "rounded-sm border px-2 py-1.5",
        mine ? "border-accent/30 bg-accent/[0.06]" : "border-line bg-surface-raised",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          {mine ? "you" : "the run"}
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
      {mine && <p className={cx("mt-1 text-[10.5px]", state.tone)}>{state.label}</p>}
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
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

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
      void Promise.all(plan.take.map(readAttachment))
        .then((read) => {
          setAttachments((previous) => [...previous, ...read]);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [attachments, canAttachDocuments],
  );

  const send = useCallback((): void => {
    const trimmed = text.trim();
    if (busy) return;
    if (trimmed === "" && attachments.length === 0) return;
    setBusy(true);
    setError(null);
    void onSend(
      trimmed,
      dataUrlsOfKind(attachments, "image"),
      dataUrlsOfKind(attachments, "document"),
    )
      .then(() => {
        setText("");
        setAttachments([]);
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
        <span>Chat</span>
        {messages.length > 0 && (
          <span className="numeric text-ink-faint/70">{messages.length}</span>
        )}
      </h4>

      {messages.length > 0 && (
        <ul className="mt-1.5 max-h-[220px] space-y-1.5 overflow-y-auto">
          {messages.map((message) => (
            <Message key={message.seq} message={message} runIsOver={runIsOver} />
          ))}
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
        {runIsOver && (
          <p className="rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-dim">
            This run has finished, so there is no next agent to brief — the server
            refuses a message to a terminal run rather than queueing it into nothing.
            Start a new run to use this.
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

          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {attachments.map((attachment, index) => (
                /*
                 * SAME CHIP GRAMMAR AS THE TICKET FORM: a document carries an
                 * uppercase tag from the server's media-type → extension map and
                 * a heavier border, an image carries neither. The MARKUP is not
                 * shared with `app/page.tsx` — only the tag and the classification
                 * are — because the two chips differ in width and text size and a
                 * shared component would take props for both. Named as a
                 * duplication rather than hidden: it is presentation, and neither
                 * copy can drop a file.
                 */
                <li
                  key={`${attachment.name}:${String(index)}`}
                  className={cx(
                    "flex items-center gap-1 rounded-sm border px-1.5 py-[2px] text-[10.5px] text-ink-dim",
                    attachment.kind === "document"
                      ? "border-line-strong bg-surface-raised"
                      : "border-line",
                  )}
                >
                  {attachment.kind === "document" && (
                    <span className="numeric text-[9px] font-semibold tracking-[0.08em] text-ink-faint">
                      {documentTag(attachment)}
                    </span>
                  )}
                  <span className="max-w-[120px] truncate" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((previous) => previous.filter((_, i) => i !== index))
                    }
                    className="text-ink-faint hover:text-fail"
                    aria-label={`remove ${attachment.name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error !== null && <p className="text-[11px] text-fail">{error}</p>}

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={send} disabled={busy}>
              {busy ? "sending…" : "send"}
            </Button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="text-[11px] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
            >
              {canAttachDocuments ? "attach images or documents" : "attach images"}
            </button>
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
            * THE PROMISE, STATED ONCE, WHERE THE EXPECTATION IS SET — AND IT NOW
            * STATES BOTH PATHS.
            *
            * It used to say only "goes into the running session and is picked up at
            * the agent's next step", which is true of a run mid-segment and false of
            * a PARKED one: `pushLiveMessage` refuses when there is no open segment
            * and the message sits pending until a resume composes the next prompt.
            * The composer renders on parked runs too, so the unqualified sentence
            * was a live claim on exactly the runs where the owner most needs to
            * type. This component is not told the status (see the file header), so
            * it describes both paths rather than picking one, and points at the
            * per-message state line for whether a given message has been read —
            * which is all that line knows; it does not record which path took it.
            */}
          <p className="text-[10.5px] leading-relaxed text-ink-faint">
            While a segment is running this goes into the open session and is picked up
            at the agent&rsquo;s next step — the same as typing into the CLI while it works.
            While the run is parked or between segments there is no session to
            push into, so it is queued and folded into the next prompt when the run
            resumes: answer first, then resume, or the prompt is composed without it.
            Each message you send carries its own state underneath it — queued, read at
            a time, or never read.
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
            Images are read before it acts on them. The acceptance suite is already
            frozen, so ask for changes it is indifferent to; anything contradicting a
            sealed criterion is reported rather than silently traded away.
          </p>
          {/*
            * SHOWN ONLY WHERE IT IS TRUE, AND IT IS A WARNING RATHER THAN A
            * FEATURE NOTE. When documents are refused the refusal itself says
            * where to put one, so this sentence would be a second copy. When they
            * are accepted the owner needs the fact the server states on the run's
            * own stream: a chat document is STORED under `runs/<id>/chat/` and is
            * NOT delivered into the session — the live channel carries text and
            * image paths only — so a scope sent here is filed, not read.
            */}
          {canAttachDocuments && (
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
              A document sent here is stored with the run and is not handed to the
              agent — the live channel carries text and images only. A document the
              run has to read belongs on the ticket.
            </p>
          )}
        </fieldset>
      </div>
    </section>
  );
}
