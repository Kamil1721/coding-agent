/**
 * live-input.ts — the open channel into a RUNNING agent session.
 *
 * WHAT THIS REPLACES. The owner's chat used to be applied only at a segment
 * boundary, because `SessionFactory` narrowed the SDK's
 * `prompt: string | AsyncIterable<SDKUserMessage>` down to `string`, and a
 * single-shot string has nowhere to put a second message. The narrowing was ours;
 * the SDK has supported streaming input all along.
 *
 * WHAT IT DOES. Yields the segment prompt as the first user message, then STAYS OPEN
 * and yields each queued owner message as it arrives — so typing into the dashboard
 * while a run works behaves the way typing into the interactive CLI does.
 *
 * `shouldQuery: false` IS THE DEFAULT, AND IT IS THE SAFER OF THE TWO. The SDK
 * documents it as "appended to the transcript without triggering an assistant turn.
 * It will be merged into the next user message that does query." That is the
 * terminal's feel — the message lands between steps rather than interrupting one —
 * and it cannot arrive in the middle of a tool call. `priority: 'next'` is the
 * alternative and is offered, not assumed.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO PREVENT is a generator that RETURNS after
 * yielding the first prompt. The SDK ends the session when the input iterable
 * completes, so an early return produces a run that stops after one turn with no
 * error anywhere — the session simply ends, and the log looks like a short run
 * rather than a broken one. Everything below is arranged so that path is impossible
 * to take by accident, and `live-input.test.ts` asserts the generator is still
 * pending after the first yield rather than asserting only on what it emitted.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A message the host wants to push into a live session. */
export interface LiveMessage {
  readonly text: string;
  /** Absolute paths. Named in the text so the agent is told to Read them. */
  readonly images: readonly string[];
}

/**
 * How a queued message is delivered.
 *
 * - `merge` — `shouldQuery: false`: lands in the transcript and is folded into the
 *   agent's next turn. The interactive CLI's behaviour, and the default.
 * - `next`  — `priority: 'next'`: queued to run as its own turn after the current
 *   one finishes.
 */
export type Delivery = "merge" | "next";

/** Wrap text and image paths as an `SDKUserMessage`. */
export function userMessage(
  text: string,
  delivery: Delivery,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(delivery === "merge" ? { shouldQuery: false } : { priority: "next" as const }),
  };
}

/**
 * The text an owner message becomes inside a live session.
 *
 * Images are named with ABSOLUTE paths and an explicit instruction to open them —
 * the same mechanism the design refs use (§7.3 mechanism 2). Naming a file without
 * telling the agent to read it produces a run that acknowledges an attachment it
 * never looked at.
 */
export function liveMessageText(message: LiveMessage): string {
  const lines = [`THE OWNER JUST SENT THIS, MID-RUN:`, "", message.text];
  if (message.images.length > 0) {
    lines.push(
      "",
      `They attached ${String(message.images.length)} image(s). Read each one before acting:`,
      ...message.images.map((path) => `  ${path}`),
    );
  }
  lines.push(
    "",
    "Apply it where the frozen acceptance suite is indifferent (art direction, copy,",
    "layout, which reference to follow). If it contradicts something the ticket",
    "originally required, do what you safely can, keep the requirement working, and say",
    "so in your summary. Never weaken a test to make it fit.",
  );
  return lines.join("\n");
}

/**
 * A queue whose async iterator stays open until `close()` is called.
 *
 * Deliberately NOT an `async function*` over a snapshot array: that shape completes
 * as soon as the array is exhausted, which ends the SDK session. This one parks on a
 * promise instead, so "no messages right now" is a WAIT, never an end.
 */
export class LiveInput {
  readonly #pending: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  /** The first message the session receives. */
  constructor(firstPrompt: string) {
    this.#pending.push({
      type: "user",
      message: { role: "user", content: firstPrompt },
      parent_tool_use_id: null,
    });
  }

  /** Push an owner message into the live session. No-op once closed. */
  push(message: LiveMessage, delivery: Delivery = "merge"): boolean {
    if (this.#closed) return false;
    this.#pending.push(userMessage(liveMessageText(message), delivery));
    this.#wake?.();
    return true;
  }

  /**
   * End the input stream, which ends the session.
   *
   * MUST BE CALLED, and from a `finally`. A session whose input is never closed
   * keeps the subprocess alive after the segment is done.
   */
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  /** True once `close()` has run. Read by the host to refuse a late push. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Messages queued and not yet handed to the SDK.
   *
   * READ AT THE TERMINAL `result` FRAME, to decide whether the segment is over.
   * A turn that ends with something still queued is not over — the owner spoke
   * while the model was working and the SDK has another turn to run. A turn that
   * ends with an empty queue IS over, and the channel must close or the session
   * never ends. See the deadlock note in `claude-builder.ts`'s result branch.
   */
  get pending(): number {
    return this.#pending.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      // PARK. This is the line that keeps the session open — without it the
      // iterator completes on an empty queue and the SDK ends the turn loop.
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}
