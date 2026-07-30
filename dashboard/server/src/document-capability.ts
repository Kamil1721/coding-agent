/**
 * document-capability.ts — can this machine turn a PDF or a .docx into text
 * right now, and if not, WHICH tool is missing and why.
 *
 * WHY A PROBE AT ALL. The two extractors this dashboard can reach are HOST
 * BINARIES, not libraries: `pdftotext` arrives with poppler (homebrew on this
 * machine, `/opt/homebrew/bin/pdftotext`, version 26.04.0 as measured this
 * session) and `textutil` is a macOS built-in at `/usr/bin/textutil` that DOES
 * NOT EXIST on Linux. Neither is a dependency anything installs. So "the owner
 * attached a scope and the run never mentioned it" has at least three causes —
 * poppler not installed, the run on a non-macOS host, the file unreadable — and
 * without a probe they are one observable: an attachment that silently
 * contributed nothing. That is the failure `design-capability.ts` was written to
 * stop for the image chain, and this is the same shape for documents.
 *
 * THREE STATES, AND `not-probed` IS NOT A DEGRADED `ok`. Copied deliberately
 * from `health-gate.ts` and `GateHealth` (api-types.ts): the probe either has an answer
 * ("ok" / "unavailable") or has not produced one yet ("not-probed"). A caller
 * that treats "not-probed" as usable will spawn a binary that may not exist and
 * report its ENOENT as a fact about the DOCUMENT. {@link extractorIsUsable} is
 * the one predicate that decides, and it is `state === "ok"` and nothing else;
 * `document-capability.test.ts` asserts it is false for the not-probed constant,
 * which is the negative control this repository keeps finding missing.
 *
 * WHAT AN `ok` HERE DOES AND DOES NOT PROVE. It means the binary was spawned
 * with its own version/usage flag and exited 0 within the probe timeout. It does
 * NOT prove any particular file can be read: a password-protected PDF, a
 * corrupt .docx and a PDF with no text layer all fail (or return nothing)
 * against a perfectly `ok` extractor. Those are per-file outcomes and
 * `document-intake.ts` names them separately.
 *
 * NO TTL CACHE, DELIBERATELY, UNLIKE `GateProbe`. That cache exists because
 * `/api/health` polls every 30 s and each poll would otherwise spawn docker.
 * Nothing polls document capability — it is answered once per intake — so a
 * stateful class here would be wiring handed to callers for no measured gain.
 * If a caller ever does poll this, it caches the returned value itself.
 */

import { spawn } from "node:child_process";

/** The two extractors this module knows how to ask about. */
export type DocumentExtractorId = "pdftotext" | "textutil";

/**
 * `ok` / `unavailable` / `not-probed` — see the header. Named differently from
 * `GateHealth`'s `unknown` on purpose: "not probed" says WHY there is no answer
 * (nobody asked yet), which for a probe that is never run in the background is
 * the honest word.
 */
export type ExtractorState = "ok" | "unavailable" | "not-probed";

export interface ExtractorHealth {
  readonly id: DocumentExtractorId;
  readonly state: ExtractorState;
  /** Always a sentence a human can act on. Never empty, on any path. */
  readonly detail: string;
  /** ISO stamp of the probe, or null when `state` is `not-probed`. */
  readonly checkedAt: string | null;
}

/** Both extractors, as far as this process knows. */
export interface DocumentCapability {
  readonly pdftotext: ExtractorHealth;
  readonly textutil: ExtractorHealth;
}

/**
 * The literal a caller uses before it has probed anything.
 *
 * EXPORTED BECAUSE THE ALTERNATIVE IS WORSE: without it a caller that has not
 * probed yet either passes `undefined` (and the extractor path invents a
 * default) or fabricates an `ok`. Handing it a value that says "no answer" makes
 * the degraded branch the DEFAULT rather than an afterthought.
 */
export const DOCUMENTS_NOT_PROBED: DocumentCapability = {
  pdftotext: {
    id: "pdftotext",
    state: "not-probed",
    detail:
      "pdftotext has not been probed. Nothing has asked this machine whether poppler is installed, " +
      "so no PDF may be sent down the text-extraction path yet.",
    checkedAt: null,
  },
  textutil: {
    id: "textutil",
    state: "not-probed",
    detail:
      "textutil has not been probed. Nothing has asked this machine whether the macOS converter is " +
      "present, so no .docx/.doc/.rtf may be sent down the text-extraction path yet.",
    checkedAt: null,
  },
};

/**
 * THE ONLY WAY TO ASK "may I run this extractor".
 *
 * `state === "ok"` and nothing else — a probe that has not run is not a weak
 * yes. Written as a function rather than left to `=== "ok"` at call sites so
 * there is exactly one place a future third state could be mis-classified, and
 * one place a test can pin.
 */
export function extractorIsUsable(health: ExtractorHealth): boolean {
  return health.state === "ok";
}

