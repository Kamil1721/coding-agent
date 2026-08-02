# The ticket to paste — portfolio site from the CV + the Gemini design board

Attach both files to the ticket: `Kamil_Borzecki_CV.pdf` and the design board PNG.
Set **Design → "Ask me which mockup to build"** so you get to steer the sketch look
before the build commits. Leave **Delivery → deploy a preview** off.

## Why the brief is written the way it is

Three measured facts shaped it. They are not style preferences.

1. **The design image never reaches the acceptance-criteria author.** Reference
   images go to the design lane and the builder only (`orchestrator.ts:1962`, `:1969`).
   The spec seat is built with `tools: []` and is not even told an image exists. So
   **every visual property you want graded has to be in the words.** The board is
   still worth attaching — the design lane and the builder both see it — but it
   cannot become a criterion on its own.
2. **The CV does reach the criteria author** (`orchestrator.ts:1500` — the run logs
   *"the spec seat will see N attached document(s) on every call"*). So content can
   be sourced from the PDF and the brief does not need to restate it.
3. **Grading runs `docker run --network=none`, with no credentials.** Anything
   needing a hosted database, an email provider or a third-party login is graded
   against whatever stub gets built, which can pass as easily as fail. A backend that
   is genuinely testable has to be self-contained.

   Measured this session, inside the real scorer image: `node:sqlite` works on
   `v24.18.0` with `--network=none`, unflagged. So a real HTTP server with real
   persistence and **zero npm dependencies** is achievable. The build itself has
   unrestricted network (it runs as a host subprocess), but the gate does not — so
   anything installed at build time must be vendored into the artefact or it is gone
   by the time it is judged.

---

## THE BRIEF

Build my personal portfolio site — a real application with a working backend, not a
static page with a decorative contact form.

**Content comes from the attached CV** (`Kamil_Borzecki_CV.pdf`). Take the roles,
dates, projects, skills and contact details from it. Do not invent employers,
job titles, dates or numbers. If the CV is ambiguous about something, leave it out
rather than filling the gap.

### The look

The attached design board is the direction. In words, so it can be graded:

Hand-drawn sketchbook, not a template. Warm off-white paper background with faint
coloured-pencil scribble at the edges of the viewport. Content sits on slightly
tilted white paper cards with soft drop shadows and thin dark hand-inked rules, as
if photographed on a desk. Headings are large, uppercase, condensed and hand-lettered
in near-black. Body copy is a plain readable serif or humanist sans at normal weight —
the drawing carries the personality, the text does not need to. Illustrations are
coloured-pencil style line art with visible hatching, in a restrained palette of
purple, orange, green, red and blue on paper white. Buttons are small outlined pills
with lowercase labels. Section flows are numbered with circled digits and hand-drawn
curved arrows between steps. Top navigation is a single row of uppercase links with a
hand-drawn underline under the active one.

No gradients, no glassmorphism, no neon, no dark mode. If it could have come out of a
generic component library, it is wrong.

### Pages

`/` — hero with my name, role and one line about what I do; a short "selected work"
strip pulled from the CV.
`/work` — every project from the CV as its own paper card: title, what it is, the
stack, my role.
`/about` — the career narrative, roles and dates from the CV, and the skills list.
`/contact` — the form described below.

### The backend — this is the part that must actually work

**This is not a static site.** It is a server-rendered application with an HTTP API and
a database and it must be graded as one. The server starts with `npm start`, listens on
the port given in `PORT` and defaults to **3000**, and answers `GET /api/health` with
`200` and `{"ok":true}`. Persisted data is the point of this project, not decoration:
the contact form writes to a database and a later request reads it back.

A Node HTTP server. **Zero runtime npm dependencies**: Node's own `node:http`,
`node:sqlite` and standard library only. It must start with `npm start` and serve
every page and API route from one process. Persist to a SQLite file on disk via
`node:sqlite`, created automatically on first boot if it does not exist.

