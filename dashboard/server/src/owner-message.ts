/**
 * owner-message.ts — BOTH DIRECTIONS OF THE CHAT'S TEXT LAYER.
 *
 * Outbound (`ownerMessageBlock`): the owner's mid-flight instructions, rendered
 * as a prompt block. Inbound ({@link AgentReplyWatch}): what the agent said back,
 * captured off the builder's raw transcript seam and stored as a `run` message —
 * or NOT stored, which is the harder half and is argued at that class.
 *
 * WHAT THIS IS FOR. The dashboard now has an owner↔run chat (`messages` table,
 * `POST /api/runs/:id/messages`). This turns the messages a run has not seen yet
 * into text the next segment's prompt carries, at the segment boundary — see the
 * drain in `orchestrator.ts`.
 *
 * THE HARD PART IS NOT THE WIRING, AND IT IS ADDRESSED HERE RATHER THAN IGNORED.
 *
 * The acceptance suite is authored before any code exists and FROZEN BY CONTENT
 * DIGEST, and `heldOutPass` means "the suite the builder never saw went green". A
 * mid-run instruction can therefore contradict a criterion that is already sealed,
 * and there are only bad ways to resolve that silently:
 *
 *   - grading against the original suite fails a run for correctly doing what it was
 *     just told;
 *   - re-authoring the suite mid-run destroys the property the whole tool exists
 *     for, because a suite written after the redirection is no longer one the builder
 *     never saw.
 *
 * SO THE RUN IS TOLD, IN THE PROMPT, THAT THE SUITE IS FIXED. The instruction is
 * accepted for anything the suite is agnostic about — art direction, copy tone,
 * which reference to follow, how something looks — and the builder is told to say so
 * in its summary rather than silently trade a sealed criterion away. That keeps
 * `heldOutPass` meaning exactly what it has always meant. It is a deliberate,
 * conservative default and NOT the final answer: the owner has been asked to choose
 * between this, a recorded two-phase freeze, and dropping the single boolean.
 * `docs/FINDINGS-2026-07-30-canvas-asks.md` carries the three options.
 *
 * The alternative — letting a chat message quietly redefine what "passed" means —
 * is the one outcome this codebase refuses everywhere else.
 */

import type { ChatMessage, ChatRole } from "./db.js";

/** Heading the builder sees. Distinctive so it is greppable in a prompt dump. */
export const OWNER_MESSAGE_HEADING = "THE OWNER HAS SENT INSTRUCTIONS MID-RUN";

/**
 * Render pending owner messages as a prompt block, or `""` when there are none.
 *
 * RETURNS THE EMPTY STRING FOR AN EMPTY LIST, so the caller can append it
 * unconditionally — the same shape `videoPrompt` already uses in the orchestrator,
 * and the reason there is no `if` at the call site to forget.
 */
