"use client";

/**
 * WHERE THIS RUN'S CODE WENT — and, when something is there, what to do about it.
 *
 * `RunDetail.publishedProject` has been on the wire since the publish lane
 * landed and, before this component, was rendered NOWHERE: grep for it across
 * `src/` returned `api-types.ts` and one comment in `spec-pipeline.ts`. So the
 * one fact the owner asked for by name — "I don't have a file or a database to
 * work from" — was answered by the server and never drawn. This is the first
 * rendering of it, and it is a control rather than a caption: start the folder,
 * open it once it is serving, stop it.
 *
 * FOUR STATES OF THE RECORD, AND THEN A FIFTH THAT IS NOT ON IT.
 *
 *   null, run still going   Nothing to say yet. The copy is made when the run
 *                           reaches a terminal state, so this renders one quiet
 *                           line rather than an absence a reader has to interpret.
 *   null, run terminal      NO RECORD — the run finished before this lane
 *                           existed, or the record file could not be read. That
 *                           is NOT "it was attempted and declined" and must not
 *                           be drawn as one; the truth table in
 *                           `PublishedProject` exists for exactly this.
 *   published: false        ATTEMPTED AND DECLINED. `reason` names which refusal
 *                           and `detail` is the sentence, so both are printed.
 *   published: true         The copy was written. Path, file count, bytes.
 *
 * THE FIFTH IS THE FOLDER BEING GONE. `published: true` says a copy existed at
 * the instant `publishedAt` names — the type's own docblock says it claims
 * nothing about now, and the folder belongs to the owner, who may have moved or
 * deleted it. `GET /api/projects` is the only thing that knows, so the record is
 * joined to that list on `runId` and a record with no folder is drawn as MISSING
 * rather than as a start button that would 404.
 *
 * IT NEVER CLAIMS MISSING WHILE IT DOES NOT KNOW. If the projects list has not
 * arrived or the request failed, the path is shown with a line saying the list
 * could not be read. An unreachable API and a deleted folder are different
 * facts and this app has a habit of collapsing pairs like that.
 */

import { useMemo, type ReactNode } from "react";

import {
  ProjectControls,
  ProjectFailure,
  ProjectLogsDisclosure,
  ProjectStateChip,
  ProjectStateLine,
  hasRecordedOutput,
  useProjectControl,
} from "@/components/project/controls";
import { Explain } from "@/components/explain";
import { MonoPath, cx } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { isTerminalStatus, type Project, type RunDetail } from "@/lib/api-types";
// THE APP'S ONE BYTE FORMATTER, not a second one. This file shipped a local
// copy for one draft; `lib/attachments.ts` already exports exactly this — bytes
// under 1 KiB, a KB rung, then one decimal of MB — and its docblock records why
// the KB rung exists. Two formatters disagreeing about the same number on two
// tabs of the same sheet is a drift with no upside.
import { formatBytes } from "@/lib/attachments";
import { formatClock, formatInt } from "@/lib/format";
import { useProjects } from "@/lib/hooks";

/**
 * The same chrome as the row directly above it on this tab — the one carrying
 * the run's own workspace path — so the two paths read as a pair rather than as
 * two designs. That row is `canvas/sheet.tsx`'s, not this file's, and it has
 * been relabelled at least once (Artifact → Workspace), which is why this
 * comment names it by what it holds.
 */
function Block({
  label,
  explain,
  children,
  className,
}: {
  label: string;
  /** Optional sentence behind the label's glyph. Lowercase noun phrase in `about`. */
  explain?: { readonly about: string; readonly body: ReactNode };
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cx("min-w-0 rounded border border-line bg-surface px-3 py-2", className)}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
        {explain !== undefined && (
          <Explain about={explain.about} className="ml-1 normal-case" testId="explain-project">
            {explain.body}
          </Explain>
        )}
      </p>
      <div className="mt-1.5 min-w-0">{children}</div>
    </section>
  );
}

