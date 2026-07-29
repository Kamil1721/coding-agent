# The six frozen reference tickets

doc 03 section 7.1. Six tickets, two per tier, frozen verbatim, hashed. They are
the entire input side of the bake-off: five configurations build the same six
briefs, and every rate in the results table has six (or, in the finals, twelve)
in its denominator.

| File | id | Tier | What it is for (doc 03 section 7.1) |
|---|---|---|---|
| `T1-photography-portfolio.md` | T1 | trivial | Establishes the floor; catches harness bugs cheaply |
| `T2-grooming-one-pager.md` | T2 | trivial | Second floor sample |
| `T3-job-tracker.md` | T3 | medium | The modal ticket |
| `T4-bakery-dashboard.md` | T4 | medium | Second modal sample |
| `T5-golf-app.md` | T5 | hard | **The ticket the product is sold on** |
| `T6-music-school.md` | T6 | hard | Second hard sample; the long-horizon regime |

`FROZEN.json` maps each id to the sha256 of its brief. Digests, sizes and titles:
`npm run build && node dist/tickets-cli.js list`.

---

## READ THIS FIRST: these are reference briefs, not the owner's tickets

**They were written by the harness, not by a customer.** doc 03 section 7.1 gives
worked examples ("portfolio site", "CRUD app with auth", "build me a golf app")
and these are those examples, written the way a real user types. They are good
enough to shake out the harness and to produce a defensible measurement, but the
protocol's whole purpose is to replace modelled numbers with measured ones **from
the owner's own tickets**, and a brief the owner did not write measures the
harness against fiction.

**Replace them before spending the campaign budget (~$3,170 planned, $3,500
ceiling).** Paste in six real briefs — the actual text a customer sent, warts and
typos intact — keeping the ids and tiers, then:

```
rm tickets/FROZEN.json
npm run build && node dist/tickets-cli.js freeze
```

You cannot do this by accident: the moment a brief's bytes change,
`verifyFrozen()` refuses to let anything run, score or report until the set is
deliberately re-frozen. That refusal is the provenance check. There is no flag
that silences it.

If you keep these briefs, say so in the experiment log alongside the set digest,
so nobody later reads the results as measurements on real customer work.

---

## What a builder is given

**`Ticket.brief`. Nothing else.** Not the file, not the frontmatter, not the
filename, not the tier, not the title. Route every builder prompt through
`briefForBuilder()` in `src/tickets.ts`.

**This directory is never mounted or copied into a build workspace.** It holds
all six briefs, all six tier labels and the freeze file; a builder that can read
it can read the other five tickets and its own difficulty label.
`BUILDER_FORBIDDEN_PATH_PREFIXES` in `src/config.ts` lists `acceptance/`,
`.bakeoff/suite/` and `.bakeoff/ledger/` and is frozen, so this rule lives here:
the runner passes `briefForBuilder(ticket)` as a string and gives the workspace
no path to `tickets/`.

The lazy implementation — `cat`-ing the `.md` into the prompt — hands the builder
`tier: trivial`, which is a difficulty label no real user supplies, and
`title: Photographer portfolio site`, which is a one-line summary the harness
wrote. Either turns "how much effort should I spend on this?" into a question the
harness answered rather than one the model was measured on. The frontmatter
exists so the *harness* can index the set; it is deliberately outside the digest
for the same reason.

## Why the briefs look underspecified

Because that is the measurement. A real user does not write a specification: they
write two paragraphs about a spreadsheet that keeps breaking, forget to mention
the thing that matters, contradict themselves about prices, and finish with "and
please make sure it actually works". The bake-off asks whether an agent can turn
that into something a sealed, held-out acceptance suite will pass.

So: no brief here is secretly a spec. None of them names a framework, a database,
an endpoint shape or a test command. Several leave a genuine hole (T1 never says
what the contact email is; T2 says the prices are approximate and might change;
T5 wants offline behaviour without saying what "works offline" means). Filling a
hole sensibly, or reporting `BLOCKED` on it, are both first-class outcomes —
`BLOCKED` is a run status, not a failure (doc 03 section 8.3).

