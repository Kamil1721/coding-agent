"use client";

/**
 * diff.tsx — one applied file edit, as green added lines and red removed lines.
 *
 * THE OWNER'S ASK, VERBATIM: "when it starts editing it shows the added green
 * lines and taken away red lines etc". The data has been on the wire since the
 * SDK computed it — `FileEditOutput.structuredPatch` — and reached `GraphState`
 * as `GraphActivityEntry.diff` in the wave before this one. Nothing here derives
 * a patch; it draws the one the CLI already made.
 *
 * FOUR DECISIONS, AND EACH HAD AN EASIER WRONG ANSWER.
 *
 * 1. THE PREFIX CHARACTER IS THE SIGNAL; THE COLOUR IS THE SECOND SIGNAL.
 *    `structuredPatch.lines` carries the literal `" "` / `"+"` / `"-"` the SDK
 *    wrote, so a line's class is a `startsWith` on the text a reader can see
 *    rather than a parallel array of flags that can disagree with it. The
 *    prefixes are never stripped: a reader who cannot separate #4ade80 from
 *    #f87171 — about one man in twelve — still reads the patch, and so does
 *    anyone who copies the block into a terminal.
 *
 * 2. ONE ELEMENT PER LINE, WHICH IS THE OPPOSITE OF `code-browser.tsx`. That
 *    file puts a whole file in ONE text node on purpose, because a 256 KB file
 *    is ~8,000 lines and 8,000 `<div>`s is a stuttering scroll (its decision 2).
 *    The trade is different here for a measured reason: `DIFF_MAX_LINES` is 80
 *    and `DIFF_MAX_HUNKS` is 12, the server caps every diff to that before it is
 *    ever serialised, and per-line colour is the entire feature. 80 elements is
 *    not 8,000.
 *
 * 3. `whitespace-pre`, NEVER `pre-wrap` — also `code-browser.tsx`'s rule, and
 *    kept for the same reason plus one more: a wrapped `-` line would start its
 *    second visual row with no prefix, which is exactly the case where colour
 *    becomes the only signal. Horizontal scroll is the honest trade, and it is
 *    MEASURED rather than asserted: a 160-character line has to leave this
 *    block's own scroller with a scroll range, which goes to zero the moment the
 *    scroller is deleted. See the note at the scroller for the three forms of
 *    the stronger "nothing is painted outside" check that were thrown away
 *    rather than kept as decoration — two of them could not go red at all, and
 *    the third went red on a neighbour's layout in both builds.
 *
 * 4. THE CAP IS STATED ON SCREEN, IN NUMBERS. `GraphDiff.additions` and
 *    `deletions` always count the WHOLE patch; `hunks` is what fitted the wire
 *    budget. A partial diff drawn as if it were whole is a lie of exactly the
 *    kind this repository keeps shipping, so when `capped` is true this block
 *    says how much is missing and says that the counts above are of the whole.
 *    `capped` is deliberately NOT `droppedLines > 0` — a single 40,000-character
 *    minified line cut to 160 characters loses half the patch with nothing
 *    missing from the line COUNT — so the "a line was cut short" branch below is
 *    the one that case lands in, and it is not silence.
 *
 * WHAT THIS CAN NEVER SHOW, and why it is a sentence in the UI rather than a
 * comment here: an edit made through `Bash` — `sed -i`, a heredoc, `npm init` —
 * produces no `FileEditOutput` and therefore no patch, ever. See
 * {@link ShellEditNote}. A file that changed with no card here is not a bug, and
 * a list that implies otherwise is the same defect as a capped diff drawn whole.
 *
 * `[REDACTED:HIGH_ENTROPY_TOKEN]` INSIDE A LINE IS THE REDACTOR WORKING, on a
 * lockfile integrity hash or a minified bundle, and is rendered verbatim.
 * "Repairing" it would be a credential leak.
 */

import type { ReactNode } from "react";

import type { GraphDiff, GraphDiffHunk } from "@/lib/api-types";
import { cx } from "@/components/ui";

type LineClass = "added" | "removed" | "context";

/**
 * The SDK's own encoding, read off the first character.
 *
 * A `\` line (`\ No newline at end of file`) and an empty string are context:
 * neither adds nor removes anything, and dressing either in a colour would state
 * a change the patch does not contain.
 */