/* -------------------------------------------------------------------------
 * The one subprocess runner, shared with the extraction path
 * ---------------------------------------------------------------------- */

export interface CaptureLimits {
  /** Wall-clock budget. The child is SIGKILLed at this point. */
  readonly timeoutMs: number;
  /**
   * Hard bound on captured stdout. Past it the child is killed and `capped` is
   * set — a 400-page PDF must not be able to buffer its way through a request.
   */
  readonly maxStdoutBytes: number;
}

export interface CaptureResult {
  /**
   * The child's exit code, or 127 when the binary could not be spawned at all —
   * the same convention `design-capability.ts`'s `execCommandRunner` uses, so a
   * reader comparing the two files is not comparing two dialects.
   */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /**
   * stdout hit {@link CaptureLimits.maxStdoutBytes} and the child was killed.
   *
   * A CAPPED RESULT'S `code` IS OUR DOING, NOT THE TOOL'S, and a consumer that
   * reads it as a tool failure throws away text it already has. MEASURED: the
   * SIGKILL makes `close` fire with a null code, which surfaces here as 1, three
   * times out of three — indistinguishable from `pdftotext` rejecting the file.
   * So `capped` must be consulted BEFORE `code`; `document-intake.ts` does, and
   * a test pins both halves.
   */
  readonly capped: boolean;
  /** The spawn failure's message, or null. Non-null implies `code === 127`. */
  readonly spawnError: string | null;
}

export type CaptureRunner = (
  command: string,
  args: readonly string[],
  limits: CaptureLimits,
) => Promise<CaptureResult>;

/**
 * Spawn, capture BOTH streams under a byte bound and a wall clock, never reject.
 *
 * WHY NOT REUSE `execCommandRunner` FROM design-capability.ts: that runner is
 * `stdio: ["ignore", "ignore", "pipe"]` — stdout is discarded by construction,
 * because its only job is an exit code. Extraction is entirely about stdout.
 *
 * THE `error` HANDLER IS LOAD-BEARING, not defensive padding, and the reasoning
 * is `execCommandRunner`'s verbatim: `spawn` of a binary that is not on PATH
 * emits `error` (ENOENT) and NEVER emits `close`, so without it a machine with
 * no poppler would hang until the kill timer instead of reporting 127
 * immediately. A test drives that path with a name that cannot exist.
 *
 * THE BYTE BOUND CUTS UTF-8 BY BYTES, NOT BY CHARACTERS. A multi-byte character
 * straddling the bound decodes to U+FFFD. That is one replacement character at
 * the very end of an already-truncated document and it is visible; re-framing
 * the buffer to a character boundary would cost a decoder for no reader-visible
 * gain.
 *
 * `stdin` IS `ignore`. Both extractors take a path operand; leaving stdin open
 * on a tool that decided to prompt would hang the request until the kill timer.
 */
