"use client";

import type { ReactNode } from "react";

import type { GateHealth, HealthState } from "@/lib/api-types";
import type { Tone } from "@/lib/presentation";
import { useHealth } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { Badge, CommandLine, Panel, Skeleton } from "./ui";

/**
 * ONE PROVIDER ROW, BECAUSE ONE PROVIDER CAN RUN A TICKET (2026-07-30).
 *
 * "One row" is about providers only — the panel renders a second, non-provider
 * row below this list for the scorer gate (see `gateBadge`), which is not an
 * auth probe and is not in this table.
 *
 * This panel used to render two: Anthropic via `claude setup-token`, and OpenAI
 * via `codex login`. The OpenAI row is gone — not because the probe stopped
 * working, but because the owner scoped the Codex provider out on 2026-07-28
 * (spec section 14), so `/api/models` no longer offers a Codex model and nothing
 * on this screen can select one. A row telling the owner to run `codex login`
 * would be an instruction to fix something that would still not be selectable
 * afterwards — the same wrong-remediation defect the server's 409 avoids.
 *
 * `/api/health` STILL REPORTS `codexAuth`, and that is deliberate rather than
 * missed: the field is part of the frozen contract, `auth.ts` probes both CLIs,
 * and narrowing the wire because one renderer stopped reading it is a larger
 * change than a UI request should make. It has no reader in this client now.
 *
 * The Moonshot and DeepSeek models this docblock used to mention were removed by
 * the owner on the same day; they were metered API-key vendors and never had a
 * health field at all.
 */
const SUBSCRIPTION_PROVIDERS = [
  {
    key: "claudeAuth",
    name: "Anthropic",
    command: "claude setup-token",
  },
] as const satisfies readonly {
  key: keyof Pick<HealthState, "claudeAuth">;
  name: string;
  command: string;
}[];

/**
 * THE SCORER GATE, AS A BADGE — THREE STATES, AND ONLY THE LITERAL `"ok"` IS
 * GREEN (2026-07-30).
 *
 * WHY THIS ROW IS ON THE TICKET SCREEN. Nothing touched the docker daemon until
 * `#gatePhase`, which runs after the spec phase and after the whole build —
 * ~1h45 on the owner's recorded run. With the daemon down or the scorer image
 * missing, all of that time is spent and the run ends `unscored`, with no
 * preview and no way to re-score (`http.ts` refuses to resume a terminal run).
 * The answer is cheap and the failure is total, so it belongs in front of the
 * owner BEFORE he submits. The probe is `server/src/health-gate.ts`; it builds
 * the gate with the same `createGate(gateEnv(...))` call the run uses, so an
 * `ok` here answers for the configuration the gate phase will actually get.
 *
 * `unknown` IS NOT A DEGRADED `ok`, WHICH IS THE ONLY REASON THIS FUNCTION IS A
 * SWITCH. A two-tone `state === "unavailable" ? warn : pass` would paint a gate
 * nobody has checked as a healthy one — the exact failure the row exists to
 * prevent. `pass` is reachable from the literal `"ok"` and from nothing else,
 * and the `default` arm (reachable: the wire can carry a value outside the
 * frozen union, the same reason `presentation.ts:27-31` gives) lands on
 * `neutral` rather than on either coloured state.
 *
 * WHAT "docker ok" CLAIMS, AND IT IS DELIBERATELY NOT "ready". Per
 * `health-gate.ts:23-31` an `ok` means: the docker CLI was on PATH, the daemon
 * answered, and the configured scorer image resolved to a digest. It does NOT
 * prove a `--network=none` container can run, does not prove any ticket's frozen
 * suite exists, and is not a promise about the state ~1h45 from now — the probe
 * is cached for at least a minute, so even the present tense is approximate.
 * The badge names the measurement; `checkedAt` rides in its tooltip.
 *
 * THE OPTIONAL READ BELOW CONTRADICTS `HealthState` ON PURPOSE. The type says
 * `gate` is always there and it is right about the real server, but three
 * fixtures still serve a health body with no `gate` key —
 * `dashboard/tests/fixtures/api-server.ts:100`,
 * `dashboard/tests/design-lock.browser.spec.ts:197` and
 * `dashboard/tests/model-picker.browser.spec.ts:142` — and this panel mounts on
 * the home page (`app/page.tsx:206`) that those specs load. A bare
 * `data.gate.state` is a TypeError `tsc` cannot see. So the absent field is read
 * as `undefined` and routed into the SAME neutral branch as `"unknown"`: two
 * independent reasons to know nothing, one visual result, never a green tick.
 * Those fixtures are the thing that has to change; this file must not be edited
 * back to a non-optional read until they carry the field.
 */
function gateBadge(state: GateHealth["state"] | undefined): {
  readonly tone: Tone;
  readonly label: string;
} {
  switch (state) {
    case "ok":
      return { tone: "pass", label: "docker ok" };
    case "unavailable":
      return { tone: "warn", label: "unavailable" };
    default:
      return { tone: "neutral", label: "not probed" };
  }
}

