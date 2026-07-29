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
 *    "entity":"test"|"suite", "skip":bool, "todo":bool}
 *   {"kind":"summary","file":"/abs"|null, "counts":{...}, "success":bool}
 *   {"kind":"parse-error","detail":"..."}                (never silently dropped)
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
