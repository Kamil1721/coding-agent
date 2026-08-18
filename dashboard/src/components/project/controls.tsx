"use client";

/**
 * THE CONTROLS FOR ONE PUBLISHED PROJECT — start it, open it, stop it.
 *
 * Written once and mounted on both surfaces that need it: the `/projects` index
 * and the run detail's Verdict tab. They are the same three buttons over the
 * same three server states, and two copies of this would drift the moment one of
 * them learned about a fourth.
 *
 * THE STATE MODEL, AND THE ONE PIECE OF IT THAT IS OURS.
 *
 * `ProjectProcess` has three members — `stopped`, `running`, `exited` — and no
 * `starting`. That is not an omission: `POST /api/projects/:slug/start` does not
 * answer until the child's port has ANSWERED AN HTTP REQUEST or 30 s have
 * passed (`DEFAULT_START_TIMEOUT_MS` in `server/src/project-runner.ts`), so the
 * only thing that knows a start is in progress is whoever is holding the
 * promise. That is `useProjectControl` below, and its pending set is the whole
 * of the "starting" state.
 *
 * THE OPEN LINK CANNOT BE RENDERED EARLY, AND NOT BECAUSE THIS FILE IS CAREFUL.
 * `url` exists only on the `running` member of the union, so there is no
 * expression that reaches an address while the process is starting, stopped or
 * exited. The rule the brief asks for — never offer "open" before the server
 * says the port answers — is enforced by the type, and the only way to break it
 * would be to build an address out of `port`, which is why nothing here does.
 *
 * WHAT IS PAINTED IS ALWAYS THE LIST, NEVER THE ACTION'S OWN RESPONSE. `start`
 * and `stop` return a fresh `Project`, and it is deliberately thrown away: the
 * hook revalidates and the row keeps rendering `useProjects()`. A control that
 * believes its own POST is exactly how a green "running" chip outlives the
 * process behind it — the child can die a second after readiness was measured,
 * and only the next list says so.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";

import { Badge, Button, Dot, cx } from "@/components/ui";
import {
  errorMessage,
  projectLogs as fetchProjectLogs,
  startProject,
  stopProject,
} from "@/lib/api";
import type { Project, ProjectExit, ProjectLogs } from "@/lib/api-types";
import { formatTimeOnly } from "@/lib/format";
import type { Tone } from "@/lib/presentation";

/* ------------------------------------------------------------------ */
/* The action hook                                                     */
/* ------------------------------------------------------------------ */

export interface ProjectControl {
  /** True from the click until the server's list has been re-read. */
  readonly isPending: (slug: string) => boolean;
  /** The last refusal for this slug, or null. Cleared by the next attempt. */
  readonly failureOf: (slug: string) => string | null;
  /**
   * `after` runs once the start SETTLES: with the fresh project on success —
   * `startProject` resolves only when the port actually answers — or with null
   * on refusal. It exists for the one-click "Start and open" flow, where a tab
   * opened at click time needs a URL to point at, or needs closing.
   */
  readonly start: (slug: string, after?: (project: Project | null) => void) => void;
  readonly stop: (slug: string) => void;
}

/**
 * `revalidate` IS `useProjects().mutate` — the caller's, so both surfaces
 * refresh the same SWR cache entry rather than each holding a copy.
 *
 * PENDING OUTLIVES THE REQUEST ON PURPOSE. It is cleared after the revalidate
 * settles, not when the POST resolves, so the button never re-enables against a
 * list that still says `stopped`. The cost is a few extra milliseconds of a
 * disabled button on loopback, which is cheaper than a second start.
 *
 * TWO MECHANISMS STOP A DOUBLE FIRE, and they answer different failures. The
 * `disabled` attribute is the visible one. The REF is the real one: two clicks
 * inside a single tick both read a `pending` state that has not re-rendered
 * yet, so the state alone would let the second through. (The server dedupes as
 * well — `#starting` keyed by resolved directory — so the worst case was never
 * two children; it was two requests and a confusing second refusal.)
 *
 * A RELOAD MID-START ORPHANS THIS. The pending set is component state, so a
 * refresh while a project is coming up loses the "starting" chip; the next poll
 * shows whatever the child did. The child is not affected — it belongs to the
 * server process, not to this page.
 */
