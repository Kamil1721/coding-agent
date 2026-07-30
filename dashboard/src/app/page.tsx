"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AuthPanel } from "@/components/auth-panel";
import { ModelPicker } from "@/components/model-picker";
import { FalseFinishBadge } from "@/components/outcome";
import { Badge, Button, Dot, Panel, cx } from "@/components/ui";
import { createRun, errorMessage } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useModels, useRuns } from "@/lib/hooks";
import { statusMeta } from "@/lib/presentation";
import { useNow } from "@/lib/use-run-stream";

/**
 * The last few runs, so that submitting a ticket and then getting back to a
 * run in progress are the same screen. Deliberately terse — the Runs tab is
 * the real history.
 */
function RecentRuns(): ReactNode {
  const { data: runs } = useRuns();
  const nowMs = useNow(5_000);
  const recent = (runs ?? []).slice(0, 5);
  if (recent.length === 0) return null;

  return (
    <Panel
      title="Recent"
      actions={
        <Link
          href="/runs"
          className="text-[11px] text-ink-faint underline-offset-2 hover:text-ink"
        >
          all runs
        </Link>
      }
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-line">
        {recent.map((run) => {
          const meta = statusMeta(run.status);
          return (
            <li key={run.runId}>
              <Link
                href={`/runs/${encodeURIComponent(run.runId)}`}
                className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-surface-raised/60"
              >
                <Badge tone={meta.tone} title={meta.meaning}>
                  <Dot tone={meta.tone} pulse={meta.live} />
                  {meta.label}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
                  {run.ticketTitle === "" ? run.runId : run.ticketTitle}
                </span>
                <FalseFinishBadge falseFinish={run.falseFinish} />
                <span className="numeric shrink-0 text-[11px] text-ink-faint">
                  {formatRelative(run.startedAt, nowMs)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function pickDefaultModel(
  models: readonly { id: string; tier: string; available: boolean }[],
): string | null {
  const included = models.find(
    (model) => model.tier === "included" && model.available,
  );
  if (included !== undefined) return included.id;
  const any = models.find((model) => model.available);
  return any?.id ?? null;
}

export default function NewTicketPage(): ReactNode {
  const router = useRouter();
  const { data: models, isLoading, error } = useModels();

  const [ticketText, setTicketText] = useState("");
  const [chosenModelId, setChosenModelId] = useState<string | null>(null);
  const [deploy, setDeploy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The default is DERIVED, not written into state by an effect: an effect
  // here would render once with nothing selected and then again with a
  // selection, and would fight any explicit choice made before the list loads.
  const modelId: string | null =
    chosenModelId ?? (models === undefined ? null : pickDefaultModel(models));
  const setModelId = setChosenModelId;

  const selected = useMemo(
    () => models?.find((model) => model.id === modelId) ?? null,
    [models, modelId],
  );

  const trimmed = ticketText.trim();
  const blockedReason: string | null =
    trimmed === ""
      ? "Write the brief first."
      : modelId === null
        ? "Pick a model."
        : selected !== null && !selected.available
          ? (selected.reason ?? "That model is unavailable.")
          : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (blockedReason !== null || modelId === null || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { runId } = await createRun({ ticketText: trimmed, modelId, deploy });
      router.push(`/runs/${encodeURIComponent(runId)}`);
    } catch (cause) {
      setSubmitError(errorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Panel
          title="Ticket"
          // KEPT, TRIMMED. "Plain prose" was obvious; how you will know it works is
          // not — that sentence is what the acceptance suite is authored from, so it
          // changes the output rather than describing the input.
          subtitle="Describe what you want built, and how you will know it works."
          bodyClassName="p-0"
        >
          <textarea
            value={ticketText}
            onChange={(event) => setTicketText(event.target.value)}
            spellCheck
            placeholder={
              "A one-page site for a photographer.\n\nHero image, a grid of 12 photos that opens a lightbox, an about section, and a contact form that validates the email field.\n\nMust work at 1280px and on a phone."
            }
            className="h-[420px] w-full resize-y bg-transparent px-3 py-2.5 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-faint/70 focus:outline-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
            <span>
              The acceptance criteria are authored from this text before any code is
              written. Ambiguity here becomes an untestable criterion later.
            </span>
            <span className="numeric shrink-0">{trimmed.length} chars</span>
          </div>
        </Panel>

        <Panel title="Delivery">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={deploy}
              onChange={(event) => setDeploy(event.target.checked)}
              className="mt-[3px] size-3.5 shrink-0 accent-[var(--color-accent)]"
            />
            <span className="min-w-0">
              <span className="text-[13px] font-medium text-ink">
                Deploy a preview when it passes
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">
                Off by default. When off the artifact stays on this machine and the run
                reports a local path instead of a URL.
              </span>
            </span>
          </label>
        </Panel>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            disabled={blockedReason !== null || submitting}
          >
            {submitting ? "Submitting…" : "Start run"}
          </Button>
          {blockedReason !== null && (
            <span className="text-[12px] text-ink-faint">{blockedReason}</span>
          )}
          {submitError !== null && (
            <span
              role="alert"
              className={cx(
                "rounded-sm border border-fail/40 bg-fail-dim px-2 py-1 text-[12px] text-fail",
              )}
            >
              {submitError}
            </span>
          )}
        </div>

        <RecentRuns />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <AuthPanel />
        <Panel
          title="Model"
          /*
           * SUBTITLE REMOVED 2026-07-30 — the third restatement of "this uses your
           * plan, not an API key" on one screen (the auth panel said it, its provider
           * row said it, this said it). The cost invariant is real and enforced in the
           * database; it did not need repeating above a dropdown.
           */
        >
          <ModelPicker
            models={models}
            isLoading={isLoading}
            errorText={error === undefined ? null : errorMessage(error)}
            value={modelId}
            onChange={setModelId}
          />
        </Panel>
      </div>
    </form>
  );
}
