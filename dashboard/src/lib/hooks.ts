"use client";

import useSWR, { type SWRResponse } from "swr";

import type {
  HealthState,
  ModelOption,
  ProjectsResponse,
  RunSummary,
} from "./api-types";
import { KEY, swrFetcher } from "./api";

export function useRuns(): SWRResponse<readonly RunSummary[], unknown> {
  return useSWR<readonly RunSummary[]>(KEY.runs, swrFetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
}

export function useModels(): SWRResponse<readonly ModelOption[], unknown> {
  return useSWR<readonly ModelOption[]>(KEY.models, swrFetcher, {
    // The model list changes when a credential appears or a key is removed.
    // Slow refresh is enough; the health panel carries the urgent signal.
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
}

/**
 * The published folders and what is serving them.
 *
 * 5 s, THE SAME AS `useRuns`, AND THE REASON IS NOT SYMMETRY. A child can die
 * on its own at any moment — a port collision inside the project's own code, a
 * crash after a request — and the only way this UI learns about it is the next
 * list. Slower than the runs list would mean a `running` chip and a link that
 * both outlive the process behind them.
 *
 * `keepPreviousData` so a tick landing mid-read does not blank a list the owner
 * is pointing at; the route reads a directory and an in-memory map, so it is
 * cheap enough to poll while a page is open.
 */
export function useProjects(): SWRResponse<ProjectsResponse, unknown> {
  return useSWR<ProjectsResponse>(KEY.projects, swrFetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
}

export function useHealth(): SWRResponse<HealthState, unknown> {
  return useSWR<HealthState>(KEY.health, swrFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
}
