/**
 * node-test-reporter.mjs — the machine-readable reporter the FROZEN SUITE's
 * `node --test` pass runs under.
 *
 * This file lives in the scorer image, not in the artefact and not in the
 * suite — exactly like `playwright.config.mjs` beside it, and for exactly the
 * same reason: doc 02 section 5.6 records `conftest.py` monkey-patching
 * pytest's `TestReport` as an exploit Anthropic observed in production RL. A
 * reporter the artefact can supply is a reporter the artefact can lie through.
 * Because the node:test pass loads THIS reporter by absolute path, an
 * artefact-side reporter patch is inert: it patches something never loaded.
 *
 * WHY A CUSTOM REPORTER RATHER THAN A BUILT-IN ONE.
 *
 * Node ships `spec`, `tap`, `dot`, `junit` and `lcov`. None of them is a
 * structured, losslessly-parseable record of what happened:
 *
 *  - `tap` is the usual answer and is the wrong one here. Test names are
 *    escaped into the TAP line, sub-tests are expressed as INDENTATION, and the
 *    only per-test structure is a YAML diagnostic block. Reconstructing an
 *    ancestor title path — which is what REQ-ID attribution needs — means
 *    re-deriving a tree from whitespace and un-escaping names that may
 *    legitimately contain `#`, `\` or a newline. Every one of those is a place
 *    a test title can be mis-attributed, and a mis-attributed title is a
 *    criterion scored against the wrong requirement.
 *  - `junit` is XML. Node ships no XML parser, so it would add a dependency to
 *    the sealed image purely to read it.
 *  - `spec` and `dot` are for humans.
 *
 * The reporter API, by contrast, hands us the fields directly: `data.name`,
 * `data.nesting`, `data.file`, `data.details.type` (`"test"` vs `"suite"`),
 * `data.skip`, `data.todo`, and a per-file `test:summary` carrying authoritative
 * counts. Emitting those as NDJSON means the parse on the other side is
 * `JSON.parse` per line, with no escaping rules of our own invention.
 *
 * The trade is that this file is not typechecked by the harness. It is kept
 * deliberately small, it never throws on a shape it does not recognise, and it
 * is exercised end to end by the scorer fixture rather than trusted by reading.
 *
 * OUTPUT — one JSON object per line, four kinds:
 *
 *   {"kind":"test",   "outcome":"pass"|"fail", "titlePath":[...], "file":"/abs",
 *    "entity":"test"|"suite", "skip":bool, "todo":bool,
 *    "failure":{"name","message","stack","operator","code",
 *               "expected","actual"}|undefined}
 *   {"kind":"summary","file":"/abs"|null, "counts":{...}, "success":bool}
 *   {"kind":"parse-error","detail":"..."}                (never silently dropped)
 *
 * WHY `failure` EXISTS — 2026-08-16, AND WHAT ITS ABSENCE COST.
 *
 * Until this field, a `fail` outcome carried no reason anywhere a machine could
 * read. Runs `e1c15359` and `047f9872` each lost four FUNCTIONAL criteria to one
 * defect, and diagnosing it meant regexing the human-readable `node --test`
 * transcript out of a single string field in `result.json` by hand. The message
 * that settled it — `npm start did not answer /api/health … npm error Missing
 * script: "start"` — existed, in that blob, and nothing downstream could reach
 * it: not the criteria table, not a defect record, not a repair agent. A verdict
 * that says WHICH criterion failed but not WHY is a verdict only a human can act
 * on, and the whole point of the repair lane is that a human is not there.
 *
 * BOUNDED AT THE SOURCE, NOT AT THE READER. Every string here is capped before
 * it is written, because this file's output is parsed by a host that must not be
 * handed a 200MB line by an artefact that throws in a loop. `expected`/`actual`
 * are stringified defensively — an assert error may carry arbitrary objects,
 * including ones with throwing getters or circular references.
 *
 * NOT A SCORING INPUT. Nothing in the harness may decide `heldOutPass` from this
 * field; it is triage evidence. `attributeCriteria` reads `ok`, exactly as
 * before.
 *
 * `titlePath` is the ancestor `describe()` titles followed by the test's own
 * title. The scorer prepends the suite-relative file path, so the resulting
 * string is shaped identically to Playwright's `titlePath` and the ONE REQ-ID
 * attribution rule applies unchanged to both runners.
 *
 * ANCESTRY IS TRACKED PER FILE, NOT GLOBALLY. `node --test` may run files
 * concurrently, which interleaves their events on this single stream. A global
 * stack would splice one file's `describe()` title onto another file's test.
 * The scorer also passes `--test-concurrency=1`, so the interleaving should not
 * arise; keying by file means the reporter stays correct if it ever does.
 */

