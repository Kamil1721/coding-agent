"use client";

import type { ReactNode } from "react";

import type { ModelOption, ModelTier } from "@/lib/api-types";
import { providerLabel } from "@/lib/presentation";
import { Badge, Skeleton, cx } from "./ui";

interface Group {
  readonly tier: ModelTier;
  readonly heading: string;
  readonly note: string;
}

/**
 * Two tiers, always both rendered, always labelled.
 *
 * "Included in your plan" shows NO cost, because on a subscription there is no
 * cost — quota is consumed, not billed. Inventing a per-token figure for these
 * would be a fabrication, so nothing numeric appears against them at all.
 */
const GROUPS: readonly Group[] = [
  {
    tier: "included",
    heading: "Included in your plan",
    note: "Subscription quota. No per-token charge — a 5-hour rolling window and a weekly cap instead.",
  },
  {
    tier: "metered",
    heading: "Pay per token",
    note: "Billed per token against an API key.",
  },
];

function ModelRow({
  model,
  selected,
  onSelect,
  name,
}: {
  model: ModelOption;
  selected: boolean;
  onSelect: (id: string) => void;
  name: string;
}): ReactNode {
  const disabled = !model.available;
  return (
    <li>
      <label
        className={cx(
          "flex cursor-pointer items-start gap-2.5 rounded-sm border px-2.5 py-2 transition-colors",
          disabled
            ? "cursor-not-allowed border-line bg-surface/40"
            : selected
              ? "border-accent/60 bg-accent-dim/30"
              : "border-line bg-surface-raised/60 hover:border-line-strong hover:bg-surface-raised",
        )}
      >
        <input
          type="radio"
          name={name}
          value={model.id}
          checked={selected}
          disabled={disabled}
          onChange={() => onSelect(model.id)}
          className="mt-[3px] size-3.5 shrink-0 accent-[var(--color-accent)] disabled:opacity-40"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cx(
                "text-[13px] font-medium",
                disabled ? "text-ink-faint" : "text-ink",
              )}
            >
              {model.label}
            </span>
            <code className="font-mono text-[11px] text-ink-faint">{model.id}</code>
            <Badge tone="neutral">{providerLabel(model.provider)}</Badge>
          </span>
          {disabled && (
            <span className="mt-1 block text-[11.5px] leading-snug text-warn">
              {model.reason ?? "Unavailable. The API gave no reason."}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

export function ModelPicker({
  models,
  isLoading,
  errorText,
  value,
  onChange,
}: {
  models: readonly ModelOption[] | undefined;
  isLoading: boolean;
  errorText: string | null;
  value: string | null;
  onChange: (id: string) => void;
}): ReactNode {
  if (errorText !== null && models === undefined) {
    return (
      <p className="rounded border border-warn/40 bg-warn-dim/50 px-3 py-2 text-[12px] text-warn">
        Cannot load the model list: {errorText}
      </p>
    );
  }

  if (models === undefined) {
    return isLoading ? <Skeleton rows={4} /> : null;
  }

  if (models.length === 0) {
    return (
      <p className="text-[12px] text-ink-faint">
        The API returned no models. Nothing can be submitted until at least one is
        available.
      </p>
    );
  }

  return (
    <div className="space-y-3.5">
      {GROUPS.map((group) => {
        const inGroup = models.filter((model) => model.tier === group.tier);
        return (
          <fieldset key={group.tier} className="min-w-0">
            <legend className="mb-1 flex flex-wrap items-baseline gap-x-2">
              {/* Sentence case, deliberately: these two headings ARE the label
                  the owner reads to tell a subscription model from a metered
                  one, and a whole phrase set in caps reads as shouting. */}
              <span className="text-[12.5px] font-semibold text-ink">
                {group.heading}
              </span>
              <span className="text-[11px] text-ink-faint">{group.note}</span>
            </legend>
            {inGroup.length === 0 ? (
              <p className="px-1 py-1.5 text-[11.5px] text-ink-faint">
                None configured.
              </p>
            ) : (
              <ul className="space-y-1">
                {inGroup.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    name="modelId"
                    selected={value === model.id}
                    onSelect={onChange}
                  />
                ))}
              </ul>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
