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
 * The same chrome as the Artifact row directly above it on this tab — one
 * label, one block, the same border and padding — so the two paths read as a
 * pair rather than as two designs.
 */
function Block({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cx("min-w-0 rounded border border-line bg-surface px-3 py-2", className)}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </p>
      <div className="mt-1.5 min-w-0">{children}</div>
    </section>
  );
}

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
      return (
        <Block label="Project">
          <p className="text-[12px] leading-relaxed text-ink-dim">
            Not copied out yet. When this run reaches a terminal state its workspace is
            copied to <code className="font-mono text-[11.5px]">projects/</code> and this
            becomes somewhere to start it from.
          </p>
        </Block>
      );
    }
    return (
      <Block label="Project">
        <p className="text-[12px] leading-relaxed text-ink-dim">
          No publish was recorded for this run. That is not the same as a publish that was
          refused &mdash; there is no record either way, which happens when a run finished
          before the publish lane existed or when its record file could not be read. The
          workspace itself is still on disk at the artifact path above.
        </p>
      </Block>
    );
  }

  if (!record.published) {
    return (
      <Block label="Project" className="border-warn/45 bg-warn-dim/40">
        <p className="text-[12px] font-semibold text-ink">
          The copy was attempted and refused
          <span className="ml-1.5 font-mono text-[11px] font-normal text-warn">
            {record.reason}
          </span>
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{record.detail}</p>
        <p className="mt-1 text-[11.5px] text-ink-faint">
          Attempted {formatClock(record.attemptedAt)}. Nothing was written to{" "}
          <code className="font-mono">projects/</code>; the run&rsquo;s own workspace is
          untouched.
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
       * THE FOLDER IS GONE. Said plainly, with what is still true underneath it:
       * the run's workspace is evidence and is never moved, so the code exists
       * even when this copy does not.
       */}
      {project === null && data !== undefined && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-warn">
          That folder is not there now. It was copied at the time above; it has since been
          moved, renamed or deleted &mdash; it is yours, and nothing here removes it. The
          run&rsquo;s own workspace still holds the same code, at the artifact path above.
        </p>
      )}

      {project === null && data === undefined && (
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          {error === undefined
            ? "Reading the projects list…"
            : `The projects list could not be read, so whether this folder is still there is unknown: ${errorMessage(error)}`}
        </p>
      )}
    </Block>
  );
}