/**
 * THE REFUSAL, IN THE CLIENT'S OWN WORDS — one short line per name the server
 * uses.
 *
 * WHY THIS EXISTS RATHER THAN JUST PRINTING `detail`. The server's `detail` is a
 * SENTENCE ABOUT A PATH: for `workspace-empty` it reads "the workspace at
 * /Users/…/runs/run-2026-…/workspace holds no publishable file — 0 entries were
 * excluded and nothing else was there. A run cancelled before the builder wrote
 * anything looks exactly like this." That is four rendered lines narrating an
 * absolute host path which this same tab already prints as a copyable field, and
 * it is the block the owner screenshotted.
 *
 * THE SENTENCES ARE THE SERVER'S OWN, COMPRESSED, NOT INVENTED — each is the
 * `PublishDecline` docblock line for that name (`server/src/project-publish.ts`,
 * the union at `PublishDecline`). Keeping them in step matters more than keeping
 * them short: if the server ever means something else by one of these names, this
 * map is wrong in a way no test here would catch.
 *
 * AN UNKNOWN NAME FALLS BACK TO `detail`, which is why the type is `string` on
 * both sides. A newer server's fifth refusal must not render as a blank block.
 */
const DECLINE_LINE: Readonly<Record<string, string>> = {
  "workspace-missing": "There was no workspace directory to copy.",
  "workspace-empty": "The run left no file worth copying.",
  "no-free-name": "Every candidate folder name was taken. Nothing was overwritten.",
  "copy-failed": "The filesystem refused part-way through.",
  "run-not-terminal": "The run is still going, so its files are still changing.",
};

/**
 * THE JOIN, `runId` FIRST.
 *
 * The server discovered `Project.runId` by reading each run's own publish
 * record, which is the same file this run's `publishedProject` came from, so it
 * is the exact key. The path comparison is a FALLBACK and not decoration: the
 * runner realpaths its side (`resolveProjectDir`) and the publisher does not, so
 * on a symlinked projects root the two strings name one folder and differ.
 */
function findProject(
  projects: readonly Project[],
  runId: string,
  path: string,
): Project | null {
  return (
    projects.find((project) => project.runId === runId) ??
    projects.find((project) => project.path === path) ??
    null
  );
}