export function ownerMessageBlock(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) return "";

  const lines: string[] = [
    "",
    "",
    `--- ${OWNER_MESSAGE_HEADING} ---`,
    "",
    "These arrived after this run started, from the person who wrote the ticket.",
    "They are instructions, not information: act on them in the work that follows.",
    "",
  ];

  for (const message of messages) {
    lines.push(`[${message.at}] ${message.text}`);
    if (message.images.length > 0) {
      /*
       * THE PATHS ARE ABSOLUTE AND THE READ IS ASKED FOR EXPLICITLY.
       *
       * Same mechanism as the design refs (§7.3 mechanism 2): a path mentioned in a
       * prompt is what makes a `Read` actually happen. Naming the files without
       * telling it to open them produces a run that acknowledges an attachment it
       * never looked at.
       */
      lines.push(
        `  The owner attached ${String(message.images.length)} image(s). Read each one before acting on the message above:`,
        ...message.images.map((path) => `    ${path}`),
      );
    }
    lines.push("");
  }

  lines.push(
    "WHAT YOU MAY AND MAY NOT CHANGE.",
    "",
    "The acceptance suite for this run was written before any code existed and is",
    "FROZEN — it cannot be edited, and you cannot see the half of it you are graded",
    "on. So:",
    "",
    "  - Apply the instruction wherever the suite is indifferent to it: art",
    "    direction, palette, copy tone, layout, which reference to follow, polish.",
    "  - If an instruction CONTRADICTS something the ticket originally asked for —",
    "    removing a section, dropping a feature, changing what a form does — do the",
    "    part you safely can, keep the original requirement working, and SAY SO",
    "    PLAINLY in your final summary, naming the conflict.",
    "  - Never delete or weaken a test to make an instruction fit. A suite edited to",
    "    match the work is the one failure this tool exists to catch.",
    "",
    "Reporting the conflict is a success, not a refusal: it is how the owner finds out",
    "the brief and the sealed criteria have diverged.",
    "",
  );

  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * THE REPLY CHANNEL — the other direction, which did not exist until 2026-07-31
 *
 * THE FAILURE IT CLOSES, MEASURED. The owner typed "Give me the link to the
 * website" into run `run-2026-07-30T20-16-40-242Z-052c6e02`. The row shows it was
 * delivered and stamped read at 05:49:32Z. NOTHING CAME BACK — not because the
 * agent said nothing, but because no code path could turn anything it said into a
 * `messages` row. He noticed and said so. The `run` direction has been in the type
 * and in the client's mirror since the table existed; it had no producer.
 * ---------------------------------------------------------------------- */

/**
 * The exact prefix both builders put in front of an assistant turn on the RAW
 * seam — `builders/claude-builder.ts:1454` and `builders/codex-builder.ts:94`,
 * both spelled `sink.raw("\n[assistant]\n" + text + "\n")`.
 *
 * WHY THE RAW SEAM AND NOT `log`. `BuildEventSink` has exactly one channel that
 * carries an assistant turn's own words, and `raw` is it: the Anthropic driver
 * also sends the same text to `sink.log` but TRUNCATED AT 500 CHARACTERS and
 * indistinguishable there from the twenty other things that log info — session
 * start, environment description, context samples. A reply assembled from `log`
 * would be a clipped sentence attributed to the agent, which is the kind of quiet
 * inaccuracy this file exists to avoid. `raw` carries the turn whole and tags it.
 *
 * IT IS A THIRD SPELLING OF A LITERAL THAT LIVES IN TWO DRIVER FILES, AND THAT IS
 * A REAL DRIFT RISK RATHER THAN A THEORETICAL ONE: neither driver is in a
 * position to import this constant today, and a driver that changed its tag would
 * silently stop producing replies with every test still green — the reply would
 * simply never be found, and "the run did not answer" is exactly what the UI says
 * for that case. `messages.test.ts` therefore READS BOTH DRIVER FILES AS TEXT and
 * asserts they still contain this string. That is a source-parity check, the same
 * device `contract-parity.test.ts` uses across the two packages, and it is the
 * only thing available that can go red for this.
 *
 * NO OTHER `raw` WRITER STARTS WITH IT: the other tags in those two files are
 * `[command]`, `[patch …]`, `[reasoning]` and `[result]`.
 */
export const ASSISTANT_RAW_PREFIX = "\n[assistant]\n";

/**
 * How much of the agent's last message is stored as the reply.
 *
 * A CAP, NOT A SUMMARY. Nothing here paraphrases, re-prompts or asks a model to
 * shorten anything — the reply is the agent's own words or it is nothing. A wrap-up
 * turn is normally a few hundred characters; a long one is cut at this bound with
 * {@link REPLY_TRUNCATION_NOTE} appended, so a clipped reply reads as clipped
 * rather than as a complete answer that happened to stop mid-sentence.
 *
 * 2000, matching `ApiAdversaryPass.stopDetail`, which truncates model-written prose
 * on the same reasoning and is the only other bound of this kind in the contract.
 */
export const REPLY_MAX_CHARS = 2000;

