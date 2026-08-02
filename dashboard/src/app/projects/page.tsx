"use client";

/**
 * THE PROJECTS INDEX — where the owner comes back a week later.
 *
 * THE PROBLEM IT ANSWERS, IN THE OWNER'S WORDS: "what if I wanted to work in the
 * project after it was done? I don't have a file or a database to work from."
 * The code was always on disk — `projects/<slug-of-the-ticket-title>/`, copied
 * out of the run's workspace when the run went terminal — but the only way to
 * find it was to remember which run produced it and read a path off that run's
 * page. This screen is the list, and the three controls that make an entry on it
 * a thing you can look at rather than a folder you have to `cd` to.
 *
 * IT IS A LIST, NOT A DASHBOARD. One row per folder, the same `Panel` chrome and
 * the same 13px/12px/11.5px rungs as `/runs`, no cards, no summary tiles. The
 * only counts on it are in the subtitle, where `/runs` already puts them.
 *
 * NEWEST FIRST IS A JOIN, NOT A FIELD. `GET /api/projects` sorts by slug —
 * measured, and unavoidable: `Project` carries no timestamp at all, because the
 * folder's mtime changes when the owner edits a file and would sort "the thing I
 * touched last" as "the thing that was published last". The run that published a
 * folder is on the wire (`Project.runId`), and a run has a start time, so the
 * order comes from `useRuns()`. THREE CONSEQUENCES, all deliberate:
 *
 *   · A project whose `runId` is null — one the owner made himself, or one
 *     published before the record existed — cannot be placed in time and sorts
 *     to the bottom, alphabetically, rather than being dated by a guess.
 *   · When the runs list has not arrived or has failed, the page renders in the
 *     server's alphabetical order rather than waiting. A list you can see is
 *     worth more than a list in the right order.
 *   · No "published" column is drawn from the run's start time. The value sorted
 *     on is the run's, so the run is what is named.
 */

import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import {
  ProjectControls,
  ProjectFailure,
  ProjectLogsDisclosure,
  ProjectStateChip,
  ProjectStateLine,
  hasRecordedOutput,
  useProjectControl,
  type ProjectControl,
} from "@/components/project/controls";
import { MonoPath, Panel, Skeleton } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import type { Project, RunSummary } from "@/lib/api-types";
import { formatClock } from "@/lib/format";
import { useProjects, useRuns } from "@/lib/hooks";

/**
 * The run that published a folder, or null when nothing names one.
 *
 * KEYED ON `runId` RATHER THAN ON THE PATH. The server built that field by
 * reading each run's own publish record for exactly this join, and it survives
 * the `<slug>-<run id>` collision rename that makes the folder name stop
 * matching the ticket title.
 */
function runIndexOf(runs: readonly RunSummary[]): ReadonlyMap<string, RunSummary> {
  return new Map(runs.map((run) => [run.runId, run]));
}

/**
 * ONE ROW, THREE COLUMNS, AND THE LEFT ONE IS FIXED WIDTH.
 *
 * The first draft put the state chip inline before the title, which pushed the
 * title's left edge ~76px right of every line under it and left the row with a
 * ragged edge nothing lined up against. A fixed status column is also what
 * `/runs` does (`w-[136px]`, sized for its longest badge), so the two lists
 * scan the same way. 100px is this list's longest chip — `not running` — plus
 * its dot and padding.
 *
 * THE SLUG IS NOT PRINTED SEPARATELY. It was, for one draft, and it is the tail
 * of the path directly under it — the same 59 characters twice in a four-line
 * row. When there is no run to take a title from, the title IS the slug, so
 * nothing is lost in the case that made it look necessary.
 *
 * THE RUN IS DATED ABSOLUTELY, NOT RELATIVELY. `formatRelative` tops out in
 * hours — the one real folder here reads "69h 55m ago" — and this screen's whole
 * premise is coming back a week later. An absolute stamp also does not tick, so
 * this page needs no clock.
 */
