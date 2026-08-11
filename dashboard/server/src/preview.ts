/**
 * preview.ts — what `deploy: true` actually does.
 *
 * IT SERVES THE ARTEFACT ON LOOPBACK. IT DOES NOT PUBLISH ANYTHING.
 *
 * The dashboard has no deploy target: no host, no domain, no credentials for
 * one, and no way to acquire any without the owner making a decision this
 * program is not entitled to make on their behalf. So `deploy` means "serve the
 * finished workspace at a `http://127.0.0.1:<port>` URL I can open", and
 * `previewUrl` is that URL. Calling it a deployment in the UI would be the
 * fabrication; serving it locally is a thing that actually happens.
 *
 * The server is `startStaticServer` from bakeoff/src/tier0.ts — the same
 * dependency-free static server the sealed scorer uses in static mode, with the
 * same traversal defences (percent-decoded before the check, containment
 * re-checked on realpath) and the same 127.0.0.1-only bind. Reusing it means
 * the preview cannot serve a file the scorer would have refused to serve.
 *
 * ONE PREVIEW AT A TIME. A per-run server would leak listeners for every run
 * ever deployed; the current one is stopped before the next starts.
 */

import { startStaticServer } from "bakeoff/dist/tier0.js";
import type { StaticServer } from "bakeoff/dist/tier0.js";

/** First port tried. Each attempt increments until one binds. */
export const PREVIEW_PORT_BASE = 4321;
export const PREVIEW_PORT_ATTEMPTS = 20;

export interface ActivePreview {
  readonly runId: string;
  readonly url: string;
  readonly rootDir: string;
}

export class PreviewHost {
  /**
   * One server per run, keyed by run id.
   *
   * THIS WAS A SINGLETON, AND THE DOCBLOCK ABOVE STILL EXPLAINS WHY: "ONE
   * PREVIEW AT A TIME. A per-run server would leak listeners for every run ever
   * deployed; the current one is stopped before the next starts." The leak
   * argument is real and is answered here by tying a server's lifetime to its
   * RUN — `stop(runId)` when the run finishes — rather than to whoever deploys
   * next.
   *
   * WHAT THE SINGLETON DID UNDER CONCURRENCY, AND IT IS WORSE THAN A STALE LINK.
   * `serve()` opened with `await this.stop()`, freeing 4321, then rebound the
   * same 4321 to the new run's workspace. Run A's `runs.previewUrl` column still
   * said 4321. So A's link silently served B's artefact — and `#adversaryPhase`
   * (orchestrator.ts:6050) reads that column and hands it to a live agent whose
   * prompt is "Attack the running web app at ${previewUrl}" (adversary.ts:215).
   * Run A's adversary would spend the owner's subscription attacking run B's
   * site and file the findings under A. Not verdict-corrupting — nothing in
   * verdict.ts reads adversary output — but durable evidence about the wrong
   * ticket, which is precisely what comparing two tickets depends on.
   */
  readonly #servers = new Map<string, { readonly server: StaticServer; readonly active: ActivePreview }>();

  /**
   * The most recently started preview, or null.
   *
   * KEPT ONLY FOR THE SINGLE-RUN CALLERS THAT PREDATE THE MAP. It is a lie the
   * moment two runs are live, so anything that knows its run id should use
   * `activeFor(runId)` instead.
   */
  get active(): ActivePreview | null {
    let last: ActivePreview | null = null;
    for (const entry of this.#servers.values()) last = entry.active;
    return last;
  }

  /** This run's preview, or null. The question every run-scoped caller means. */
  activeFor(runId: string): ActivePreview | null {
    return this.#servers.get(runId)?.active ?? null;
  }

  /** Serve `rootDir` for `runId`, replacing only THIS run's previous preview. */
  async serve(runId: string, rootDir: string): Promise<string> {
    await this.stop(runId);
    // Ports already held by another run's preview are skipped by the bind
    // failure below, so two runs land on 4321 and 4322 rather than fighting.
    let lastError: unknown = null;
    for (let offset = 0; offset < PREVIEW_PORT_ATTEMPTS; offset += 1) {
      const port = PREVIEW_PORT_BASE + offset;
      try {
        const server = await startStaticServer(rootDir, port);
        this.#servers.set(runId, { server, active: { runId, url: server.origin, rootDir } });
        return server.origin;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `no free preview port in ${String(PREVIEW_PORT_BASE)}-${String(
        PREVIEW_PORT_BASE + PREVIEW_PORT_ATTEMPTS - 1,
      )}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /**
   * Stop one run's preview, or every preview when called with no argument.
   *
   * The no-argument form is shutdown's, and it is why this stayed one method:
   * `orchestrator.shutdown()` must close all of them, and a second method that
   * only some callers knew about is how one gets left listening.
   */
  async stop(runId?: string): Promise<void> {
    const ids = runId === undefined ? [...this.#servers.keys()] : [runId];
    for (const id of ids) {
      const entry = this.#servers.get(id);
      this.#servers.delete(id);
      if (entry !== undefined) await entry.server.close();
    }
  }
}