/** Caps applied HERE so no reader has to defend against an unbounded line. */
const MAX_MESSAGE = 4000;
const MAX_STACK = 4000;
const MAX_VALUE = 1000;

/**
 * Render one value that an assertion carried, without trusting it.
 *
 * `expected`/`actual` are whatever the test threw with: a string, a DOM-ish
 * object, a proxy with a throwing getter, something circular. Every one of those
 * has to come out as a bounded string or not at all — a reporter that throws
 * here loses the entire test record, which is strictly worse than losing one
 * field of it.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function renderValue(value) {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text !== "string") return undefined; // JSON.stringify(fn) -> undefined
    return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…[truncated]` : text;
  } catch {
    // Circular, or a getter that threw. Fall back to the tag rather than nothing:
    // "[object Object]" still tells a reader the shape was not a scalar.
    try {
      return String(value).slice(0, MAX_VALUE);
    } catch {
      return undefined;
    }
  }
}

/** @param {unknown} text @param {number} capAt @returns {string | undefined} */
function cap(text, capAt) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  return text.length > capAt ? `${text.slice(0, capAt)}…[truncated]` : text;
}

/**
 * Structured reason for one failing test, from node's `details.error`.
 *
 * Returns `undefined` when there is nothing to say, so the field is absent
 * rather than present-and-empty — an absent field reads as "no error was
 * attached", an empty one reads as "the error was blank", and those are
 * different facts about the run.
 *
 * @param {unknown} details
 * @returns {Record<string, string> | undefined}
 */
function describeFailure(details) {
  try {
    const raw = details === null || typeof details !== "object" ? undefined : /** @type {any} */ (details).error;
    if (raw === undefined || raw === null) return undefined;

    /*
     * UNWRAP THE TEST RUNNER'S OWN WRAPPER, OR LOSE EVERY USEFUL FIELD.
     *
     * `node --test` does not hand the reporter the error the test threw. It
     * hands you an `Error` with `code: "ERR_TEST_FAILURE"` whose `cause` is the
     * real one. MEASURED 2026-08-16 on node v25.9.0 with a plain
     * `assert.equal("got-this", "wanted-that")`:
     *
     *   top    name "Error"          code "ERR_TEST_FAILURE"   operator/expected/actual ABSENT
     *   cause  name "AssertionError" code "ERR_ASSERTION"      operator "strictEqual"
     *                                                          expected "wanted-that"
     *                                                          actual   "got-this"
     *
     * Reading the top level alone reports every failure in this repo as a
     * nameless `Error` and drops `expected`/`actual` — the two fields a triage
     * agent wants most — on EVERY assertion in the suite. The first version of
     * this function did exactly that; the archived re-score of `047f9872`
     * survived only because that particular failure's message propagated
     * through the wrapper, which made a general defect look like a working one.
     *
     * Narrow on purpose: only `ERR_TEST_FAILURE` is unwrapped. A test that
     * legitimately throws with its own `{cause}` keeps both, folded below.
     */
    const error =
      raw.code === "ERR_TEST_FAILURE" && raw.cause !== null && typeof raw.cause === "object" ? raw.cause : raw;

    /*
     * A thrown non-Error is still a failure reason. DEFENSIVE ONLY, AND SAY SO:
     * probed on node v25.9.0, `throw "just a string"` arrives here already
     * wrapped in an `ERR_TEST_FAILURE` Error carrying that text as its own
     * message, so this branch is NOT reached by the current runner and no test
     * covers it. It is four lines that turn a hypothetical future raw throw
     * from "reason lost" into "reason kept", and it is labelled rather than
     * left to look exercised.
     */
    if (typeof error !== "object") {
      const rendered = renderValue(error);
      return rendered === undefined ? undefined : { name: "Thrown", message: rendered };
    }

    /** @type {Record<string, string>} */
    const out = {};
    const put = (key, value) => {
      if (value !== undefined) out[key] = value;
    };

    put("name", cap(error.name, 200));
    /*
     * NO FALL-BACK TO THE WRAPPER'S MESSAGE, AND THAT IS A MEASUREMENT.
     *
     * A `?? cap(raw.message)` fallback was written here on the theory that a
     * timeout kill carries its text on the wrapper over a message-less cause.
     * MUTATION TESTING KILLED THE THEORY: removing the fallback left every test
     * green, so it was reached by nothing. Probed directly on node v25.9.0 —
     * `throw new Error()` and an error with `cause = {code:7}` both produce a
     * wrapper whose message is EMPTY TOO, and a timeout does not unwrap at all
     * (its cause is not an object), so `error` already IS the wrapper. There is
     * no shape where the cause lacks a message and the wrapper has one.
     *
     * Left as a plain read. Unreachable code with an invented rationale is the
     * defect STATUS.md section 6 counts seventeen of.
     */
    put("message", cap(error.message, MAX_MESSAGE));
    put("stack", cap(error.stack, MAX_STACK));
    put("operator", cap(error.operator, 200));
    // `code` is how an assert failure is told from a TypeError from an ENOENT.
    put("code", cap(typeof error.code === "string" ? error.code : undefined, 200));
    put("expected", renderValue(error.expected));
    put("actual", renderValue(error.actual));

    // An `AssertionError` whose real content is one level down (`assert.rejects`,
    // and anything rethrown with `{cause}`) would otherwise report only its own
    // generic wrapper text.
    const cause = error.cause;
    if (cause !== undefined && cause !== null) {
      const causeText = typeof cause === "object" ? cap(/** @type {any} */ (cause).message, MAX_MESSAGE) : renderValue(cause);
      put("cause", causeText);
    }

    return Object.keys(out).length === 0 ? undefined : out;
  } catch {
    // Defensive to the last: a failure we cannot describe still reports that we
    // could not describe it, which is a fact worth having.
    return { name: "Unreportable", message: "the reporter could not read this test's error object" };
  }
}