function ProjectRow({
  project,
  run,
  control,
}: {
  project: Project;
  run: RunSummary | null;
  control: ProjectControl;
}): ReactNode {
  const pending = control.isPending(project.slug);
  const failure = control.failureOf(project.slug);
  const title = run === null || run.ticketTitle === "" ? project.slug : run.ticketTitle;

  return (
    <li className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
      {/*
       * THE STATUS COLUMN FOLDS AWAY UNDER 560px. Measured at 420px, where a
       * 100px column plus the controls left the title about 150px and every line
       * wrapped: a column that costs a quarter of the viewport is not carrying
       * its keep. Below the breakpoint the chip moves inline above the title
       * instead — same component, same reading, one of the two is always
       * `display: none`.
       */}
      <div className="hidden w-[100px] shrink-0 pt-[2px] min-[560px]:block">
        <ProjectStateChip project={project} pending={pending} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 min-[560px]:hidden">
          <ProjectStateChip project={project} pending={pending} />
        </div>
        <h3 className="min-w-0 truncate text-[13px] text-ink" title={title}>
          {title}
        </h3>

        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <MonoPath path={project.path} max={88} />
          {run === null ? (
            <span
              className="text-[11px] text-ink-faint"
              title="No run's publish record names this folder. It was created by hand, or published before the record existed."
            >
              no run recorded
            </span>
          ) : (
            <Link
              href={`/runs/${encodeURIComponent(run.runId)}`}
              className="text-[11px] whitespace-nowrap text-ink-dim underline-offset-2 hover:text-ink hover:underline"
              title={`Published by ${run.runId}`}
            >
              run of {formatClock(run.startedAt)}
            </Link>
          )}
          {project.hasRepository && (
            <span
              className="text-[11px] whitespace-nowrap text-ink-faint"
              title="This folder is its own git repository, so the work has a history to branch from."
            >
              git repository
            </span>
          )}
        </div>

        <div className="mt-1.5 space-y-1.5">
          <ProjectStateLine project={project} pending={pending} />
          {failure !== null && <ProjectFailure message={failure} />}
          {hasRecordedOutput(project, failure !== null) && (
            <ProjectLogsDisclosure slug={project.slug} />
          )}
        </div>
      </div>

      <ProjectControls project={project} control={control} />
    </li>
  );
}

export default function ProjectsPage(): ReactNode {
  const { data, error, isLoading, mutate } = useProjects();
  const { data: runs } = useRuns();
  const control = useProjectControl(mutate);

  const byRunId = useMemo(() => runIndexOf(runs ?? []), [runs]);

  /*
   * SORTED HERE, NOT ON THE SERVER, and stable: `Array.prototype.sort` is
   * stable in every engine this app runs in, so two projects published by the
   * same run — which is possible, `<slug>` and `<slug>-<run id>` — keep the
   * server's alphabetical order relative to each other.
   */
  const ordered = useMemo((): readonly Project[] => {
    const projects = data?.projects ?? [];
    return [...projects].sort((left, right) => {
      const leftRun = left.runId === null ? undefined : byRunId.get(left.runId);
      const rightRun = right.runId === null ? undefined : byRunId.get(right.runId);
      // A folder no run claims cannot be placed in time, so it goes last rather
      // than being dated by a guess.
      if (leftRun === undefined && rightRun === undefined) {
        return left.slug.localeCompare(right.slug);
      }
      if (leftRun === undefined) return 1;
      if (rightRun === undefined) return -1;
      return rightRun.startedAt.localeCompare(leftRun.startedAt);
    });
  }, [data, byRunId]);

  const running = ordered.filter((project) => project.process.state === "running").length;
  const range = data?.portRange ?? null;

  return (
    <Panel
      title="Projects"
      subtitle={
        data === undefined
          ? "Every finished run's code, copied out of the run directory."
          : `${ordered.length} folder${ordered.length === 1 ? "" : "s"} · ${running} running${
              range === null
                ? ""
                : ` · started on loopback ports ${String(range.min)}–${String(range.max)}`
            }`
      }
      bodyClassName="p-0"
    >
      {error !== undefined && data === undefined ? (
        <p className="px-3 py-4 text-[12px] text-warn">{errorMessage(error)}</p>
      ) : isLoading && data === undefined ? (
        <div className="px-3 py-3">
          <Skeleton rows={4} />
        </div>
      ) : ordered.length === 0 ? (
        /*
         * AN EXPLANATION, NOT AN EMPTY BOX. Nothing here yet is the ordinary
         * state of a machine whose runs have not finished, and the reader's
         * actual question is "where will it appear and what puts it there" —
         * which is answerable in three sentences, so it is answered.
         */
        <div className="px-3 py-6">
          <p className="text-[13px] text-ink">No published projects yet.</p>
          <p className="mt-1.5 max-w-[62ch] text-[12px] leading-relaxed text-ink-dim">
            When a run reaches a terminal state its workspace is copied to{" "}
            {/* `whitespace-nowrap` because it broke after `projects/<ticket` at
                62ch, and a path split across two lines reads as two paths. */}
            <code className="whitespace-nowrap font-mono text-[11.5px]">
              projects/&lt;ticket title&gt;/
            </code>
            ,
            and the copy shows up here. That happens whether the run passed or failed —
            a failed build&rsquo;s code is still the thing you asked to be able to open.
            The copy is not a move: the run keeps its own workspace as evidence.
          </p>
          <p className="mt-1.5 text-[12px] text-ink-dim">
            <Link href="/runs" className="text-accent underline underline-offset-2">
              Runs
            </Link>{" "}
            shows what is in flight, and{" "}
            <Link href="/" className="text-accent underline underline-offset-2">
              New ticket
            </Link>{" "}
            starts one.
          </p>
        </div>
      ) : (
        <ul className="min-w-0">
          {ordered.map((project) => (
            <ProjectRow
              key={project.slug}
              project={project}
              run={project.runId === null ? null : byRunId.get(project.runId) ?? null}
              control={control}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