export function PublishedProjectPanel({ run }: { run: RunDetail }): ReactNode {
  const record = run.publishedProject ?? null;
  const { data, error, mutate } = useProjects();
  const control = useProjectControl(mutate);

  const project = useMemo((): Project | null => {
    if (data === undefined || record === null || !record.published) return null;
    return findProject(data.projects, run.runId, record.path);
  }, [data, record, run.runId]);

  if (record === null) {
    if (!isTerminalStatus(run.status)) {
      // "…copied to `projects/` and this becomes somewhere to start it from" is
      // DELETED: it describes what the block will look like after an event the
      // reader is waiting on, and when that event happens the block says it
      // itself, with a path and a start button. "Terminal state" went with it —
      // the plain words for it are "when the run ends".
      return (
        <Block label="Project">
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Not copied out yet — the copy is made when the run ends.
          </p>
        </Block>
      );
    }
    return (
      /*
       * "No copy was recorded" IS THE WHOLE LINE, AND THE DISTINCTION IS BEHIND
       * THE GLYPH.
       *
       * MOVED: "that is not the same as a refusal". This file's own header
       * insists no-record and refused may never be drawn the same way, and they
       * are not — a refusal is a warn-toned block naming which refusal. But a
       * reader trying to work out WHY there is nothing here needs the difference,
       * and it changes what they do next: there is no publisher decision to
       * argue with, so the move is to re-publish, not to fix a refusal.
       *
       * DELETED: "The workspace itself is still on disk at the artifact path
       * above." That path is a labelled field with a copy button directly above
       * this block (`canvas/sheet.tsx`, the Result panel); a sentence pointing
       * at a field the reader can already see is the caption this pass removes.
       */
      <Block
        label="Project"
        explain={{
          about: "no copy on record",
          body: (
            <>
              This is not a refusal — there is no record either way. A run that finished
              before copies were made, or one whose record could not be read, looks like
              this.
            </>
          ),
        }}
      >
        <p className="text-[12px] leading-relaxed text-ink-dim">
          No copy was recorded for this run.
        </p>
      </Block>
    );
  }

  if (!record.published) {
    const line = DECLINE_LINE[record.reason];
    return (
      <Block label="Project" className="border-warn/45 bg-warn-dim/40">
        <p className="text-[12px] font-semibold text-ink">
          Nothing was copied
          <span className="ml-1.5 font-mono text-[11px] font-normal text-warn">
            {record.reason}
          </span>
        </p>
        {/*
         * ONE SHORT LINE INSTEAD OF THE SERVER'S PARAGRAPH — and the paragraph
         * is still one click away rather than gone.
         *
         * `record.detail` is machine-written prose that narrates an absolute
         * host path, and on the run the owner screenshotted it rendered as four
         * lines restating the artifact field above it. It is not DELETED because
         * it is the only place some refusals say anything specific — `copy-failed`
         * puts the filesystem's own error in there — so it goes into a shut
         * disclosure, in the same register as `OutcomeNotice`'s "Last recorded
         * cause": a record of what the server wrote, not a sentence written for a
         * reader.
         *
         * A REASON THIS BUILD DOES NOT KNOW STILL GETS `detail` INLINE. That is
         * the branch the `string` type exists for, and hiding the only text a
         * newer server sent would leave a block that says nothing at all.
         */}
        {line === undefined ? (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{record.detail}</p>
        ) : (
          <>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{line}</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-[11.5px] text-ink-faint marker:text-ink-faint">
                What the publisher recorded
              </summary>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">
                {record.detail}
              </p>
            </details>
          </>
        )}
        {/*
         * "Nothing was written to `projects/`; the run's own workspace is
         * untouched" is DELETED. Both clauses say that a refusal did not do
         * anything, which is what a refusal is — and the heading directly above
         * now reads "Nothing was copied" in as many words.
         */}
        <p className="mt-1 text-[11.5px] text-ink-faint">
          Attempted {formatClock(record.attemptedAt)}.
        </p>
      </Block>
    );
  }

  const pending = project === null ? false : control.isPending(project.slug);
  const failure = project === null ? null : control.failureOf(project.slug);

  return (
    <Block label="Project">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          {project !== null && (
            <div className="mb-1.5">
              <ProjectStateChip project={project} pending={pending} />
            </div>
          )}
          <MonoPath path={record.path} max={80} />
          <p className="mt-1 text-[11.5px] text-ink-faint">
            {formatInt(record.fileCount)} file{record.fileCount === 1 ? "" : "s"} ·{" "}
            {formatBytes(record.bytes)} · copied {formatClock(record.publishedAt)}
            {record.excluded.length > 0 && (
              <>
                {" · "}
                <span
                  title={record.excluded
                    .map((entry) => `${entry.path} — ${entry.reason}`)
                    .join("\n")}
                >
                  {record.excluded.length} entr
                  {record.excluded.length === 1 ? "y" : "ies"} left behind
                </span>
              </>
            )}
          </p>
        </div>
        {project !== null && <ProjectControls project={project} control={control} />}
      </div>

      {project !== null && (
        <div className="mt-1.5 space-y-1.5">
          <ProjectStateLine project={project} pending={pending} />
          {failure !== null && <ProjectFailure message={failure} />}
          {hasRecordedOutput(project, failure !== null) && (
            <ProjectLogsDisclosure slug={project.slug} />
          )}
        </div>
      )}

      {/*
       * THE FOLDER IS GONE. Said plainly, with the one thing that is still true
       * underneath it: the run's workspace is evidence and is never moved, so
       * the code exists even when this copy does not.
       *
       * DELETED: "it is yours, and nothing here removes it". Reassurance about
       * an action nobody took, on the one line whose job is to say the folder is
       * missing. KEPT INLINE: where the code still is — it is the reader's only
       * route to the work from this state, and a warn-toned line is read.
       */}
      {project === null && data !== undefined && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-warn">
          That folder is not there now &mdash; moved, renamed or deleted. The same code
          is still in the run&rsquo;s own workspace.
        </p>
      )}

      {project === null && data === undefined && (
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          {error === undefined
            ? "Reading the projects list…"
            : // Shorter, and the meaning it must not lose is that this is an
              // UNKNOWN, not a missing folder — hence "could not check", never
              // "not there".
              `Could not check whether this folder is still there: ${errorMessage(error)}`}
        </p>
      )}
    </Block>
  );
}
