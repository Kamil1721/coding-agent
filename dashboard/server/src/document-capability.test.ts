/**
 * document-capability.test.ts — the probe's failure arms, and the one predicate
 * that decides whether a document may be handed to a host binary.
 *
 * THE TEST THAT MATTERS MOST HERE IS THE NEGATIVE ONE: "not probed" must not
 * read as available. A capability check that can only observe success is the
 * defect this repository keeps finding, so every state below is asserted through
 * `extractorIsUsable` as well as by name.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DOCUMENTS_NOT_PROBED,
  extractorIsUsable,
  probeDocumentCapability,
  spawnCapture,
} from "./document-capability.js";
import type { CaptureResult, CaptureRunner } from "./document-capability.js";

const NOW = "2026-07-30T00:00:00.000Z";

function result(patch: Partial<CaptureResult> = {}): CaptureResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    capped: false,
    spawnError: null,
    ...patch,
  };
}

/** Records what was spawned, so "it did not spawn at all" is assertable. */
function recordingRunner(answer: (command: string) => CaptureResult): {
  run: CaptureRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: CaptureRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return answer(command);
  };
  return { run, calls };
}

test("NOT PROBED IS NOT AVAILABLE — the whole reason the third state exists", () => {
  for (const health of [DOCUMENTS_NOT_PROBED.pdftotext, DOCUMENTS_NOT_PROBED.textutil]) {
    assert.equal(health.state, "not-probed");
    assert.equal(health.checkedAt, null, "an unprobed extractor has no timestamp to show");
    assert.notEqual(health.detail, "", "every state carries a sentence a human can act on");
    assert.equal(
      extractorIsUsable(health),
      false,
      "a probe that never ran must never read as a working extractor",
    );
  }
});

test("a working extractor is ok, and its banner is quoted from STDERR for pdftotext", async () => {
  // MEASURED: `pdftotext -v` exits 0 and writes "pdftotext version 26.04.0" to
  // STDERR, not stdout. A probe that captured stdout alone would report an empty
  // detail for a perfectly working tool — this asserts it does not.
  const { run, calls } = recordingRunner((command) =>
    command === "pdftotext"
      ? result({ stderr: "pdftotext version 26.04.0\nCopyright 2005-2026" })
      : result({ stdout: "textutil: [command_option] [other_options] file..." }),
  );
  const capability = await probeDocumentCapability({ run, platform: "darwin", nowIso: () => NOW });

  assert.equal(capability.pdftotext.state, "ok");
  assert.equal(extractorIsUsable(capability.pdftotext), true);
  assert.match(capability.pdftotext.detail, /pdftotext version 26\.04\.0/);
  assert.equal(capability.pdftotext.checkedAt, NOW);

  assert.equal(capability.textutil.state, "ok");
  assert.match(capability.textutil.detail, /command_option/);

  assert.deepEqual(calls, ["pdftotext -v", "textutil -help"], "the measured probe invocations");
});

test("a missing binary is unavailable WITH a reason, and the reason names the fix", async () => {
  const { run } = recordingRunner(() =>
    result({ code: 127, spawnError: "pdftotext could not be spawned: spawn pdftotext ENOENT" }),
  );
  const capability = await probeDocumentCapability({ run, platform: "darwin", nowIso: () => NOW });

  assert.equal(capability.pdftotext.state, "unavailable");
  assert.equal(extractorIsUsable(capability.pdftotext), false);
  assert.match(capability.pdftotext.detail, /ENOENT/);
  assert.match(capability.pdftotext.detail, /brew install poppler/);
  assert.equal(capability.pdftotext.checkedAt, NOW, "an answer, unlike not-probed, is stamped");
});

test("a wedged binary is unavailable, not ok — the timeout is an answer", async () => {
  const { run } = recordingRunner(() => result({ timedOut: true, code: 137 }));
  const capability = await probeDocumentCapability({
    run,
    platform: "darwin",
    nowIso: () => NOW,
    timeoutMs: 250,
  });
  assert.equal(capability.pdftotext.state, "unavailable");
  assert.match(capability.pdftotext.detail, /did not answer within 250 ms/);
});

test("a non-zero exit is unavailable and quotes what the tool said", async () => {
  const { run } = recordingRunner(() => result({ code: 3, stderr: "dyld: library not loaded" }));
  const capability = await probeDocumentCapability({ run, platform: "darwin", nowIso: () => NOW });
  assert.equal(capability.pdftotext.state, "unavailable");
  assert.match(capability.pdftotext.detail, /exited 3/);
  assert.match(capability.pdftotext.detail, /dyld: library not loaded/);
});

