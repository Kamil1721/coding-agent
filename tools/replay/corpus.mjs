/**
 * THE REGRESSION CORPUS — recorded failures + recorded successes.
 *
 * Every case is a manifest plus the outcome the CURRENT validator is expected to
 * produce for it. Running the corpus answers, in milliseconds and for free,
 * the question a prompt or validator change otherwise costs a 90-minute run:
 * *does the checker still say what it said?*
 *
 * BOTH DIRECTIONS, OR THIS IS INSTANCE TWENTY-TWO. Three of the cases are
 * a913c871's real rejected manifests. Two are manifests that MUST BE ACCEPTED.
 * A corpus of rejections alone passes green against a validator that rejects
 * everything — which is precisely the regression a softening/hardening patch
 * would introduce, and precisely this repository's catalogued signature defect.
 *
 * WHERE THE CASES COME FROM
 *   a913c871-attempt{1,2,3}  the seat's own bytes, recovered from the CLI session
 *                            transcripts (see extract-fixtures.mjs) and copied
 *                            into the repo because the harness persisted nothing.
 *   populated-manifest       a hand-built SERVER-shaped manifest carrying the
 *                            `bakeoff/docker/README.md:391` entry verbatim.
 *   shipped-prompt-examples  the two entries the SHIPPED authoring prompt now
 *                            shows the seat, read out of the BUILT module. This
 *                            case is the one that catches "the prompt documents a
 *                            shape the validator does not accept" — the a913c871
 *                            root cause, in its next possible disguise.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { KNOWN_GOOD_MANIFEST, REPO_ROOT } from "./checker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, "fixtures");
export const EXPECTATIONS_FILE = path.join(HERE, "corpus.json");

export const SITE = "spec/suite.manifest.json";

function readFixture(id) {
  const manifestPath = path.join(FIXTURE_DIR, `${id}.manifest.json`);
  const metaPath = path.join(FIXTURE_DIR, `${id}.meta.json`);
  if (!existsSync(manifestPath)) return null;
  const raw = readFileSync(manifestPath, "utf8");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  return { raw, manifest: JSON.parse(raw), meta };
}

/**
 * The two prompt examples, loaded from the BUILT spec-agent rather than the
 * source. The source is edited by other lanes; the built module is what a run
 * would actually ship. Returns null (never throws, never silently passes) when
 * the module is absent or does not export the constant — the runner reports that
 * as UNARMED, not as a pass.
 */
export async function shippedPromptExamples(
  moduleFile = path.join(REPO_ROOT, "bakeoff", "dist", "spec-agent.js"),
) {
  if (!existsSync(moduleFile)) {
    return { ok: false, why: `built module missing: ${path.relative(REPO_ROOT, moduleFile)}` };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(moduleFile).href);
  } catch (err) {
    return { ok: false, why: `built module failed to import: ${err instanceof Error ? err.message : String(err)}` };
  }
  const examples = mod.MANIFEST_DATA_EXPECTATION_EXAMPLES;
  if (examples === undefined || typeof examples !== "object") {
    return { ok: false, why: "built spec-agent does not export MANIFEST_DATA_EXPECTATION_EXAMPLES" };
  }
  const entries = Object.values(examples);
  if (entries.length === 0) {
    return { ok: false, why: "MANIFEST_DATA_EXPECTATION_EXAMPLES is empty" };
  }
  return {
    ok: true,
    manifest: { ...structuredClone(KNOWN_GOOD_MANIFEST), dataExpectations: structuredClone(entries) },
    count: entries.length,
  };
}

export function loadExpectations(file = EXPECTATIONS_FILE) {
  if (!existsSync(file)) throw new Error(`corpus expectations missing: ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.cases)) throw new Error(`${file} has no cases[]`);
  return parsed;
}

/**
 * Materialise every case. A case whose fixture is missing is returned with
 * `manifest: null` and a reason — the runner counts those as UNARMED and exits
 * non-zero, rather than quietly shrinking the corpus.
 */
export async function loadCorpus({ expectationsFile = EXPECTATIONS_FILE, fixtureDir = FIXTURE_DIR } = {}) {
  const spec = loadExpectations(expectationsFile);
  const cases = [];
  for (const c of spec.cases) {
    if (c.from === "fixture") {
      const fixturePath = path.join(fixtureDir, `${c.id}.manifest.json`);
      const got = existsSync(fixturePath)
        ? { raw: readFileSync(fixturePath, "utf8"), manifest: JSON.parse(readFileSync(fixturePath, "utf8")), meta: readFixture(c.id)?.meta ?? null }
        : null;
      cases.push(
        got === null
          ? { ...c, manifest: null, unarmed: `fixture missing: ${path.relative(REPO_ROOT, fixturePath)} — run tools/replay/extract-fixtures.mjs` }
          : { ...c, manifest: got.manifest, raw: got.raw, meta: got.meta },
      );
    } else if (c.from === "literal-known-good") {
      cases.push({ ...c, manifest: structuredClone(KNOWN_GOOD_MANIFEST) });
    } else if (c.from === "shipped-prompt") {
      const got = await shippedPromptExamples();
      cases.push(got.ok ? { ...c, manifest: got.manifest } : { ...c, manifest: null, unarmed: got.why });
    } else {
      cases.push({ ...c, manifest: null, unarmed: `unknown case source "${c.from}"` });
    }
  }
  return { site: spec.site ?? SITE, note: spec.note ?? "", cases };
}
