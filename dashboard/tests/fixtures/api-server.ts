/**
 * The dashboard API, faked exactly as far as the browser specs need and no
 * further.
 *
 * WHY A REAL SERVER AND NOT `page.route(...)`. The one endpoint that matters
 * here is `/api/runs/:id/events`: `useLiveRun` opens an `EventSource` against it
 * and `route.fulfill` cannot hold a response open, so an intercepted stream ends
 * the moment it is fulfilled and the browser reconnects every three seconds for
 * the length of the run. This server accepts the socket, writes the headers, and
 * then says NOTHING — the run stays live, the flowing edge stays flowing, and no
 * event ever arrives to move the canvas under a measurement.
 *
 * IT SERVES ONE RUN. Anything else is a 404, which is the honest answer and also
 * keeps a spec that fetches the wrong id from silently getting plausible data.
 *
 * Every response carries `Access-Control-Allow-Origin: *` because the app runs
 * on a different loopback port than this does — the harness sets
 * `NEXT_PUBLIC_API_BASE_URL`, the documented escape hatch in `src/lib/api.ts`,
 * so that `fetch` AND `EventSource` both come straight here instead of through
 * `next.config.ts`'s rewrite. Testing through the rewrite would mean testing
 * Next's proxy buffering as well, which is not what any of these specs are for.
 */

import { createServer, type Server, type ServerResponse } from "node:http";

import type { RunEvent } from "../../src/lib/api-types";
import { REPLAY_RUN_ID, RUN_ID } from "./config";
import {
  CODE_FILES,
  CODE_TREE,
  GRAPH_EVENTS,
  GRAPH_SNAPSHOT,
  MODELS,
  REPLAY_DETAIL,
  RUN_DETAIL,
  RUN_LIST,
  TAIL_MARKER,
  TAIL_SEQ,
} from "./run-fixture";

export interface FixtureApi {
  readonly close: () => Promise<void>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
} as const;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

/**
 * One SSE frame, written exactly the way `bus.ts` writes it: `id:` FIRST, then
 * the named event, then the JSON body. The id line is the entire mechanism the
 * client dedupes on — the browser hands it back as `MessageEvent.lastEventId` —
 * so a fixture that omitted it would quietly test a different program.
 */
function writeFrame(response: ServerResponse, seq: number, event: RunEvent): void {
  response.write(`id: ${String(seq)}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function startFixtureApi(port: number): Promise<FixtureApi> {
  const streams = new Set<ServerResponse>();

  const openStream = (response: ServerResponse): void => {
    response.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    streams.add(response);
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    const run = `/api/runs/${encodeURIComponent(RUN_ID)}`;

    if (path === "/api/health") {
      sendJson(response, 200, { ok: true, claudeAuth: "ok", codexAuth: "ok" });
      return;
    }
    if (path === "/api/models") {
      sendJson(response, 200, MODELS);
      return;
    }
    if (path === "/api/runs") {
      sendJson(response, 200, RUN_LIST);
      return;
    }
    if (path === run) {
      sendJson(response, 200, RUN_DETAIL);
      return;
    }
    if (path === `${run}/graph`) {
      sendJson(response, 200, GRAPH_SNAPSHOT);
      return;
    }
    /*
     * The code sidebar. `?path` absent is the tree, present is one file — the
     * same discrimination the real route makes.
     *
     * A PATH THIS FIXTURE DOES NOT HOLD ANSWERS 404 WITH THE REAL ERROR SHAPE,
     * not with an empty file. The refusals themselves are facts about a
     * filesystem and are proved in `server/src/code-files.test.ts`; what a
     * browser spec can observe is that the viewer renders the server's sentence
     * instead of inventing one, which needs the error body to be shaped right.
     */
    if (path === `${run}/files`) {
      const wanted = url.searchParams.get("path");
      if (wanted === null) {
        sendJson(response, 200, CODE_TREE);
        return;
      }
      const file = Object.hasOwn(CODE_FILES, wanted) ? CODE_FILES[wanted] : undefined;
      if (file === undefined) {
        sendJson(response, 404, {
          error: "not_found",
          message: `no such file in this run's workspace: ${wanted}`,
          remediation: "Re-read the tree.",
        });
        return;
      }
      sendJson(response, 200, file);
      return;
    }
    if (path === `${run}/events`) {
      openStream(response);
      // A comment frame, so the browser fires `open` and the app stops reading
      // as "connecting". Nothing after it: see the header.
      response.write(": open\n\n");
      request.on("close", () => streams.delete(response));
      return;
    }

    const replay = `/api/runs/${encodeURIComponent(REPLAY_RUN_ID)}`;

    if (path === replay) {
      sendJson(response, 200, REPLAY_DETAIL);
      return;
    }
    if (path === `${replay}/graph`) {
      sendJson(response, 200, GRAPH_SNAPSHOT);
      return;
    }
    if (path === `${replay}/events`) {
      // THE REAL ENDPOINT'S BEHAVIOUR: every durable row from seq 1, regardless
      // of what the snapshot already covered, because the trace pane needs the
      // whole history. Then one genuinely new row, and then silence.
      openStream(response);
      GRAPH_EVENTS.forEach((event, index) => {
        writeFrame(response, index + 1, event);
      });
      writeFrame(response, TAIL_SEQ, TAIL_MARKER);
      request.on("close", () => streams.delete(response));
      return;
    }

    sendJson(response, 404, { error: `No fixture for ${path}` });
  });

  return new Promise<FixtureApi>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      // The suite's exit must never wait on a socket this server is holding
      // open on purpose.
      server.unref();
      resolve({
        close: async (): Promise<void> => {
          for (const stream of streams) stream.end();
          streams.clear();
          await new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}