export function useProjectControl(
  revalidate: () => Promise<unknown>,
): ProjectControl {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  const run = useCallback(
    (slug: string, action: (slug: string) => Promise<unknown>): void => {
      if (inFlight.current.has(slug)) return;
      inFlight.current.add(slug);
      setPending((current) => new Set(current).add(slug));
      setFailures((current) => {
        if (!current.has(slug)) return current;
        const next = new Map(current);
        next.delete(slug);
        return next;
      });

      void action(slug)
        .catch((cause: unknown) => {
          setFailures((current) => new Map(current).set(slug, errorMessage(cause)));
        })
        // The list is re-read whether the action worked or not: a refused start
        // usually leaves an `exited` child behind, and that exit is a fact about
        // the project the row has to show.
        .then(() => revalidate())
        .catch(() => undefined)
        .finally(() => {
          inFlight.current.delete(slug);
          setPending((current) => {
            const next = new Set(current);
            next.delete(slug);
            return next;
          });
        });
    },
    [revalidate],
  );

  const isPending = useCallback((slug: string): boolean => pending.has(slug), [pending]);
  const failureOf = useCallback(
    (slug: string): string | null => failures.get(slug) ?? null,
    [failures],
  );
  const start = useCallback(
    (slug: string, after?: (project: Project | null) => void): void =>
      run(slug, async (target) => {
        try {
          const response = await startProject(target);
          after?.(response.project);
          return response;
        } catch (cause) {
          after?.(null);
          throw cause;
        }
      }),
    [run],
  );
  const stop = useCallback((slug: string): void => run(slug, stopProject), [run]);

  return { isPending, failureOf, start, stop };
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface StateRead {
  readonly tone: Tone;
  readonly label: string;
  readonly live: boolean;
  /** The sentence under the chip. Empty string = nothing worth saying. */
  readonly detail: string;
  /** Why this state is worth a colour, on hover. */
  readonly meaning: string;
}

function exitPhrase(exit: ProjectExit): string {
  const how =
    exit.signal !== null
      ? `signal ${exit.signal}`
      : exit.code === null
        ? "no exit code"
        : `code ${String(exit.code)}`;
  return `${how} at ${formatTimeOnly(exit.at)}`;
}

/**
 * FOUR READINGS OF THREE SERVER STATES, and the fourth is `pending`.
 *
 * `stopped` IS TWO SENTENCES, not one. `lastExit === null` means this dashboard
 * has never started it; `lastExit.requested === true` means the owner stopped
 * it, which is a receipt. `exited` is the one that must never be drawn calm: it
 * is a process that died WITHOUT being asked to, and the exit code is the only
 * thing on screen that says why.
 */
export function readProjectState(project: Project, pending: boolean): StateRead {
  if (pending) {
    return {
      tone: "info",
      label: "starting",
      live: true,
      detail: "waiting for the port to answer",
      meaning:
        "The child has been spawned and the server is polling it with a real HTTP request. " +
        "It is not offered as a link until that request is answered.",
    };
  }
  const process = project.process;
  switch (process.state) {
    case "running":
      return {
        tone: "pass",
        label: "running",
        live: true,
        detail: `port ${String(process.port)} · pid ${String(process.pid)} · answered at ${formatTimeOnly(process.readyAt)}`,
        meaning:
          "A child is alive and its port answered an HTTP request at the time shown. It does not " +
          "promise the address answers this second; the list is re-read every 5 seconds.",
      };
    case "exited":
      return {
        tone: "warn",
        label: "exited",
        live: false,
        detail: `it stopped on its own — ${exitPhrase(process.exit)}`,
        meaning:
          "This dashboard started it and it died without being asked to. The logs it wrote are " +
          "still readable.",
      };
    default: {
      const last = process.lastExit;
      if (last === null) {
        return {
          tone: "neutral",
          label: "not running",
          live: false,
          detail: "",
          meaning: "Nothing of this dashboard's is serving this folder.",
        };
      }
      /*
       * THE SECOND ARM IS UNREACHABLE FROM TODAY'S SERVER AND IS STILL WRITTEN
       * HONESTLY. `#describe` in `project-runner.ts` returns `stopped` with a
       * `lastExit` only when `exit.requested` is true (line 1186); an
       * unrequested exit becomes `exited` on the line below it. So a calm grey
       * "stopped" for a process that died on its own cannot happen — unless that
       * mapping ever changes, at which point the collapse this app keeps finding
       * would arrive silently. It costs one branch to make that impossible.
       */
      if (!last.requested) {
        return {
          tone: "warn",
          label: "stopped",
          live: false,
          detail: `it stopped on its own — ${exitPhrase(last)}`,
          meaning:
            "Nothing is serving this folder now, and the last exit was not one this dashboard asked for.",
        };
      }
      return {
        tone: "neutral",
        label: "stopped",
        live: false,
        detail: `you stopped it — ${exitPhrase(last)}`,
        meaning: "Nothing is serving this folder now. The stop you asked for is recorded.",
      };
    }
  }
}

export function ProjectStateChip({
  project,
  pending,
}: {
  project: Project;
  pending: boolean;
}): ReactNode {
  const read = readProjectState(project, pending);
  return (
    <Badge tone={read.tone} title={read.meaning}>
      <Dot tone={read.tone} pulse={read.live} />
      {read.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Glyph                                                               */
/* ------------------------------------------------------------------ */

/**
 * An arrow leaving a frame — this opens a tab that is not the dashboard.
 *
 * 1.5 STROKE ON A 24 GRID, the weight `attachment-chips.tsx`'s `DocumentGlyph`
 * set and the only icon convention this app has. Rendered at 12px beside a 12px
 * label, `currentColor` so the link's own colour drives it.
 */
function ExternalGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

/**
 * The child's recent output, fetched only when asked for.
 *
 * WHY IT EXISTS BESIDE THE REFUSAL RATHER THAN INSTEAD OF IT. A `start_exited`
 * refusal carries its own stderr tail, and `lib/api.ts` caps any server message
 * at 400 characters — so on a stack trace the sentence that names the failure
 * survives and the trace is cut. The server's own remediation says where the
 * rest is: `GET /api/projects/<slug>/logs`. This is that.
 *
 * NOT POLLED. It is a window over a ring buffer the server already bounds at 200
 * lines; re-reading it on a timer would put a request per second against a pane
 * that is closed most of the time. Re-opening it fetches again.
 */
function ProjectLogsDisclosure({ slug }: { slug: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<ProjectLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback((): void => {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setLoading(true);
        setError(null);
        void fetchProjectLogs(slug)
          .then((response) => setLogs(response))
          .catch((cause: unknown) => setError(errorMessage(cause)))
          .finally(() => setLoading(false));
      }
      return next;
    });
  }, [slug]);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="rounded-sm border border-line-strong px-1.5 py-[1px] text-[10px] text-ink-faint transition-colors hover:border-ink-faint hover:text-ink"
      >
        {open ? "hide output" : "output"}
      </button>
      {open && (
        // CAPPED, LIKE THE REFUSAL BLOCK BELOW IT. On the index this sits in a
        // row that is as wide as the window, and a 1200px line of npm output is
        // unreadable in the way a wall of text is unreadable. The sheet is
        // 560px, so the cap only ever binds on the index.
        <div className="mt-1.5 max-w-[110ch] rounded-sm border border-line bg-canvas">
          {loading && logs === null ? (
            <p className="px-2 py-1.5 text-[11px] text-ink-faint">reading…</p>
          ) : error !== null ? (
            <p className="px-2 py-1.5 text-[11px] text-warn">{error}</p>
          ) : logs === null || logs.lines.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-ink-faint">
              Nothing was recorded. This dashboard has not started this project, or it
              wrote nothing before it stopped.
            </p>
          ) : (
            <>
              {logs.dropped > 0 && (
                <p className="border-b border-line px-2 py-1 text-[10px] text-ink-faint">
                  {logs.dropped} earlier line{logs.dropped === 1 ? "" : "s"} fell off the
                  front of a {logs.maxLines}-line window.
                </p>
              )}
              <ol className="max-h-52 overflow-y-auto px-2 py-1.5">
                {logs.lines.map((line, index) => (
                  <li
                    key={`${line.at}-${String(index)}`}
                    className={cx(
                      "whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed",
                      // stderr is not an error — a great many servers announce
                      // themselves on it — so it is dimmed-warm rather than red.
                      // Red on this screen means the run failed.
                      line.stream === "stderr" ? "text-warn/90" : "text-ink-dim",
                    )}
                  >
                    {line.text}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The controls                                                        */
/* ------------------------------------------------------------------ */

/**
 * MIRRORS `Button`'s `primary` VARIANT AT `default` SIZE, because an anchor
 * cannot be a `Button` and should not become one. Middle-click, copy-link and
 * "open in a new window" all belong to a real `<a href>`, and a button with an
 * onClick that calls `window.open` takes all three away.
 *
 * Kept as a literal rather than imported: `BUTTON_VARIANT` is private to
 * `ui.tsx` and exporting it to save one string would make every future variant
 * change a two-file edit for no reader's benefit.
 */
const OPEN_LINK_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm border border-accent/50 bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:border-accent/70 hover:bg-accent/25";

/**
 * The three buttons, in the order the work goes: start, open, stop.
 *
 * `startCommand === null` REMOVES THE START BUTTON RATHER THAN DISABLING IT. The
 * server's refusal for that folder is a 409 `no_start_script`, and a control
 * whose only possible outcome is an error is worse than a sentence saying there
 * is nothing to start — which is what `ProjectStateLine` renders instead.
 */
export function ProjectControls({
  project,
  control,
}: {
  project: Project;
  control: ProjectControl;
}): ReactNode {
  const pending = control.isPending(project.slug);
  const process = project.process;
  const startable = project.startCommand !== null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      {process.state === "running" ? (
        <>
          <a
            href={process.url}
            target="_blank"
            rel="noreferrer noopener"
            className={OPEN_LINK_CLASS}
            title={`${process.url} — served by this dashboard's child process on loopback`}
          >
            Open
            <ExternalGlyph />
          </a>
          <Button variant="danger" onClick={() => control.stop(project.slug)} disabled={pending}>
            Stop
          </Button>
        </>
      ) : (
        startable && (
          <Button
            variant="primary"
            onClick={() => {
              /*
               * THE TAB IS OPENED AT CLICK TIME, BLANK, then aimed once the port
               * answers. `window.open` after an await is what popup blockers
               * exist to kill; inside the click it is allowed. If the blocker
               * still refuses (tab === null), nothing is lost — the card shows
               * its Open link once the poll sees the child running, one click.
               */
              const tab = window.open("about:blank", "_blank");
              if (tab !== null) {
                try {
                  tab.document.write(
                    "<title>Starting…</title><body style=\"font-family:sans-serif;padding:2rem;color:#444\">Starting the site — this tab will load it when the port answers.</body>",
                  );
                } catch {
                  /* cross-origin-locked blank tab: it still navigates below */
                }
              }
              control.start(project.slug, (started) => {
                if (started !== null && started.process.state === "running" && tab !== null) {
                  tab.location.href = started.process.url;
                } else {
                  tab?.close();
                }
              });
            }}
            disabled={pending}
            title={
              pending
                ? "Spawned. This opens in a new tab once its port answers, or the failure shows here."
                : `Runs \`${project.startCommand ?? ""}\` in ${project.path}, then opens the site in a new tab.`
            }
          >
            {pending ? "Starting…" : "Start and open"}
          </Button>
        )
      )}
    </div>
  );
}

/**
 * The one line under the name: what the process is doing, or why it cannot.
 *
 * SEPARATE FROM THE CHIP because the chip is a word and this is the evidence for
 * it — the port and pid that make "running" checkable, the exit code that makes
 * "exited" actionable.
 */
export function ProjectStateLine({
  project,
  pending,
}: {
  project: Project;
  pending: boolean;
}): ReactNode {
  const read = readProjectState(project, pending);
  if (project.startCommand === null) {
    return (
      <p className="text-[11.5px] text-ink-faint">
        Nothing here can be started: there is no <code className="font-mono">package.json</code>{" "}
        with a <code className="font-mono">start</code> script in this folder. Its files are
        still on disk at the path above.
      </p>
    );
  }
  if (read.detail === "") return null;
  return <p className="text-[11.5px] text-ink-dim">{read.detail}</p>;
}

/**
 * A start that did not come up, in the server's own words.
 *
 * `whitespace-pre-wrap` BECAUSE THE MESSAGE CARRIES STDERR ACROSS NEWLINES —
 * `start_exited` appends the child's last stderr lines after a colon and a line
 * break. Collapsed to one line it reads as a run-on sentence; the newlines are
 * the only thing separating the refusal from the trace.
 */
export function ProjectFailure({ message }: { message: string }): ReactNode {
  return (
    <div className="max-w-[110ch] rounded-sm border border-fail/50 bg-fail-dim/70 px-2.5 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fail">
        it did not come up
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-dim">
        {message}
      </p>
    </div>
  );
}

/**
 * Whether there is any recorded output to offer — the disclosure must not open
 * onto an empty box for a folder this dashboard has never touched.
 */
export function hasRecordedOutput(project: Project, failed: boolean): boolean {
  if (failed) return true;
  const process = project.process;
  if (process.state === "stopped") return process.lastExit !== null;
  return true;
}

export { ProjectLogsDisclosure };