/**
 * The gate row. Same shape as a provider row: fixed label column, badge, and the
 * remediation only when there is something to remedy.
 *
 * THE REASON IS SHOWN INLINE ONLY ON `unavailable`, because that is the only
 * state whose text the owner has to act on. `ok`'s detail is the resolved image
 * digest and `unknown`'s is two clauses of prose saying what the badge already
 * says in two words; both ride in the badge tooltip with `checkedAt` instead of
 * spending a line on this screen. (On `unavailable` the tooltip repeats the
 * inline text — that is the cost of putting `checkedAt` in one place.)
 *
 * SO THIS ROW CAN SHOW A STALE `ok` WITH NO SIGN OF IT, and that is worth
 * naming rather than hiding. SWR keeps the last successful `data` when a later
 * poll errors, and `AuthPanel`'s error branch only fires while `data` is still
 * undefined — so a dashboard that has lost the server entirely keeps rendering
 * whatever the last good `/api/health` said, this row included. The provider row
 * above has had the same behaviour since it was written and it is not this
 * change's to fix; the difference is that the gate's contract is explicitly
 * about time (`health-gate.ts:196-200`: an answer can lag reality by the TTL
 * plus one poll) and the only timestamp is in a tooltip. If that trade turns out
 * to be wrong, the fix is a stale marker on the panel, not a second timestamp
 * on this row.
 *
 * `whitespace-pre-line`, AND NO `CommandLine`. `describeError`
 * (`server/src/orchestrator.ts:3107-3112`) formats a `BakeoffError` as
 * `[code] message\nfix: <remediation>`, and for the common failure the
 * remediation is the literal `docker build …` that fixes it — so the newline has
 * to survive or the command runs into the sentence. It is NOT parsed out into a
 * `CommandLine` the way the auth row's fixed command is: a plain `Error` (docker
 * missing from PATH, a spawn failure) goes through the second branch of
 * `describeError` and carries no `fix:` line at all, so a parser would render an
 * empty command box on exactly the paths it was added for.
 */
function GateRow({ gate }: { gate: GateHealth | undefined }): ReactNode {
  const { tone, label } = gateBadge(gate?.state);
  /*
   * `checkedAt` is raw ISO on purpose: it is a tooltip, not a headline, and
   * `formatClock` would be a locale-dependent string. (The hydration hazard that
   * usually implies is absent here — SWR has no data during SSR, so this branch
   * renders client-side only — so this is a terseness call, not a correctness
   * one.) Left `undefined` when the field is absent rather than invented: there
   * is no server sentence to quote, and `exactOptionalPropertyTypes` means the
   * absent case must be an absent PROPERTY, hence the spread below.
   */
  const tooltip =
    gate === undefined
      ? undefined
      : gate.checkedAt === null
        ? gate.detail
        : `${gate.detail}\nchecked ${gate.checkedAt}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0">
      <span className="w-[76px] shrink-0 text-[12.5px] font-medium text-ink">Scoring</span>
      <Badge tone={tone} {...(tooltip === undefined ? {} : { title: tooltip })}>
        {label}
      </Badge>
      {gate?.state === "unavailable" && (
        <p className="w-full whitespace-pre-line text-[11.5px] leading-relaxed text-ink-dim">
          {gate.detail}
        </p>
      )}
    </li>
  );
}

export function AuthPanel(): ReactNode {
  const { data, error, isLoading } = useHealth();

  return (
    /*
     * SUBTITLE REMOVED 2026-07-30. It read "Claude runs from your own plan login. No
     * API key is involved." — addressed to the person who ran `claude setup-token`
     * himself. The panel's job is the signed-in/not-signed-in state and the command
     * to fix it; everything else here was reassurance nobody needed.
     */
    <Panel title="Subscription auth">
      {isLoading && data === undefined ? (
        <Skeleton rows={2} />
      ) : error !== undefined && data === undefined ? (
        <p className="text-[12px] text-warn">
          Cannot read <code className="font-mono text-[11.5px]">/api/health</code>:{" "}
          {errorMessage(error)}
        </p>
      ) : data === undefined ? null : (
        <ul className="divide-y divide-line">
          {SUBSCRIPTION_PROVIDERS.map((provider) => {
            const ok = data[provider.key] === "ok";
            return (
              <li
                key={provider.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0"
              >
                <span className="w-[76px] shrink-0 text-[12.5px] font-medium text-ink">
                  {provider.name}
                </span>
                <Badge tone={ok ? "pass" : "warn"}>
                  {ok ? "signed in" : "not signed in"}
                </Badge>
                {!ok && (
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-[11.5px] text-ink-dim">run</span>
                    <CommandLine command={provider.command} />
                  </span>
                )}
              </li>
            );
          })}
          {/*
           * PANEL TITLE MISMATCH, LEFT ALONE DELIBERATELY. This row is not
           * subscription auth, so "Subscription auth" now under-describes the
           * panel; the row's own label carries its name. Renaming the heading is
           * a change the owner should make, not one a gate row should
           * self-authorize — no spec reads the string, so it is a one-word edit
           * whenever he wants it.
           */}
          <GateRow gate={data.gate} />
        </ul>
      )}
    </Panel>
  );
}