/**
 * What a truncated reply says about itself, and where the whole of it went.
 *
 * THE POINTER IS CHECKABLE. `sink.raw` hands every chunk to `BuildLog.write`
 * (`orchestrator.ts`), which appends it to `runs/<id>/results/build.log`, so the
 * untruncated turn really is written to disk under the run directory. It names
 * that file rather than gesturing at "the logs" precisely so the claim can be
 * checked — and so it goes stale visibly if the wiring changes.
 *
 * "WAS WRITTEN TO", NOT "IS IN", AND THE TENSE IS THE HONEST PART. `BuildLog`'s
 * constructor TRUNCATES the file, and it is constructed once per `#execute` — so a
 * run that is resumed after a rate limit starts a fresh `build.log` and the earlier
 * segment's transcript is gone. The note would then point at a file that no longer
 * holds the text. Past tense states what this program actually did; a present-tense
 * promise about a file it does not own would be exactly the overclaim the reply
 * channel is built to avoid.
 */
export const REPLY_TRUNCATION_NOTE =
  `\n\n[…cut at ${String(REPLY_MAX_CHARS)} characters. The whole turn was written to this run's results/build.log.]`;

/**
 * The one thing this module needs from `RunStore`, declared structurally.
 *
 * A STRUCTURAL SUBSET RATHER THAN THE CLASS, so `messages.test.ts` can drive the
 * whole raw-chunk→durable-row path against a real `RunStore` while a future caller
 * that only has a writer is not forced to construct one. It is deliberately NOT
 * widened to the rest of the store: this module may append a message and may do
 * nothing else.
 */
export interface ReplyStore {
  appendMessage(
    runId: string,
    message: { role: ChatRole; text: string; images: readonly string[] },
  ): ChatMessage;
}

/**
 * Watches one build segment's raw transcript and stores THE AGENT'S OWN LAST
 * MESSAGE as its reply — or stores nothing at all.
 *
 * ============================================================
 * THE HONESTY LINE, WHICH IS THE WHOLE DESIGN OF THIS CLASS.
 * ============================================================
 *
 * ONLY TEXT THE AGENT ACTUALLY PRODUCED IS EVER STORED. There is no fallback, no
 * "Working on it…", no server-composed acknowledgement, and {@link record} returns
 * `null` rather than inventing one. A fabricated reply in a channel the owner reads
 * as the run speaking is strictly worse than silence: silence is visible and
 * correct — the UI can say the run did not answer — while a synthesised line is
 * indistinguishable from a real one and teaches him to trust the next one too.
 * `messages.test.ts` asserts the ABSENCE of a row for a segment that produced no
 * assistant text, with a positive control in the same test so an inert watch cannot
 * pass it.
 *
 * WHAT IT STORES, STATED EXACTLY, BECAUSE IT IS EASY TO OVERCLAIM. The last
 * TEXT-BEARING assistant turn of the segment, verbatim, capped. On a segment that
 * ran to a result that is NORMALLY the agent's own wrap-up — the message a human
 * reading the CLI would treat as the answer — but it is not guaranteed to be:
 * `claude-builder.ts:1451-1456` emits on this seam only when the turn has text, so
 * a final turn that is nothing but tool calls emits nothing and the last chunk
 * captured is whatever the agent last narrated ("now I'll update the CSS"). On a
 * segment cut short by a cancel or a rate limit it is simply the last thing the
 * agent said, which may be mid-thought and may not address the question at all. It
 * is NOT a transcript (one turn, not the stream), NOT a generated summary (nothing
 * is re-prompted), and NOT a guarantee that the question was answered.
 *
 * WHY THE LAST TURN AND NOT THE FIRST ONE AFTER THE QUESTION. The first turn after
 * an instruction lands is usually an acknowledgement followed by an hour of tool
 * calls; the last one is where the agent says what it did. Neither is "the answer"
 * by construction, and picking the one that is a summary at least as often as not
 * is the honest trade — recorded here rather than left to be inferred from the code.
 *
 * WHY A REPLY IS GATED ON THE OWNER HAVING SPOKEN. See {@link record}: without the
 * gate every segment would post its wrap-up into the chat, which is the wall of
 * text this channel is supposed to be an alternative to, and would put a "reply"
 * under a conversation that has no question in it.
 *
 * ONE INSTANCE PER SEGMENT. It holds one string and no store reference; a caller
 * that reuses one across segments would carry segment 1's last words into segment
 * 2's reply, which is why `orchestrator.ts` constructs it beside the sink.
 */
