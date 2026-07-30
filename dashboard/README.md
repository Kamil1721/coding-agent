# agent console

A local, single-user dashboard. You type a ticket in plain prose, pick a model,
and an agent builds the thing end to end — then an acceptance suite it never saw
decides whether it actually works.

**It binds `127.0.0.1` and nothing else.** Anything that can reach the port can
spend your Claude and Codex quota and write files as you, so it is not reachable
off-machine and refuses to start if you ask it to be.

---

## What you need first

One subscription CLI, logged in with **your own plan**. No API key is involved
anywhere, and none is accepted:

```sh
claude setup-token     # Anthropic — long-lived OAuth token in the Claude CLI's own store
```

**Claude only, since 2026-07-30.** The Codex provider was scoped out on
2026-07-28 (spec section 14) and the owner removed the metered Kimi and DeepSeek
rows on 2026-07-30: `GET /api/models` now serves Anthropic rows and nothing else.
`codex login` is no longer worth running for this dashboard — the builder stays in
the tree, no run may select it, and `POST /api/runs` says so if you ask for it by
id. `/api/health` still reports `codexAuth`; nothing in the UI renders it.

`GET /api/health` tells you when the Claude login is missing, and the UI prints
the exact command with a copy button. You can run the dashboard with no login at
all: the model dropdown says nothing in it can run, states why, and submitting a
ticket is refused cleanly instead of failing halfway through a build.

Also needed:

- **Node ≥ 24**, **Docker** (the acceptance gate runs in a container).
- The **bake-off harness built**. The server imports `bakeoff/dist/*.js`, so a
  bake-off tree that has never been compiled produces a module-not-found error
  at startup, not a helpful message.
- The **scorer image built**, `bakeoff-scorer:1`.

---

## Start it

```sh
# 1. the harness the dashboard reuses  (once, and after any edit to bakeoff/src)
cd ../bakeoff
npm install
npm run build
docker build --provenance=false --sbom=false \
  -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .

# 2. the run service — the API on 127.0.0.1:4176
cd ../dashboard/server
npm install
npm start

# 3. the UI — 127.0.0.1:4319, in a second terminal
cd ../dashboard
npm install
npm run build && npm start        # or `npm run dev`
```

Open <http://127.0.0.1:4319>.

The UI proxies `/api/*` to `127.0.0.1:4176`. That rewrite is **baked in at
`next build` time**, so if you override `DASHBOARD_API_ORIGIN` you must rebuild;
`next start` never re-reads the config.

---

## What it does

1. **spec** — an Opus-class seat reads your ticket text and writes an acceptance
   suite **before any code exists**, audited against a bad-test checklist and
   then frozen by content digest. Part of the suite is copied into the workspace
   as a feedback signal; the rest is held out.
2. **build** — the Claude Agent SDK or the Codex SDK builds in its own
   git-initialised workspace, sandboxed, writing nowhere else.
3. **gate** — tier-0 gates (build, boot, routes, screenshots, stub markers,
   reward-hack markers) plus the frozen suite, executed in a `--network=none`
   container from an image pinned by content digest, against a staged copy of
   the artefact with `.git` and `.bakeoff` stripped.
4. **judge** — a second model reads the diff and comments. **Never gates.**

Two numbers come out. `heldOutPass` — did the suite it never saw go green.
`falseFinish` — did the agent declare the ticket done while it had not. The
second one is the one worth watching; it is the failure mode that ships a broken
app with a confident summary.

## What it does not do

- **No dollar figures for subscription runs, ever.** Quota is consumed, not
  billed. The UI shows token counts and rate-limit state and says "Included in
  your plan". There is no cost column in the database and the SDK's own
  `total_cost_usd` is dropped at the boundary.
- **`deploy: true` is not a deployment.** It serves the artefact on `127.0.0.1`
  from this machine. Nothing is published anywhere.
