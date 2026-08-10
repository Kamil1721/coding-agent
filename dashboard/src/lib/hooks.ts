"use client";

import useSWR, { type SWRResponse } from "swr";

import type {
  HealthState,
  ModelOption,
  ProjectsResponse,
  RunSummary,
  SupervisorState,
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

/**
 * The autonomy loop's read-out. DESIGN §7.6.2.
 *
 * 5 s, MATCHING `useRuns`, because this is the only surface that answers "is it
 * moving" and a slower poll is a longer window in which a dead loop still reads
 * as alive.
 *
 * `keepPreviousData` IS ON, AND IT IS THE REASON `classifySupervisor` TAKES
 * `error` AS A SEPARATE INPUT. With it, a failed poll leaves the last good body
 * in `data` — which is what you want for reading history and exactly what you
 * must not paint as live state. SWR reports both at once; the classifier's arm 2
 * is what keeps them apart. `errorRetryCount: 0` is deliberate too: the strip
 * would rather show "unreachable" for five seconds than hide a dead backend
 * behind a retry ladder.
 */
export interface TimedSupervisorState {
  readonly body: SupervisorState;
  /**
   * WHEN THIS CLIENT RECEIVED IT. Stamped in the FETCHER, not in a ref or an
   * effect, because freshness is a property of the fetch and nowhere else can
   * see the moment it resolved. Without it a suspended tab paints a live green bar
   * for as long as it stays suspended.
   *
   * THE WIRE DOES CARRY A SERVER STAMP (`SupervisorState.at`, corrected 2026-08-10
   * — this comment used to say it did not) AND NOTHING AGES AGAINST IT YET. The
   * strip renders both clocks in its detail pane; ageing against the server's
   * would additionally catch a route answering instantly with an hour-old
   * computation, at the price of two machines' `Date.now()` skew becoming a new
   * false alarm. Carried forward deliberately, not overlooked.
   */
  readonly receivedAtMs: number;
}

export function useSupervisor(): SWRResponse<TimedSupervisorState, unknown> {
  return useSWR<TimedSupervisorState>(
    KEY.supervisor,
    async (path: string): Promise<TimedSupervisorState> => ({
      body: await swrFetcher<SupervisorState>(path),
      receivedAtMs: Date.now(),
    }),
    {
      refreshInterval: 5_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
      shouldRetryOnError: false,
    },
  );
}

/**
 * THE TICKET CENSUS, AND THE BODY IS DELIBERATELY `unknown`.
 *
 * WHY IT IS NOT TYPED `SupervisorTicketCensus` HERE. `swrFetcher` casts; it
 * validates nothing. Declaring the parsed JSON as the census would hand the
 * component a value whose declared type is a promise no code has kept, and the
 * component would then dereference `census.tickets.filter` on it. That is exactly
 * the crash `classifySupervisor` was refactored to close on 2026-08-10 — see the
 * docblock on `SupervisorReadingInput`, which records why the pre-parsed
 * `attempts` input was REMOVED: `.map` ran on an unvalidated field inside the
 * function whose job was to survive an unvalidated body. `unknown` makes the
 * validator unavoidable.
 *
 * 15 s, NOT 5 s, AND THE ASYMMETRY IS ON PURPOSE. `useSupervisor` answers "is it
 * moving", which goes stale in seconds. This answers "how did the night end",
 * which changes only when a ticket reaches a terminal state. A third of the poll
 * rate against a route that reads every row of `supervisor_tickets` is the cheaper
 * side of a trade with no cost to the reading: the strip's freshness arm ages the
 * STATE reading, and the census is reported as a count with its own age.
 *
 * `keepPreviousData` IS OFF, WHICH IS THE OPPOSITE CHOICE FROM `useSupervisor`
 * AND IS THE SAFER ONE HERE. There is no stale-clock arm for the census: a kept
 * body would be aged against nothing and rendered as a current count. A count is
 * the one thing on this strip that reads as fact — "6 done, 0 blocked" carries no
 * hint of its own age — so when the read fails the honest output is that the
 * census could not be read this poll, not last poll's numbers wearing this poll's
 * confidence.
 *
 * `shouldRetryOnError: false` because the expected error today is a 404: the GET
 * has no producer, and a retry ladder against a route that does not exist is
 * noise that also delays the honest "this build has no census" sentence.
 */
export function useSupervisorTickets(): SWRResponse<unknown, unknown> {
  return useSWR<unknown>(KEY.supervisorTickets, swrFetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
    keepPreviousData: false,
    shouldRetryOnError: false,
  });
}

export function useHealth(): SWRResponse<HealthState, unknown> {
  return useSWR<HealthState>(KEY.health, swrFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
}
