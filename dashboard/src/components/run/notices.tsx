"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { RunDetail } from "@/lib/api-types";
import { formatCountdown } from "@/lib/format";
import { useNow } from "@/lib/use-run-stream";
import { Button, CommandLine, MonoPath, Notice } from "@/components/ui";

/**
 * RATE LIMITED — an expected state, not an error.
 *
 * Both subscription providers enforce a 5-hour rolling window plus a weekly
 * cap. A 429 means the window has to drain; the run is persisted and both SDKs
 * support session resume. This screen is one the owner will actually read, so
 * it says what happened, when it clears, and what to do — and it does not
 * colour itself like a crash.
 */
export function RateLimitNotice({
  run,
  onResume,
  busy,
}: {
  run: RunDetail;
  onResume: () => void;
  busy: boolean;
}): ReactNode {
  const retryAfterSec = run.rateLimit?.retryAfterSec ?? null;
  const nowMs = useNow(1_000);

  // The API reports a DURATION, not an instant, so the countdown has to be
  // anchored to the moment that duration arrived — and re-anchored whenever a
  // fresh one does. This is the sanctioned "adjust state during render"
  // pattern; an effect would render one stale frame on every new value.
  const [anchor, setAnchor] = useState<{ key: number | null; atMs: number }>(
    () => ({ key: retryAfterSec, atMs: Date.now() }),
  );
  if (anchor.key !== retryAfterSec) {
    // `nowMs`, not `Date.now()`: reading the wall clock during render is
    // impure. The tick is 1s and the countdown can be hours, so anchoring to
    // the last tick costs nothing.
    setAnchor({ key: retryAfterSec, atMs: nowMs });
  }

  const remaining =
    retryAfterSec === null
      ? null
      : Math.max(0, retryAfterSec - (nowMs - anchor.atMs) / 1_000);

  const clear = remaining !== null && remaining <= 0;

  return (
    <Notice
      tone="warn"
      title="Rate limited — the provider's rolling window is exhausted"
      actions={
        <Button variant="primary" onClick={onResume} disabled={busy}>
          {busy ? "Resuming…" : "Resume run"}
        </Button>
      }
    >
      <p>
        This is a normal state on a subscription plan, not a failure. Quota refills on
        a 5-hour rolling window with a weekly cap on top. The run is preserved — the
        session resumes where it stopped, it does not restart.
      </p>
      <p className="mt-1.5">
        {remaining === null ? (
          <>
            The provider did not say how long to wait. Try resuming in a few minutes; if
            it limits again, the weekly cap is the likelier constraint.
          </>
        ) : clear ? (
          <>
            The window should have cleared. <strong className="text-ink">Resume now.</strong>
          </>
        ) : (
          <>
            Retry after{" "}
            <strong className="numeric text-warn">{formatCountdown(remaining)}</strong>.
            Resuming earlier will just be limited again.
          </>
        )}
      </p>
    </Notice>
  );
}

/**
 * AWAITING INPUT — stalled on something the frozen API exposes no channel for.
 *
 * There is no answer/reply endpoint in the contract. Saying so plainly beats a
 * grey badge that leaves the owner hunting for an input box that does not exist.
 */
export function AwaitingInputNotice({
  onResume,
  onCancel,
  busy,
}: {
  onResume: () => void;
  onCancel: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <Notice
      tone="warn"
      title="Waiting on input"
      actions={
        <>
          <Button variant="primary" onClick={onResume} disabled={busy}>
            Resume
          </Button>
          <Button variant="danger" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <p>
        The run paused for something it wanted from you. This dashboard&rsquo;s API has
        no channel to answer a mid-run question — the two moves available are resume,
        which lets the agent proceed on its own judgement, and cancel.
      </p>
      <p className="mt-1.5 text-ink-faint">
        If it stalls here again on the same ticket, the brief is ambiguous. Tighten it
        and start a new run rather than resuming repeatedly.
      </p>
    </Notice>
  );
}

/**
 * FALSE FINISH — the agent declared done and the held-out gate disagreed.
 *
 * The co-primary failure metric, and the one that ships a broken app while
 * claiming success. It gets the loudest treatment on the page.
 */
export function FalseFinishNotice(): ReactNode {
  return (
    <Notice tone="fail" title="FALSE FINISH — the agent said it was done. The gate says otherwise.">
      <p>
        The build reported completion and the held-out suite failed in the sealed
        container. Treat the agent&rsquo;s own account of this run as unreliable: the
        per-criterion results below are the evidence, its summary is not.
      </p>
      <p className="mt-1.5 text-ink-faint">
        The failing criteria are the specification of what is actually missing.
      </p>
    </Notice>
  );
}

export function OutcomeNotice({ run }: { run: RunDetail }): ReactNode {
  if (run.falseFinish === true) return <FalseFinishNotice />;

  if (run.status === "passed" && run.heldOutPass === true) {
    return (
      <Notice tone="pass" title="Passed the held-out gate">
        <p>
          The frozen acceptance suite went green in a sealed container with no network
          and no access to the build workspace history.
        </p>
      </Notice>
    );
  }

  if (run.status === "failed") {
    return (
      <Notice tone="fail" title="Failed">
        <p>
          {run.heldOutPass === null
            ? "The run ended without the held-out suite returning a verdict — this is a harness or infrastructure failure, not a judgement about the artefact."
            : "The run finished and the held-out suite did not go green."}
        </p>
      </Notice>
    );
  }

  if (run.status === "cancelled") {
    return (
      <Notice tone="neutral" title="Cancelled">
        <p>Stopped by you. Partial artefacts, if any, are listed below.</p>
      </Notice>
    );
  }

  return null;
}

/** Where the work landed. Deploy is off by default, so a local path is the normal answer. */
export function DeliveryNotice({ run }: { run: RunDetail }): ReactNode {
  if (run.artifactPath === null && run.previewUrl === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded border border-line bg-surface px-3 py-2">
      {run.artifactPath !== null && (
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Artifact
          </span>
          <MonoPath path={run.artifactPath} max={80} />
        </span>
      )}
      {run.previewUrl !== null && (
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Preview
          </span>
          <Link
            href={run.previewUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[12.5px] text-accent underline underline-offset-2"
          >
            {run.previewUrl}
          </Link>
        </span>
      )}
    </div>
  );
}

/** Shown when the API itself cannot be reached — the local-tool failure mode. */
export function ApiDownNotice({ message }: { message: string }): ReactNode {
  return (
    <Notice tone="fail" title="The dashboard API is not answering">
      <p>{message}</p>
      <p className="mt-1.5">
        Start the backend process, then reload. If it runs on another port, set{" "}
        <code className="font-mono text-[11.5px] text-ink">DASHBOARD_API_ORIGIN</code>{" "}
        and restart the dashboard:
      </p>
      <p className="mt-1.5">
        <CommandLine command="DASHBOARD_API_ORIGIN=http://127.0.0.1:8787 npm run dev" />
      </p>
    </Notice>
  );
}