- `POST /api/contact` — accepts `{name, email, message}` as JSON. Validates all three:
  name non-empty, email structurally valid, message at least 20 characters. Rejects
  with **HTTP 400** and a JSON body naming *which* field failed. On success stores the
  message with a timestamp and returns **HTTP 201** with the new record's id.
  **An empty or invalid submission must never be stored and must never return a
  success response** — the contact form is the one thing on this site that has a
  server behind it, and a form that confirms a submission it discarded is the failure
  I care most about.
- `GET /api/messages` — returns stored messages as JSON, newest first. Requires a
  bearer token read from an environment variable at boot; **401 without it, 401 with
  the wrong one**. If the variable is unset the route stays available and refuses
  every request rather than opening up.
- `GET /api/projects` — the CV's projects as JSON, served from the database rather
  than hardcoded in the page, seeded on first boot.
- `GET /api/health` — `200` with `{"ok":true}`.
- Every unknown path returns a real **404** page in the site's own visual style,
  not a stack trace and not a blank body.

The contact page must post to `/api/contact` for real and render the server's
response — the field-level error on a 400, a confirmation on a 201. No optimistic
"thanks!" that appears before the server has answered.

Rate-limit `POST /api/contact` to a handful of submissions per minute per IP, in
memory, and return **429** past that.

### You cannot open a port while building this, so build it to be testable without one

The build sandbox denies `listen()` on every port with `EPERM`. That is measured, not a
guess. So you cannot start this server to check your own work, and you must not pretend
otherwise or leave it untested until someone else runs it. Structure it so everything is
testable without binding a socket:

- Put request handling in an **exported router function** — `handle(req, res)`, or a
  pure `route(method, path, headers, body)` returning `{status, headers, body}`.
  `server.mjs` does nothing but wire that function to `node:http`. `listen()` appears in
  exactly one place and nothing else depends on it.
- Put every database access behind functions that take a database handle as an argument,
  so a test can open a temporary SQLite file and call them directly.
- Write `node --test` tests that call the router and those functions directly, with no
  socket anywhere. Every item in "how I will know it works" below must be covered by one
  of them — the 400 on each invalid field, the 201, the 401s, the 429, the survival of
  the data across a reopen.
- Run those tests and get them passing before you declare done, and say how many there
  are in your self-report. Do not write a test that needs a listening server; it will
  fail with `EPERM` and teach you nothing.

### Constraints

Runs entirely offline. No external API, no hosted database, no email provider, no
analytics, no third-party fonts or CDN — embed or self-host every asset. No secrets in
the repository; the one token is read from the environment.

Responsive at 1440px, 768px and 375px. The nav collapses on a phone and every page
stays readable with no horizontal scrolling. Keyboard-navigable throughout, visible
focus rings, alt text on every illustration.

### How I will know it works

- `npm start` boots on one port and serves every page and every API route.
- Submitting the contact form with a blank message shows a field error and stores
  nothing; `GET /api/messages` with the right token proves the count did not change.
- Submitting a valid message returns 201, and that message then appears in
  `GET /api/messages`.
- `GET /api/messages` with no token and with a wrong token both return 401.
- Killing the server and starting it again still returns the messages that were
  submitted before the restart.
- Every project on `/work` traces to a line in the attached CV.
- All four pages render in the sketchbook style at 1440, 768 and 375 with no
  horizontal scroll.

---

## After you paste it

The design lock will pause the run and show you mockups. **Look at them against the
board before picking** — that pause is the cheapest correction available, and it is
the only point where a wrong visual direction costs minutes instead of hours.

Watch the first few minutes of the run log for the line
`the spec seat will see 1 attached document(s) on every call`. If it does not appear,
the CV did not reach the criteria author and the run is being graded on guesses —
cancel and re-attach rather than spending the quota.

When the verdict lands, check `inferredCriteria` on the run. The run that passed
recorded 2; the run that failed recorded 16 with *zero criteria traced to words you
wrote*. This brief is long specifically to push that number down.