### What each tier is exercising

- **Trivial (T1, T2).** One page, no persistence, no auth. If a configuration
  cannot pass these, the finding is almost certainly a harness bug, and finding
  it here costs a few dollars instead of a few hundred. T2 additionally carries a
  small amount of contradictory input (prices "roughly 30 / 45 / 60 but don't
  hold me to that") to see whether the agent invents certainty.
- **Medium (T3, T4).** The modal ticket: a data model plus authentication (T3) or
  a data model plus aggregation over time (T4). T3 asks for multi-user access
  control and an audit trail without using either phrase. T4 asks for recurring
  standing orders with per-week exceptions, which is the point where a naive data
  model stops working.
- **Hard (T5, T6).** Data model + external API + persisted state + tests, over a
  long horizon. T5 is the golf app doc 03 names as the ticket the product is sold
  on: course data from somewhere external, rounds persisted, offline capture, two
  users comparing, and "the last thing I had built looked finished and then lost
  two rounds" — a customer describing a false finish in their own words. T6 is
  scheduling plus money that must reconcile against itself, with an import of
  existing data and business rules the user says they argue about every term.

**T5 and T6 are the two hardest tickets, so they are the finals tickets** (doc 03
section 7.7: top 2 configurations x 2 hardest tickets x 3 repeats = 12 runs).

---

## The freeze rule

**The ticket text is frozen verbatim and NEVER edited between runs** (doc 03
section 7.1). A brief that changes mid-campaign changes what is being measured
while the results table goes on claiming the runs are comparable — and nothing
downstream can detect it afterwards. The pass rate simply moves, and the move
gets attributed to the model.

### What is hashed

> sha256 of every byte of the file **after the newline that terminates the
> closing `---` fence**, taken as raw UTF-8 with **no normalisation**: no
> trimming, no newline conversion, no Unicode normalisation, no BOM stripping.

This rule is normative. It is stated here, implemented once in
`ticketDigest()` (`src/hash.ts`) and `parseTicketFile()` (`src/tickets.ts`), and
copied into `FROZEN.json` as `digestScope`. **A reimplementation that trims the
brief, or converts newlines, changes all six digests at once without any error
firing** — the freeze would refuse the entire set and look like tampering.

Consequences worth knowing:

- Deleting the trailing newline of a brief is drift. Adding a trailing space is
  drift. This is deliberate: a digest that ignores whitespace cannot tell you
  whether the text a builder received changed.
- CR bytes, NUL bytes and BOMs are **rejected at load**, never normalised, so a
  Windows editor cannot silently rewrite a brief. `tickets/.gitattributes` pins
  `-text` for this directory, which covers the other half of the same failure:
  a checkout that converts line endings on a machine that never opened a ticket.
- The frontmatter is **not** hashed. Fixing a typo in a `title` is free; fixing a
  typo in a brief is not.

### What the tooling does

```
node dist/tickets-cli.js list      # digests, sizes, titles. Never prints a brief.
node dist/tickets-cli.js freeze    # write FROZEN.json. Idempotent. Refuses on drift.
node dist/tickets-cli.js verify    # the check every run, score and report owes
```

Exit `0` matched, `1` drifted or never frozen (**do not run, score or report**),
`2` a ticket file is malformed.

`node test/tickets.smoke.mjs` (45 assertions, no framework) exercises the freeze
itself: a one-byte edit, a dropped trailing newline, a missing ticket, a
hand-edited `FROZEN.json`, CR/BOM bytes, a credential pasted into a brief.
`tsc --noEmit` type-checks none of that.

`freeze` is idempotent when nothing changed: it returns the existing record with
its original `frozenAt`, and does not re-stamp the date. When a digest differs it
throws instead of overwriting. **There is deliberately no `--force`.** Re-freezing
is a decision to discard collected results, and it should cost a deliberate
`rm tickets/FROZEN.json`.

`FROZEN.json` also carries a `setDigest` over the whole map, recomputed on every
read. Hand-editing one digest so that an edited brief stops failing verification
leaves the set digest behind and is caught. That is not tamper-proof — the set
digest can be recomputed by hand — but "I fixed the hash so it would stop
complaining" is the mistake the check exists to catch.

### If verification fails

Pick exactly one:

1. **Accidental change** — restore the frozen bytes (`git checkout -- tickets/`)
   and re-verify. Nothing is lost.
2. **Deliberate, and no run has been executed** — delete `FROZEN.json`,
   re-freeze, record the new set digest in the experiment log, then **regenerate
   and re-audit the acceptance suite for every changed ticket** (see below).
3. **Deliberate, and runs HAVE been executed** — everything collected under the
   old freeze is incomparable with anything collected after it. Archive the old
   results *with the old set digest*, re-freeze, regenerate and re-audit the
   suites, restart the campaign. **Do not merge the two sets.**

### A changed brief also invalidates its acceptance suite

`AcceptanceSuite.ticketSha256` is the digest of the brief the suite was authored
from, and `acceptanceSuiteDigest()` covers it. So a suite authored from the old
text does not describe the new text, and reusing it produces a
`suite_hash_mismatch` at scoring time that looks like tampering rather than what
it is. **Re-freezing tickets means regenerating and re-auditing every suite for
every ticket whose digest moved.**

The ordering is therefore fixed, and it only runs forwards:

```
freeze tickets  ->  author suites (spec seat)  ->  bad-test audit (judge seat)  ->  build runs  ->  score
```

---

## Two things the next module has to handle

### 1. T5 asks for an external API; the sandbox has no egress

T5 says "can it pull the course info in from somewhere?" and T6 mentions
importing an existing spreadsheet. Held-constant variable 3 seals the network:
`SEALED_NETWORK_POLICY` is `egress: "denied"` with an empty host allowlist, and
the acceptance suite executes in a clean container with no network at all.

That tension is **intentional and left in the brief**. Writing "define an adapter
interface and provide fixtures" into the brief would make it a specification, and
whether an agent invents that boundary on its own is exactly the behaviour worth
measuring. doc 03 section 7.3 item 3 does allow a pinned package-registry mirror;
if you add one, add exactly that host, record it, and never change it
mid-campaign — the allowlist is part of held-constant variable 3.

**T6 is deliberately network-free**, so that at least one hard ticket is
unambiguously buildable in a sealed sandbox. If T5's external dependency turns
out to make every configuration fail identically, T6 still carries the hard tier
and the campaign still produces a signal.

### 2. The spec agent must be told the gate runs offline

The spec seat authors the acceptance suite **from the ticket text alone**. Read
literally, it has no way to know the suite will execute with no network — so it
can write a criterion that requires a live call to a golf course API, the
adversarial audit has no reason to flag it, and then all five configurations fail
T5 for a reason that has nothing to do with any model.

**Telling the spec agent that the execution environment is offline is environment
specification, not implementation leakage.** Constraint 1 forbids the spec seat
seeing an *implementation*; it does not forbid it seeing the sandbox policy. The
spec agent's prompt should state the sealed network policy and the container it
will run in, and the bad-test auditor should treat "requires network egress" as a
`mis_specified` finding. This is a note for whoever builds
`AcceptanceSuiteAuthor` and `AcceptanceSuiteAuditor`; it cannot be fixed here,
because fixing it here would mean writing sandbox details into a customer's
brief.

---

## Adding, removing or renumbering tickets

The set is pinned to `REFERENCE_TICKET_SLOTS` in `src/config.ts`: six ids, six
tiers. `loadTickets()` throws if a file is missing, if there is a seventh, or if
a tier disagrees with its slot. Changing the set is changing the experiment — six
is the denominator every rate is computed over — so it takes an edit to
`config.ts` and the acknowledgement that no earlier result is comparable.

File naming is free (`T5-golf-app.md` is for humans; the loader matches on
frontmatter `id`), but one id per file. `README.md` is skipped; every other `.md`
in this directory must be a valid ticket.