/** @param {AsyncIterable<{type: string, data: unknown}>} source */
export default async function* bakeoffNodeTestReporter(source) {
  /** @type {Map<string, string[]>} */
  const ancestry = new Map();

  const stackFor = (file) => {
    const key = typeof file === "string" ? file : "";
    let stack = ancestry.get(key);
    if (stack === undefined) {
      stack = [];
      ancestry.set(key, stack);
    }
    return stack;
  };

  for await (const event of source) {
    try {
      const type = event?.type;
      const data = event?.data ?? {};
      const file = typeof data.file === "string" ? data.file : null;
      const name = typeof data.name === "string" ? data.name : "";
      const nesting = typeof data.nesting === "number" && Number.isFinite(data.nesting) ? data.nesting : 0;

      if (type === "test:start") {
        // Record this node as the ancestor of everything deeper. Truncating at
        // `nesting` drops stale siblings from a previous branch of the tree.
        const stack = stackFor(file);
        stack.length = Math.min(stack.length, nesting);
        stack[nesting] = name;
        continue;
      }

      if (type === "test:pass" || type === "test:fail") {
        const stack = stackFor(file);
        const titlePath = [...stack.slice(0, nesting).map((t) => (typeof t === "string" ? t : "")), name];
        const details = data.details ?? {};
        yield `${JSON.stringify({
          kind: "test",
          outcome: type === "test:pass" ? "pass" : "fail",
          titlePath,
          file,
          nesting,
          // A `describe()` block reports its own pass/fail as well as its
          // children's. It is emitted so the scorer can see it, and marked so
          // the scorer does not count it as a second test.
          entity: details.type === "suite" ? "suite" : "test",
          // `skip` and `todo` arrive either as `true` or as the reason string.
          // A skipped test is reported by node as a PASS; it is not evidence,
          // and the scorer refuses to let it satisfy a criterion.
          skip: data.skip === true || typeof data.skip === "string",
          todo: data.todo === true || typeof data.todo === "string",
          // ONLY ON A FAILURE. A passing test's `details` carries no error, and
          // emitting `failure: undefined` on every pass would put the key in the
          // line for 2,000 passes to say nothing 2,000 times.
          ...(type === "test:fail" ? { failure: describeFailure(details) } : {}),
        })}\n`;
        continue;
      }

      if (type === "test:summary") {
        const counts = data.counts ?? null;
        yield `${JSON.stringify({
          kind: "summary",
          // Present on a per-FILE summary, absent on the final global one. The
          // scorer uses the per-file summaries as the authoritative proof that a
          // file was collected at all, and as the authoritative counts: the
          // global summary additionally counts the synthetic file-level wrapper
          // node reports for a file that collected nothing.
          file,
          counts:
            counts === null || typeof counts !== "object"
              ? null
              : {
                  tests: Number(counts.tests ?? 0),
                  passed: Number(counts.passed ?? 0),
                  failed: Number(counts.failed ?? 0),
                  skipped: Number(counts.skipped ?? 0),
                  todo: Number(counts.todo ?? 0),
                  cancelled: Number(counts.cancelled ?? 0),
                  suites: Number(counts.suites ?? 0),
                },
          success: data.success === true,
        })}\n`;
      }
    } catch (error) {
      // NEVER let a reporter defect look like a silent, well-behaved run. A
      // thrown reporter would abort the stream and leave a truncated file that
      // parses as "fewer tests than expected", which is precisely the silent
      // failure class this whole pass exists to remove.
      yield `${JSON.stringify({
        kind: "parse-error",
        detail: `the node:test reporter could not render an event: ${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }`,
      })}\n`;
    }
  }
}
