/** Golden of the actual built private function, before any binding-walk refactor.
 * The public caller cannot reach this legacy arm: its status reader rejects a null
 * critic disposition with critic_unavailable, while admission rejects non-null.
 * A temporary sibling exports the unchanged compiled function and preserves all
 * its original relative imports. No production source or export is modified.
 */
import { createHash, randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const fixture = new URL("../src/fixtures/contract-conformance/study/", import.meta.url);
const contractText = readFileSync(new URL("creative-contract.json", fixture), "utf8");
const contract = JSON.parse(contractText) as Record<string, unknown>;
const files = JSON.parse(gunzipSync(readFileSync(new URL("workspace.json.gz", fixture))).toString("utf8")) as readonly {
  readonly path: string; readonly base64: string; readonly sha256: string;
}[];
const temporaryModule = new URL(`./.recovery-golden-${randomUUID()}.mjs`, import.meta.url);
writeFileSync(temporaryModule, `${readFileSync(new URL("./creative-recovery.js", import.meta.url), "utf8")}\nexport { hasLegacyDeterministicMarkerConflict };\n`);
let checkLegacy: (workspace: string, results: string) => boolean;
try {
  const loaded = await import(temporaryModule.href) as { hasLegacyDeterministicMarkerConflict: typeof checkLegacy };
  checkLegacy = loaded.hasLegacyDeterministicMarkerConflict;
} finally { rmSync(temporaryModule); }

function conflict(mutate: (workspace: string) => void = () => {}): boolean {
  const root = mkdtempSync(join(tmpdir(), "recovery-marker-golden-"));
  try {
    const workspace = join(root, "workspace");
    const results = join(root, "results");
    mkdirSync(results);
    for (const file of files) {
      const bytes = Buffer.from(file.base64, "base64");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `copied study bytes: ${file.path}`);
      mkdirSync(dirname(join(workspace, file.path)), { recursive: true });
      writeFileSync(join(workspace, file.path), bytes);
    }
    assert.equal(readFileSync(join(workspace, "index.html"), "utf8"), readFileSync(new URL("index.html", fixture), "utf8"));
    mutate(workspace);
    writeFileSync(join(results, "creative-contract.json"), contractText);
    return checkLegacy(workspace, results);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("study workspace golden: legacy marker conflict is true before refactor", () => {
  // Mutation control: replace the private final return with false; this must fail.
  assert.equal(conflict(), true, "GOLDEN_STUDY_CONFLICT: unchanged study workspace must report true");
});

test("legacy index existence gate remains false with marker-bearing sidecars", () => {
  assert.equal(conflict((workspace) => { rmSync(join(workspace, "index.html")); }), false,
    "GOLDEN_INDEX_GATE: absent index must report false despite marker-bearing sidecars");
});

test("legacy raw bindings supplied in any sidecar remove the conflict", () => {
  const attributes = { routes: "data-creative-route", sections: "data-creative-section", motion: "data-motion-id" } as const;
  const bindings = Object.entries(attributes).flatMap(([key, attribute]) =>
    (contract[key] as readonly { readonly id: string }[]).map(({ id }) => `${attribute}='${id}'`));
  assert.equal(conflict((workspace) => {
    writeFileSync(join(workspace, "raw-bindings.txt"), bindings.join("\n"));
  }), false, "GOLDEN_SIDECAR_BINDINGS: exact raw sidecar bindings must remove the conflict");
});
