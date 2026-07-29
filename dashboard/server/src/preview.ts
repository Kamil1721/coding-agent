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
  #server: StaticServer | null = null;
  #active: ActivePreview | null = null;

  get active(): ActivePreview | null {
    return this.#active;
  }

  /** Serve `rootDir`, replacing any previous preview. Returns the URL. */
  async serve(runId: string, rootDir: string): Promise<string> {
    await this.stop();
    let lastError: unknown = null;
    for (let offset = 0; offset < PREVIEW_PORT_ATTEMPTS; offset += 1) {
      const port = PREVIEW_PORT_BASE + offset;
      try {
        const server = await startStaticServer(rootDir, port);
        this.#server = server;
        this.#active = { runId, url: server.origin, rootDir };
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

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#active = null;
    if (server !== null) await server.close();
  }
}