test("off macOS, textutil is unavailable WITHOUT being spawned", async () => {
  // Reporting an ENOENT here would be true and misleading: it reads as "install
  // it", and no install puts a macOS built-in on Linux. The assertion that no
  // spawn happened is the part that would fail if someone "simplified" the
  // platform branch away.
  const { run, calls } = recordingRunner(() => result());
  const capability = await probeDocumentCapability({ run, platform: "linux", nowIso: () => NOW });

  assert.equal(capability.textutil.state, "unavailable");
  assert.match(capability.textutil.detail, /macOS built-in/);
  assert.match(capability.textutil.detail, /"linux"/);
  assert.deepEqual(calls, ["pdftotext -v"], "textutil must not be spawned on a platform that has none");
});

test("a probe that throws answers unavailable rather than taking the caller down", async () => {
  const exploding: CaptureRunner = () => Promise.reject(new Error("runner exploded"));
  const capability = await probeDocumentCapability({
    run: exploding,
    platform: "darwin",
    nowIso: () => NOW,
  });
  assert.equal(capability.pdftotext.state, "unavailable");
  assert.match(capability.pdftotext.detail, /probe itself failed: runner exploded/);
  assert.equal(extractorIsUsable(capability.pdftotext), false);
});

/* -------------------------------------------------------------------------
 * The real runner. These spawn actual processes: the branches below are the
 * ones a fake runner can never prove.
 * ---------------------------------------------------------------------- */

test("EXECUTED: spawning a binary that does not exist reports 127, it does not hang", async () => {
  // `spawn` emits `error` and NEVER `close` for ENOENT. Without the error
  // handler this would sit until the kill timer — the failure mode
  // design-capability.ts records for the same class of runner.
  const capture = await spawnCapture("definitely-not-a-real-binary-doc", ["-v"], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
  });
  assert.equal(capture.code, 127);
  assert.notEqual(capture.spawnError, null);
  assert.match(String(capture.spawnError), /could not be spawned/);
});

test("EXECUTED: the real runner captures stdout on success", async () => {
  // The negative control's control: a runner that returned 127 for everything
  // would satisfy the test above on its own.
  const capture = await spawnCapture("node", ["-e", "process.stdout.write('hello')"], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
  });
  assert.equal(capture.code, 0);
  assert.equal(capture.stdout, "hello");
  assert.equal(capture.capped, false);
  assert.equal(capture.timedOut, false);
});

test("EXECUTED: stdout past the byte bound is cut and the child is killed", async () => {
  // The bound that stops a 400-page PDF buffering its way through a request.
  const capture = await spawnCapture(
    "node",
    ["-e", "process.stdout.write('x'.repeat(500000))"],
    { timeoutMs: 10_000, maxStdoutBytes: 1000 },
  );
  assert.equal(capture.capped, true, "the cut must be reported, not silent");
  assert.equal(capture.stdout.length, 1000, "and it must actually bound the buffer");

  // THE MEASURED CONSEQUENCE, PINNED HERE BECAUSE A CONSUMER DEPENDS ON IT: the
  // SIGKILL makes `close` fire with a null code, which surfaces as 1 — the same
  // thing pdftotext reports for a file it cannot parse. `document-intake.ts`
  // must therefore check `capped` BEFORE `code`, and does. If a future Node
  // reports 0 here, that ordering stops being load-bearing and this assertion
  // is where the change is noticed rather than in a silently different verdict.
  assert.notEqual(capture.code, 0, "a killed child does not report success");
});

test("EXECUTED: a child that will not finish is killed at the timeout", async () => {
  const started = Date.now();
  const capture = await spawnCapture("node", ["-e", "setTimeout(() => {}, 30000)"], {
    timeoutMs: 300,
    maxStdoutBytes: 1024,
  });
  assert.equal(capture.timedOut, true);
  assert.ok(Date.now() - started < 10_000, "it must not wait for the child's own lifetime");
});

test("no probe invocation carries a path operand", () => {
  // `pdftotext <file>` with no OUTPUT operand writes `<file>.txt` next to the
  // input (measured — it overwrote a file during this session's investigation),
  // so a probe that took a path could write into a run's directory. The
  // recorded argv above is the evidence; this restates it as the property.
  const seen: string[] = [];
  const run: CaptureRunner = async (command, args) => {
    seen.push([command, ...args].join(" "));
    return result();
  };
  return probeDocumentCapability({ run, platform: "darwin", nowIso: () => NOW }).then(() => {
    for (const invocation of seen) {
      assert.doesNotMatch(invocation, /[/\\]/u, `${invocation} must not name a path`);
    }
    assert.equal(seen.length, 2, "both extractors are probed");
  });
});
