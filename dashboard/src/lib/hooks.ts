"use client";

import useSWR, { type SWRResponse } from "swr";

import type { HealthState, ModelOption, RunSummary } from "./api-types";
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

export function useHealth(): SWRResponse<HealthState, unknown> {
  return useSWR<HealthState>(KEY.health, swrFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
}