- **It is not the bake-off.** The bake-off builder runs inside a pinned
  container with egress denied — a measurement control. This builder runs on the
  host, because a personal tool that cannot `npm install` cannot build anything.
  A dashboard run and a bake-off run are not comparable, and nothing the
  dashboard writes is stored where the campaign's `score`/`report` would find it.
  This difference also weakens one boundary — see **STATUS.md, "The held-out
  boundary"**, and read it before you trust a `heldOutPass`.
- **It does not answer questions.** A run that needs your input has nowhere to
  put the question; it parks as `awaiting_input` and you resume it.
- **Rate limits are expected, not errors.** The Claude subscription enforces a
  5-hour rolling window plus a weekly cap. A limited run persists, shows a
  countdown, and resumes into the same provider session.

---

## Configuration

Every one of these is optional, and **none of them is ever a credential.**

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_HOME` | `dashboard/` | Root of all dashboard state. Refused if inside `bakeoff/`. |
| `DASHBOARD_PORT` | `4176` | API port. |
| `DASHBOARD_HOST` | `127.0.0.1` | **Only `127.0.0.1` is accepted.** Anything else and the process exits 2. |
| `BAKEOFF_SCORER_IMAGE` | `bakeoff-scorer:1` | Scorer image. Pin it by digest. |
| `BAKEOFF_SCORER_TIMEOUT_MIN` | harness default | Hard boundary on one scoring container. |
| `DASHBOARD_SPEC_MODEL` | `default` | Model for the spec and judge seats. |
| `DASHBOARD_SEAT_MAX_TURNS` | `8` | Turn cap for a seat call. A measured floor, not a bound. |
| `DASHBOARD_ALLOW_UNSANDBOXED_BUILDER` | unset | `1` lets a build run when the CLI sandbox cannot start. Deliberate opt-out. |
| `DASHBOARD_API_ORIGIN` | `http://127.0.0.1:4176` | UI → API origin. **Build-time only.** |
| `DASHBOARD_LIVE_SMOKE` | unset | `1` runs the two tests that spend a small amount of quota. |

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_BASE_URL` and
nine relatives are **stripped from every subprocess this program spawns**,
including the login probes. If one were left in place, the CLI would
authenticate as a billed API client while the dashboard reported no cost. You do
not need to unset them; the dashboard does it for you.

---

## Layout

```
dashboard/
  server/          the run service and HTTP API (Node, no framework)
  src/             the UI (Next.js, React, Tailwind)
  data/runs.db     SQLite: runs, events, criteria, screenshots. No cost column.
  runs/<id>/       workspace/ (the artefact) and results/ (logs, prompt, run record)
  acceptance/      the sealed suite store — DO NOT put a workspace in here
  results/         score records, screenshots, scorer staging
```

---

## The HTTP API

Eight routes, plus one for serving screenshots.

```
POST   /api/runs                        {ticketText, modelId, deploy?} -> {runId}
GET    /api/runs                        RunSummary[]   (newest first)
GET    /api/runs/:id                    RunDetail
GET    /api/runs/:id/events             text/event-stream (live trace, resumable
                                        with Last-Event-ID)
POST   /api/runs/:id/cancel             {ok:true}
POST   /api/runs/:id/resume             {ok:true}
GET    /api/models                      ModelOption[]
GET    /api/health                      {ok, claudeAuth, codexAuth}
GET    /api/runs/:id/screenshots/:file  a capture, by basename
```

`costUsd` is `null` on every subscription run and always will be.
`heldOutPass: null` means the gate could not run — which is not the same as the
gate saying no, and is not rendered as a failure.

---

## Tests

```sh
cd server && npm test     # 41 pass, 2 skipped (the skipped two spend quota)
```

The two skipped tests need `DASHBOARD_LIVE_SMOKE=1` and a Claude login. Nothing
else in the suite touches a provider.

---

## Read this before the first real run

`STATUS.md`, next to this file. It separates what has been **executed** from
what merely typechecks, and it names one boundary that is genuinely weaker here
than in the bake-off.
