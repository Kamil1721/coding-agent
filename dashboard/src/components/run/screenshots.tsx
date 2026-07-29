"use client";

/* eslint-disable @next/next/no-img-element -- `next/image` needs a configured
   loader and a known remote host. Screenshot locations come from the backend at
   runtime and may not be HTTP at all, so a plain <img> with an explicit error
   fallback is the honest primitive here. */

import { useState, type ReactNode } from "react";

import type { Screenshot } from "@/lib/api-types";
import { formatClock } from "@/lib/format";
import { screenshotSrc } from "@/lib/screenshots";
import { EmptyState, MonoPath, Panel } from "@/components/ui";

function Shot({ shot, runId }: { shot: Screenshot; runId: string }): ReactNode {
  const src = screenshotSrc(runId, shot.path);
  const [failed, setFailed] = useState(false);
  const showImage = src !== null && !failed;

  return (
    <figure className="min-w-0 overflow-hidden rounded border border-line bg-surface-raised">
      {showImage ? (
        <a href={src} target="_blank" rel="noreferrer noopener" className="block">
          <img
            src={src}
            alt={shot.label}
            loading="lazy"
            onError={() => setFailed(true)}
            className="block h-[128px] w-full bg-canvas object-cover object-top"
          />
        </a>
      ) : (
        <div className="flex h-[128px] items-center justify-center bg-canvas px-3 text-center text-[11px] leading-snug text-ink-faint">
          {src === null
            ? "Captured on disk. Nothing here can turn that path into a URL — it is shown below instead."
            : "The server did not return this capture. It is still on disk at the path below."}
        </div>
      )}
      <figcaption className="space-y-1 border-t border-line px-2 py-1.5">
        <div className="truncate text-[12px] text-ink" title={shot.label}>
          {shot.label}
        </div>
        <div className="numeric text-[10.5px] text-ink-faint">
          {formatClock(shot.capturedAt)}
        </div>
        <MonoPath path={shot.path} max={38} />
      </figcaption>
    </figure>
  );
}

export function ScreenshotsPanel({
  runId,
  screenshots,
}: {
  runId: string;
  screenshots: readonly Screenshot[];
}): ReactNode {
  return (
    <Panel
      title="Screenshots"
      subtitle={
        screenshots.length === 0
          ? undefined
          : `${screenshots.length} capture${screenshots.length === 1 ? "" : "s"}. Masking is applied at capture time and cannot be undone or re-applied later.`
      }
    >
      {screenshots.length === 0 ? (
        <EmptyState>No screenshots captured yet.</EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
          {screenshots.map((shot) => (
            <Shot key={`${shot.path}:${shot.capturedAt}`} shot={shot} runId={runId} />
          ))}
        </div>
      )}
    </Panel>
  );
}
