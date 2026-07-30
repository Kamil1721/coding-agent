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
 * TWO DELIVERY PATHS, AND BOTH ARE LIVE. A message sent while a segment is running
 * goes down the open channel. A message sent while the run is PARKED (awaiting_input,
 * rate_limited) or between segments has no session to push into, so the
 * segment-boundary drain carries it instead. Exactly one of the two stamps
 * `deliveredAt`, which is what keeps delivery at-most-once.
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
 */

import { useCallback, useRef, useState, type ReactNode } from "react";

import { formatTimeOnly } from "@/lib/format";
import { Button, cx } from "@/components/ui";

/** Mirrors the server's `ChatMessage`. */
export interface ChatMessage {
  readonly seq: number;
  readonly at: string;
  readonly role: "owner" | "run";
  readonly text: string;
  readonly images: readonly string[];
  readonly deliveredAt: string | null;
}

/** Matches the server's caps, so the refusal happens before the round trip. */
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 8_000;

interface Attachment {
  readonly name: string;
  /** `data:image/png;base64,…` — what the API takes. */
  readonly dataUrl: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(new Error(`could not read ${file.name}`));
    };
    reader.readAsDataURL(file);
  });
}

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
   */
  const state =
    message.deliveredAt !== null
      ? { label: `read at ${formatTimeOnly(message.deliveredAt)}`, tone: "text-pass" }
      : runIsOver
        ? {
            label: "never read — the run ended first",
            tone: "text-warn",
          }
        : { label: "waiting for the agent's next step", tone: "text-ink-faint" };

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
}: {
  messages: readonly ChatMessage[];
  runIsOver: boolean;
  /** Rejects with a message the panel shows verbatim. */
  onSend: (text: string, images: readonly string[]) => Promise<void>;
}): ReactNode {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      setError(null);
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length !== files.length) {
        setError("only images can be attached");
      }
      const tooBig = images.find((file) => file.size > MAX_IMAGE_BYTES);
      if (tooBig !== undefined) {
        setError(`${tooBig.name} is larger than 8MB`);
        return;
      }
      void Promise.all(
        images.map(async (file) => ({ name: file.name, dataUrl: await readAsDataUrl(file) })),
      ).then((read) => {
        setAttachments((previous) => [...previous, ...read].slice(0, MAX_IMAGES));
      });
    },
    [],
  );

  const send = useCallback((): void => {
    const trimmed = text.trim();
    if (busy) return;
    if (trimmed === "" && attachments.length === 0) return;
    setBusy(true);
    setError(null);
    void onSend(
      trimmed,
      attachments.map((attachment) => attachment.dataUrl),
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
            placeholder="Tell it what to change. Paste or drop images to show it an example."
            className="w-full resize-y rounded-sm border border-line bg-canvas px-2 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />

          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {attachments.map((attachment, index) => (
                <li
                  key={`${attachment.name}:${String(index)}`}
                  className="flex items-center gap-1 rounded-sm border border-line px-1.5 py-[2px] text-[10.5px] text-ink-dim"
                >
                  <span className="max-w-[120px] truncate">{attachment.name}</span>
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
              attach images
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
          </div>

          {/* The promise, stated once, where the expectation is set. */}
          <p className="text-[10.5px] leading-relaxed text-ink-faint">
            Goes into the running session and is picked up at the agent's next step —
            the same as typing here in the terminal while it works. Images are read
            before it acts on them. The acceptance suite is already frozen, so ask for
            changes it is indifferent to; anything contradicting a sealed criterion is
            reported rather than silently traded away.
          </p>
        </fieldset>
      </div>
    </section>
  );
}