function classOf(line: string): LineClass {
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

const LINE_CLASS: Readonly<Record<LineClass, string>> = {
  added: "bg-pass-dim/70 text-pass",
  removed: "bg-fail-dim/70 text-fail",
  context: "text-ink-dim",
};

/** The unified-diff header a reader of `git diff` already knows how to read. */
function hunkHeader(hunk: GraphDiffHunk): string {
  return `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`;
}

function countLines(hunks: readonly GraphDiffHunk[]): number {
  return hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

/**
 * What is missing, in numbers, or nothing at all.
 *
 * THE THREE CAPPED CASES ARE THREE DIFFERENT SENTENCES, because they are three
 * different facts: whole hunks withheld, lines withheld inside a kept hunk, and
 * a line shown cut short with the line count still complete. A single "truncated"
 * would erase the third, which is the one nobody expects.
 */
function CappedNotice({ diff }: { diff: GraphDiff }): ReactNode {
  if (!diff.capped) return null;

  const shown = countLines(diff.hunks);
  const total = shown + diff.droppedLines;
  const clauses: string[] = [];

  if (diff.droppedLines > 0) {
    clauses.push(`Showing ${String(shown)} of ${String(total)} lines.`);
  }
  if (diff.droppedHunks > 0) {
    clauses.push(
      `${String(diff.droppedHunks)} further ${diff.droppedHunks === 1 ? "hunk is" : "hunks are"} not shown.`,
    );
  }
  if (diff.droppedLines === 0 && diff.droppedHunks === 0) {
    // The only remaining way `capped` can be true: a line longer than the
    // server's per-line budget was shown cut short. Nothing is missing from the
    // COUNT, which is why this case needs a sentence of its own.
    clauses.push("A line was too long and is shown cut short.");
  }

  return (
    <p
      data-testid="diff-capped"
      className="border-t border-warn/40 bg-warn-dim/60 px-2 py-1 text-[11px] leading-snug text-ink-dim"
    >
      Part of this patch is not shown. {clauses.join(" ")} The counts above are of the whole
      edit.
    </p>
  );
}

/**
 * One applied edit: what changed, by how much, and the lines themselves.
 *
 * `tool` is the recorded tool name (`Edit`, `Write`) — passed in rather than
 * inferred from `change`, because the two answer different questions and a
 * `Write` over an existing file is a `modified`.
 */
export function FileDiff({ diff, tool }: { diff: GraphDiff; tool: string }): ReactNode {
  const shown = countLines(diff.hunks);

  return (
    <div
      data-testid="diff"
      data-diff-path={diff.path}
      className="min-w-0 overflow-hidden rounded-sm border border-line bg-canvas/60"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 border-b border-line px-2 py-1">
        <span
          data-testid="diff-path"
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink"
          title={diff.path}
        >
          {diff.path}
        </span>
        <span className="numeric shrink-0 font-mono text-[11px] tabular-nums">
          {/*
            * ASCII `+` AND `-`, NOT `−` (U+2212). These are the same two
            * characters the patch lines below are prefixed with, and a reader
            * scanning for `-3` in a terminal-shaped panel should find the glyph
            * they typed. The `title`s are the non-colour reading of the same
            * two numbers.
            */}
          <span data-testid="diff-additions" className="text-pass" title={`${String(diff.additions)} lines added`}>
            +{diff.additions}
          </span>{" "}
          <span data-testid="diff-deletions" className="text-fail" title={`${String(diff.deletions)} lines removed`}>
            -{diff.deletions}
          </span>
        </span>
        <span className="w-full text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          {tool} · {diff.change === "added" ? "new file" : "modified"}
        </span>
      </header>

      {diff.hunks.length === 0 ? (
        <p className="px-2 py-1.5 text-[11px] leading-snug text-ink-faint">
          {diff.capped
            ? "No lines are shown for this edit — this agent's per-node budget for patch bodies was already spent. The counts above are still exact."
            : "This edit arrived with no patch body. The counts above are all that was recorded."}
        </p>
      ) : (
        /*
         * THE SCROLLER. Both axes, and capped in height so a 12-hunk patch does
         * not push everything under it off the panel.
         *
         * WHAT WAS MEASURED, because the first version of this comment claimed
         * more than the measurement supported. It said `min-w-0` on the ancestors
         * is what stops "the sheet — then the page — scrolling sideways". The
         * page half is not observable at all: the sheet is `absolute` inside a
         * canvas wrapper that is `relative h-full overflow-hidden`, so the
         * document's scroll width cannot move whatever happens in here. Removing
         * `min-w-0` from the timeline row, and removing this `overflow-auto`
         * outright, both left the document exactly as wide.
         *
         * WHAT IS REAL AND IS TESTED: with a 160-character line this element must
         * SCROLL — `scrollLeft` moves off zero, which is true of a scroll
         * container and false of a box whose content merely overflows. Delete the
         * `overflow-auto` and that goes to zero, which is the check. The stronger
         * claim — that nothing is PAINTED outside the card — could not be
         * measured from the harness. Three attempts and why each was worthless —
         * two that could not fail, one that failed on a NEIGHBOUR'S layout in
         * both builds — are recorded in `tests/diff-render.browser.spec.ts`.
         */
        <div data-testid="diff-scroller" className="max-h-[260px] min-w-0 overflow-auto">
          <ol className="w-max min-w-full font-mono text-[11px] leading-[16px]">
            {diff.hunks.map((hunk, hunkIndex) => (
              // The hunk's own coordinates are its identity; the index is the
              // tiebreak for a patch that legitimately repeats them.
              <li key={`${String(hunkIndex)}:${String(hunk.oldStart)}:${String(hunk.newStart)}`}>
                <p
                  data-testid="diff-hunk"
                  className="bg-surface-raised px-2 py-[1px] text-ink-faint"
                >
                  {hunkHeader(hunk)}
                </p>
                <ol>
                  {hunk.lines.map((line, lineIndex) => {
                    const kind = classOf(line);
                    return (
                      <li
                        key={`${String(hunkIndex)}:${String(lineIndex)}`}
                        data-diff-line={kind}
                        className={cx("whitespace-pre px-2", LINE_CLASS[kind])}
                      >
                        {/* The line INCLUDING its prefix, exactly as recorded.
                            An empty string still needs the row's height, hence
                            the zero-width space. */}
                        {line === "" ? "\u200b" : line}
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        </div>
      )}

      <CappedNotice diff={diff} />

      {/* A non-capped diff whose drawn lines cannot account for its counts would
          be a contradiction on screen with nothing to explain it. It should be
          impossible — the fold sets `capped` whenever it withholds anything — so
          it is reported rather than hidden. */}
      {!diff.capped && shown < diff.additions + diff.deletions && (
        <p
          data-testid="diff-inconsistent"
          className="border-t border-line px-2 py-1 text-[11px] leading-snug text-ink-faint"
        >
          This edit reports more changed lines than it carries, and was not marked as capped.
          The counts are what the patch stated.
        </p>
      )}
    </div>
  );
}

/**
 * THE PERMANENT CARVE-OUT, on screen rather than in a docblock.
 *
 * `structuredPatch` is produced by exactly two tool outputs — `FileEditOutput`
 * and `FileWriteOutput`. A file changed by a shell command has no structured
 * output at all, so no card above can ever exist for it, and `NotebookEdit`
 * carries `old_source`/`new_source` with no patch, so it cannot either. Without
 * this sentence the list of diffs reads as the complete list of edits, which is
 * the same class of untruth as drawing a capped patch whole.
 *
 * RENDERED WHEREVER DIFFS ARE, NOT ONLY WHEN A `Bash` PILL EXISTS.
 * `GraphNode.tools` is capped at `PILL_KINDS_CAP` distinct names, so the busiest
 * node — the one most likely to have edited through a shell — is precisely the
 * one whose `Bash` pill may have been dropped. The count is added only when it
 * is actually known.
 */
export function ShellEditNote({ bashCalls }: { bashCalls: number | null }): ReactNode {
  return (
    <p data-testid="diff-shell-note" className="text-[11px] leading-relaxed text-ink-faint">
      Only edits made with the file tools leave a patch.{" "}
      {bashCalls === null
        ? "A file changed by a shell command — sed -i, a heredoc, npm init — has no patch anywhere in the record and cannot appear above."
        : `This agent also ran Bash ${String(bashCalls)} ${bashCalls === 1 ? "time" : "times"}; anything it changed that way has no patch anywhere in the record and cannot appear above.`}
    </p>
  );
}
