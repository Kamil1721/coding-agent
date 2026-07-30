/**
 * owner-message.ts — the owner's mid-flight instructions, as a prompt block.
 *
 * WHAT THIS IS FOR. The dashboard now has an owner→run chat (`messages` table,
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

import type { ChatMessage } from "./db.js";

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