export const spawnCapture: CaptureRunner = (command, args, limits) =>
  new Promise<CaptureResult>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let capped = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: CaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limits.timeoutMs);
    // A dangling handle would hold `server.close()` open; the same reason
    // health-gate.ts unrefs its deadline timer.
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (capped) return;
      const room = limits.maxStdoutBytes - stdoutBytes;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, Math.max(0, room)));
        stdoutBytes = limits.maxStdoutBytes;
        capped = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    // stderr is bounded separately and much harder: it exists to be quoted into
    // a `detail` line, and a tool that writes a megabyte of warnings must not
    // put a megabyte into an error message.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096);
    });

    child.on("error", (error: Error) => {
      finish({
        code: 127,
        stdout: "",
        stderr: "",
        timedOut: false,
        capped: false,
        spawnError: `${command} could not be spawned: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr,
        timedOut,
        capped,
        spawnError: null,
      });
    });
  });

/* -------------------------------------------------------------------------
 * The probe
 * ---------------------------------------------------------------------- */

/**
 * How long a probe may take. Generous for two binaries that answer a version
 * flag in milliseconds, and short enough that a wedged one does not hold a
 * ticket submission.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** A version banner is a few hundred bytes; nothing legitimate approaches this. */
const PROBE_STDOUT_BYTES = 64 * 1024;

/**
 * The probe invocations, MEASURED on this machine rather than assumed:
 *
 *   pdftotext -v     → exit 0, and the banner goes to STDERR, not stdout
 *                      ("pdftotext version 26.04.0"). A probe that only captured
 *                      stdout would report an empty detail for a working tool.
 *   textutil -help   → exit 0, usage on stdout. `-help` is used rather than
 *                      `-info <file>` because it needs no file and writes
 *                      nothing anywhere.
 *
 * NEITHER TOUCHES THE FILESYSTEM. That matters for `pdftotext` in particular:
 * see `document-intake.ts` on what the tool does when it is not given an output
 * operand.
 */
const PROBE_ARGS: Readonly<Record<DocumentExtractorId, readonly string[]>> = {
  pdftotext: ["-v"],
  textutil: ["-help"],
};

export interface DocumentProbeOptions {
  /** Injected so the unavailable and timeout branches are reachable in a test. */
  readonly run?: CaptureRunner;
  /**
   * `process.platform` by default. `textutil` is macOS-only, so on any other
   * platform this module answers WITHOUT SPAWNING — reporting "not installed"
   * from an ENOENT would be true but would hide that no install can fix it.
   */
  readonly platform?: NodeJS.Platform;
  readonly nowIso?: () => string;
  readonly timeoutMs?: number;
}

/**
 * Ask both extractors whether they are there.
 *
 * BOTH ARE PROBED EVEN WHEN ONLY ONE IS NEEDED. The caller does not know which
 * types the owner is about to attach, the cost is two spawns of a version flag,
 * and a capability record with one half missing invites exactly the "unknown
 * reads as available" mistake the three states exist to prevent.
 *
 * NEVER THROWS. Every branch of {@link spawnCapture} resolves, an injected
 * runner that rejects is caught in `probeOne`, and a refusal is this function's
 * MEASUREMENT rather than its error.
 */
export async function probeDocumentCapability(
  options: DocumentProbeOptions = {},
): Promise<DocumentCapability> {
  const run = options.run ?? spawnCapture;
  const platform = options.platform ?? process.platform;
  const nowIso = options.nowIso ?? ((): string => new Date().toISOString());
  const limits: CaptureLimits = {
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_STDOUT_BYTES,
  };

  const pdftotext = await probeOne("pdftotext", run, limits, nowIso);

  if (platform !== "darwin") {
    return {
      pdftotext,
      textutil: {
        id: "textutil",
        state: "unavailable",
        detail:
          `textutil is a macOS built-in and this host reports platform "${platform}". ` +
          "No install makes it available here; .docx/.doc/.rtf attachments cannot be converted to " +
          "text on this machine.",
        checkedAt: nowIso(),
      },
    };
  }

  return { pdftotext, textutil: await probeOne("textutil", run, limits, nowIso) };
}

async function probeOne(
  id: DocumentExtractorId,
  run: CaptureRunner,
  limits: CaptureLimits,
  nowIso: () => string,
): Promise<ExtractorHealth> {
  const args = PROBE_ARGS[id];
  let result;
  try {
    result = await run(id, args, limits);
  } catch (error) {
    // {@link spawnCapture} resolves on every path, so this can only be an
    // INJECTED runner throwing — and the same reasoning `health-gate.ts` gives
    // applies: a probe that cannot answer must not take the caller down with it,
    // and the answer it leaves behind must not read as available. The detail
    // says the probe failed rather than blaming the machine, because those are
    // different bugs with different fixes.
    return {
      id,
      state: "unavailable",
      detail:
        `the ${id} probe itself failed: ${error instanceof Error ? error.message : String(error)}. ` +
        "Nothing was learned about the extractor; it is reported unavailable so no document is sent " +
        "at a tool whose presence is unknown.",
      checkedAt: nowIso(),
    };
  }
  const checkedAt = nowIso();

  if (result.spawnError !== null) {
    return {
      id,
      state: "unavailable",
      detail: `${result.spawnError}. ${installHint(id)}`,
      checkedAt,
    };
  }
  if (result.timedOut) {
    return {
      id,
      state: "unavailable",
      detail:
        `${id} ${args.join(" ")} did not answer within ${String(limits.timeoutMs)} ms and was killed. ` +
        "Treating it as unavailable: a tool that cannot answer a version flag will not finish a document.",
      checkedAt,
    };
  }
  if (result.code !== 0) {
    return {
      id,
      state: "unavailable",
      detail:
        `${id} ${args.join(" ")} exited ${String(result.code)}. ${installHint(id)}` +
        (firstLine(result.stderr) === "" ? "" : ` It said: ${firstLine(result.stderr)}`),
      checkedAt,
    };
  }

  // The banner is quoted because it is the ONLY thing distinguishing two
  // machines whose answers are otherwise identical, and because poppler's
  // output layout has changed between major versions before.
  const banner = firstLine(result.stderr) === "" ? firstLine(result.stdout) : firstLine(result.stderr);
  return {
    id,
    state: "ok",
    detail: banner === "" ? `${id} answered ${args.join(" ")} with exit 0` : `${id}: ${banner}`,
    checkedAt,
  };
}

function installHint(id: DocumentExtractorId): string {
  return id === "pdftotext"
    ? "pdftotext ships with poppler (`brew install poppler`). Without it, PDFs can only be sent to a " +
        "model that accepts a document block natively; there is no text fallback."
    : "textutil is a macOS built-in at /usr/bin/textutil; a non-zero exit from it means the host is not " +
        "the machine this path was measured on.";
}

/** First non-empty line, trimmed and bounded. Detail lines are read by humans. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 200);
  }
  return "";
}
