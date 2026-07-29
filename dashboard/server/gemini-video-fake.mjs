// dashboard/server/gemini-video-fake.mjs
//
// A loopback fake Veo endpoint with a REQUEST LOG. The log is the observation
// behind every negative control in the image->video harness: "the script
// refused before spending" is an assertion about an EMPTY log, not about an
// exit code, and "it polled to its deadline" is an assertion about a COUNT.
//
// Its POST returns an operation name Google cannot return. If
// GEMINI_VIDEO_API_BASE were silently ignored, the script would hit Google with
// a fake key, take a 401, and every negative control below it would pass while
// emulating nothing. Seeing FAKE-SENTINEL-7 come back out of the script is the
// only thing that rules that out.
import { createServer } from "node:http";

export const SENTINEL_OPERATION = "models/veo-3.1-generate-preview/operations/FAKE-SENTINEL-7";

/**
 * A minimal mp4: an `ftyp` box at offset 4, then filler. Enough to be real to
 * `head -c 12`. 8 KB so a complete download clears the script's 4096-byte floor
 * while the truncation fixture's 1,000 bytes does not.
 */
export function fakeMp4(bytes = 8192) {
  const buf = Buffer.alloc(bytes, 0x21);
  buf.writeUInt32BE(bytes, 0);
  buf.write("ftypisom", 4, "ascii");
  return buf;
}

export async function startFakeVeo(options = {}) {
  const {
    pollsBeforeDone = 1,
    neverDone = false,
    postStatus = 200,
    truncateDownloadTo = null,
    declaredLength = null,
    echoKeyInError = false,
  } = options;
  const requests = [];
  let polls = 0;
  let base = "";

  const server = createServer((req, res) => {
    const key = req.headers["x-goog-api-key"] ?? null;
    requests.push({ method: req.method, path: req.url, apiKey: Array.isArray(key) ? key[0] : key });
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST") {
      req.resume();
      if (postStatus !== 200) {
        const message = echoKeyInError ? `invalid key: ${key}` : "bad request";
        return json(postStatus, { error: { code: postStatus, status: "INVALID_ARGUMENT", message } });
      }
      return json(200, { name: SENTINEL_OPERATION });
    }
    if (req.url === `/v1beta/${SENTINEL_OPERATION}`) {
      polls += 1;
      if (neverDone || polls < pollsBeforeDone) return json(200, { name: SENTINEL_OPERATION, done: false });
      return json(200, {
        name: SENTINEL_OPERATION,
        done: true,
        response: {
          generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/download/leg.mp4` } }] },
        },
      });
    }
    if (req.url === "/download/leg.mp4") {
      const full = fakeMp4();
      const declared = declaredLength ?? full.length;
      const body = truncateDownloadTo === null ? full : full.subarray(0, truncateDownloadTo);
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(declared) });
      res.write(body);
      // A COMPLETE body is ended cleanly; a SHORT one has its socket destroyed
      // mid-stream. Both shapes are needed: see the two truncation cases in the
      // harness, one of which must reach the script's own size floor rather
      // than short-circuiting on curl's transport failure.
      if (body.length >= declared) return res.end();
      return res.destroy();
    }
    return json(404, { error: { code: 404, status: "NOT_FOUND", message: "no route" } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/v1beta`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