export class AgentReplyWatch {
  #last: string | null = null;

  /**
   * Take one raw chunk from `BuildEventSink.raw`.
   *
   * A CHUNK IS A WHOLE TURN, NOT A STREAM FRAGMENT: both drivers build the entire
   * `"\n[assistant]\n" + text + "\n"` string and pass it in one call, so nothing
   * here reassembles anything, and a chunk that does not start with the tag is
   * some other record (`[command]`, `[patch]`, `[reasoning]`, `[result]`) and is
   * ignored.
   *
   * AN EMPTY ASSISTANT BLOCK DOES NOT COUNT AND DOES NOT CLEAR. The Codex driver
   * emits the tag unconditionally, so an item with no text produces
   * `"\n[assistant]\n\n"`; treating that as "the agent's last message" would
   * replace a real reply with an empty one, and treating it as a reset would
   * discard a real reply for a blank. It is skipped.
   */
  observe(chunk: string): void {
    if (!chunk.startsWith(ASSISTANT_RAW_PREFIX)) return;
    const text = chunk.slice(ASSISTANT_RAW_PREFIX.length).trim();
    if (text.length === 0) return;
    this.#last = text;
  }

  /** The agent's last message so far, untruncated, or `null` if it has said nothing. */
  get lastSaid(): string | null {
    return this.#last;
  }

  /**
   * Store the reply, or store NOTHING and say so by returning `null`.
   *
   * THREE WAYS TO GET `null`, AND ALL THREE ARE CORRECT OUTCOMES RATHER THAN
   * ERRORS:
   *
   *   1. `ownerMessages === 0` — the owner said nothing to this segment, so there
   *      is nothing to reply to. The agent's wrap-up is still on the event stream
   *      and in the build log; it does not belong in a conversation that has no
   *      question in it.
   *   2. the segment produced no assistant text — nothing was said, so nothing is
   *      stored. THIS IS THE CASE THE UI MUST BE ALLOWED TO SHOW AS "the run did
   *      not answer", and the reason there is no fallback string anywhere below.
   *   3. it was already recorded — the reply is consumed on the way out, so a
   *      double call is a no-op instead of a duplicated row in the owner's chat.
   *
   * `ownerMessages` COMES FROM `RunStore.ownerMessagesDeliveredSince`, counted from
   * an instant captured BEFORE the segment's boundary drain. That covers both ways
   * an instruction reaches a run — the drain and the live push — because both stamp
   * `delivered_at`, and it is durable, so a segment that resumes after a restart
   * still knows it was spoken to. It is passed IN rather than queried here so this
   * class needs nothing from the store but a writer.
   *
   * THE ROW IS REDACTED ON THE WAY IN by `RunStore.appendMessage`, like every other
   * persisted string. The text is model-written prose about a live workspace: that
   * chokepoint replaces credential-shaped spans and is pattern-based, which is not
   * a guarantee about content.
   */
  record(store: ReplyStore, runId: string, ownerMessages: number): ChatMessage | null {
    if (ownerMessages <= 0) return null;
    const said = this.#last;
    if (said === null) return null;
    this.#last = null;
    const text =
      said.length <= REPLY_MAX_CHARS
        ? said
        : said.slice(0, REPLY_MAX_CHARS) + REPLY_TRUNCATION_NOTE;
    // NO IMAGES. The agent has no way to attach one on this channel: `raw` carries
    // text, and a path it happened to mention is a path, not an attachment. An
    // empty array here is the true state rather than a placeholder.
    return store.appendMessage(runId, { role: "run", text, images: [] });
  }
}
