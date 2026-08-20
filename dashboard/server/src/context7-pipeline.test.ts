import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MAX_CONTEXT7_SOURCE_FILE_BYTES,
  MAX_CONTEXT7_SOURCE_FILES,
  MAX_CONTEXT7_EXTERNAL_CLAIMS,
  captureContext7ReviewSource,
  compileContext7ReviewScope,
} from "./context7-pipeline.js";
import { MAX_TREE_DEPTH } from "./code-files.js";
import { dashboardProjectId } from "./paths.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "context7-pipeline-"));
}

test("actual project identity is independent of the dashboard state directory", () => {
  assert.equal(dashboardProjectId({ DASHBOARD_HOME: "/tmp/unrelated-state" }), "coding-agent");
  assert.equal(dashboardProjectId({ DASHBOARD_HOME: "/tmp/unrelated-state", DASHBOARD_PROJECT_ID: "other" }), "other");
});

test("the finished manifest defines scope and planner-only identities are expectations", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { next: "^16.1.0", react: "19.x" },
        devDependencies: { "@playwright/test": "1.55.0" },
      }),
    );
    const scope = compileContext7ReviewScope({
      projectId: "coding-agent",
      workspace: root,
    });

    assert.deepEqual(
      scope.claims.map((claim) =>
        claim.kind === "external"
          ? { id: claim.id, package: claim.package, version: claim.versionOrRange, query: claim.queryPurpose }
          : claim,
      ),
      [
        {
          id: "EC-1",
          package: "next",
          version: "^16.1.0",
          query:
            "Verify current public usage, configuration, version compatibility, and deprecations for next as used by the supplied source.",
        },
        {
          id: "EC-2",
          package: "react",
          version: "19.x",
          query:
            "Verify current public usage, configuration, version compatibility, and deprecations for react as used by the supplied source.",
        },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the per-file source ceiling is measured in UTF-8 bytes rather than UTF-16 code units", () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "wide.ts"), `export const wide = "${"🧪".repeat(40_000)}";`);
    const snapshot = captureContext7ReviewSource(root, "run-wide");
    const framingBytes = Buffer.byteLength("--- wide.ts ---\n", "utf8");
    assert.ok(snapshot.bytes <= MAX_CONTEXT7_SOURCE_FILE_BYTES + framingBytes);
    assert.equal(snapshot.truncated, true);
    assert.doesNotMatch(snapshot.text, /�/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an internal-only workspace compiles a tool-less review claim", () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "README.md"), "No public package manifest.");
    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    assert.deepEqual(scope.claims, [
      { kind: "internal", id: "IC-1", subject: "Repository-internal logic, copy, layout, and conventions." },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source capture uses the existing redaction fence and excludes generated acceptance material", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "visible-acceptance"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.1.0" } }));
    writeFileSync(join(root, "src", "index.ts"), 'export const apiKey = "sk-test-123456789012345678901234";');
    writeFileSync(join(root, "visible-acceptance", "criterion.ts"), "held-out-shaped fixture title");
    writeFileSync(join(root, "node_modules", "dependency.js"), "installed code");
    writeFileSync(join(root, ".env"), "TOKEN=do-not-read");

    const snapshot = captureContext7ReviewSource(root, "run-test");

    assert.deepEqual(snapshot.files, ["package.json", "src/index.ts"]);
    assert.match(snapshot.text, /--- package\.json ---/u);
    assert.match(snapshot.text, /--- src\/index\.ts ---/u);
    assert.doesNotMatch(snapshot.text, /held-out-shaped fixture title|installed code|do-not-read/u);
    assert.doesNotMatch(snapshot.text, /sk-test-123456789012345678901234/u);
    assert.equal(snapshot.sourceHash.length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deliberate workspace-fence exclusions do not make Context7 review incomplete", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.1.0" } }));
    writeFileSync(join(root, "src", "index.ts"), 'export { default } from "next/link";');
    writeFileSync(join(root, ".env"), "TOKEN=do-not-read");
    writeFileSync(join(root, "node_modules", "dependency.js"), "installed code");

    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    const snapshot = captureContext7ReviewSource(root, "run-deliberate-exclusions");

    assert.equal(scope.scopeFailure, null);
    assert.equal(snapshot.truncated, false);
    assert.deepEqual(snapshot.files, ["package.json", "src/index.ts"]);
    assert.doesNotMatch(snapshot.text, /do-not-read|installed code/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a credential-named directory makes Context7 scope and capture incomplete", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.x" } }));
    writeFileSync(join(root, "src", "index.ts"), 'import React from "react"; export default React;');
    writeFileSync(join(root, "secrets", "auth.ts"), "export const hidden = true;");
    writeFileSync(join(root, "secrets", "package.json"), JSON.stringify({ dependencies: { next: "16.x" } }));

    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    const snapshot = captureContext7ReviewSource(root, "run-credential-directory");

    assert.equal(scope.scopeFailure, "scope_unavailable");
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.files, ["package.json", "src/index.ts"]);
    assert.doesNotMatch(snapshot.text, /hidden|next/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a credential-named source file makes Context7 scope and capture incomplete", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.x" } }));
    writeFileSync(join(root, "src", "index.ts"), 'import React from "react"; export default React;');
    writeFileSync(join(root, "secret.ts"), "export const hidden = true;");

    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    const snapshot = captureContext7ReviewSource(root, "run-credential-source");

    assert.equal(scope.scopeFailure, "scope_unavailable");
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.files, ["package.json", "src/index.ts"]);
    assert.doesNotMatch(snapshot.text, /hidden/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source capture records a bounded-file truncation instead of silently omitting the tail", () => {
  const root = workspace();
  try {
    for (let index = 0; index < MAX_CONTEXT7_SOURCE_FILES + 1; index += 1) {
      writeFileSync(join(root, `source-${String(index).padStart(3, "0")}.ts`), `export const n = ${String(index)};`);
    }
    const snapshot = captureContext7ReviewSource(root, "run-bounded");
    assert.equal(snapshot.files.length, MAX_CONTEXT7_SOURCE_FILES);
    assert.equal(snapshot.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source hash covers eligible files omitted from the bounded prompt", () => {
  const root = workspace();
  try {
    for (let index = 0; index < MAX_CONTEXT7_SOURCE_FILES + 1; index += 1) {
      writeFileSync(join(root, `source-${String(index).padStart(3, "0")}.ts`), `export const n = ${String(index)};`);
    }
    const before = captureContext7ReviewSource(root, "run-hash");
    writeFileSync(join(root, `source-${String(MAX_CONTEXT7_SOURCE_FILES).padStart(3, "0")}.ts`), "export const changed = true;");
    const after = captureContext7ReviewSource(root, "run-hash");
    assert.equal(before.text, after.text);
    assert.notEqual(before.sourceHash, after.sourceHash);
    assert.equal(after.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source hash covers same-size edits beyond the browser read ceiling", () => {
  const root = workspace();
  try {
    const prefix = Buffer.alloc(300 * 1024, 0x61);
    prefix[prefix.length - 1] = 0x62;
    writeFileSync(join(root, "large.ts"), prefix);
    const before = captureContext7ReviewSource(root, "run-full-bytes");
    prefix[prefix.length - 1] = 0x63;
    writeFileSync(join(root, "large.ts"), prefix);
    const after = captureContext7ReviewSource(root, "run-full-bytes");
    assert.equal(before.text, after.text, "the bounded prompt intentionally cannot see this tail edit");
    assert.notEqual(before.sourceHash, after.sourceHash);
    assert.equal(after.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested manifest conflicts and malformed manifests fail scope closed", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.1.0" } }));
    writeFileSync(join(root, "app", "package.json"), JSON.stringify({ dependencies: { react: "18.3.0" } }));
    assert.equal(compileContext7ReviewScope({ projectId: "coding-agent", workspace: root }).scopeFailure, "scope_unavailable");
    writeFileSync(join(root, "app", "package.json"), "{");
    assert.equal(compileContext7ReviewScope({ projectId: "coding-agent", workspace: root }).scopeFailure, "scope_unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked manifest is an explicit scope failure and is never read", () => {
  const root = workspace();
  const outside = workspace();
  try {
    writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { next: "16.x" } }));
    symlinkSync(join(outside, "package.json"), join(root, "package.json"));
    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    assert.equal(scope.scopeFailure, "scope_unavailable");
    assert.equal(scope.claims.some((claim) => claim.kind === "external"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked source directory makes scope and capture incomplete without reading the target", () => {
  const root = workspace();
  const outside = workspace();
  try {
    mkdirSync(join(outside, "src"));
    writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { next: "16.x" } }));
    writeFileSync(join(outside, "src", "index.ts"), "export const hidden = true;");
    symlinkSync(outside, join(root, "linked"));
    writeFileSync(join(root, "README.md"), "ordinary internal note");

    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    const snapshot = captureContext7ReviewSource(root, "run-symlinked-dir");

    assert.equal(scope.scopeFailure, "scope_unavailable");
    assert.equal(scope.claims.some((claim) => claim.kind === "external"), false);
    assert.equal(snapshot.truncated, true);
    assert.doesNotMatch(snapshot.text, /hidden|next/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an excluded eligible source path makes capture incomplete", () => {
  const root = workspace();
  try {
    symlinkSync("/definitely-not-read", join(root, "component.tsx"));
    const snapshot = captureContext7ReviewSource(root, "run-symlinked-file");
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a depth-excluded directory without an extension makes scope and capture incomplete", () => {
  const root = workspace();
  try {
    let current = root;
    for (let depth = 0; depth < MAX_TREE_DEPTH + 1; depth += 1) {
      current = join(current, `level-${String(depth)}`);
      mkdirSync(current);
    }
    writeFileSync(join(current, "package.json"), JSON.stringify({ dependencies: { next: "16.x" } }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.x" } }));

    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    const snapshot = captureContext7ReviewSource(root, "run-depth-excluded");

    assert.equal(scope.scopeFailure, "scope_unavailable");
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.files, ["package.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external claim cap matches the bounded sequential tool budget", () => {
  const root = workspace();
  try {
    const dependencies = Object.fromEntries(
      Array.from({ length: MAX_CONTEXT7_EXTERNAL_CLAIMS }, (_, index) => [`package-${String(index)}`, "1.0.0"]),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies }));
    const atCap = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    assert.equal(atCap.scopeFailure, null);
    assert.equal(atCap.claims.filter((claim) => claim.kind === "external").length, 8);
    dependencies["package-over-cap"] = "1.0.0";
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies }));
    assert.equal(
      compileContext7ReviewScope({ projectId: "coding-agent", workspace: root }).scopeFailure,
      "scope_unavailable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("realistic Next scope ignores unused dev tooling and validates only corroborated dev packages", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.tsx"), 'import React from "react"; import { icons } from "lucide-react/icons"; export { default } from "next/link";');
    writeFileSync(join(root, "src", "app.css"), '@import "tailwindcss";');
    writeFileSync(join(root, "postcss.config.mjs"), 'import adapter from "@tailwindcss/postcss"; export default adapter;');
    writeFileSync(join(root, "eslint.config.mjs"), 'import nextConfig from "eslint-config-next"; export default nextConfig;');
    writeFileSync(join(root, "package.json"), JSON.stringify({
      dependencies: { next: "16.2.12", react: "19.2.0", "react-dom": "19.2.0", "lucide-react": "0.468.0" },
      devDependencies: {
        tailwindcss: "4.1.0",
        "@types/node": ">=20",
        "@types/react": "latest",
        eslint: "latest",
        vite: "7.0.0",
        "@playwright/test": "1.62.0",
        "@tailwindcss/postcss": "4.1.0",
        "eslint-config-next": "16.2.12",
      },
      scripts: { dev: "next dev" },
    }));
    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    assert.equal(scope.scopeFailure, null);
    assert.deepEqual(
      scope.claims.filter((claim) => claim.kind === "external").map((claim) => claim.package),
      ["lucide-react", "next", "react", "react-dom", "tailwindcss"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("development usage recognizes static, bare, export-from, dynamic, require, and CSS imports", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "imports.ts"),
      [
        'import thing from "@xyflow/react/subpath";',
        'import "swr/setup";',
        'export { value } from "lucide-react/path";',
        'void import("motion/feature");',
        'require("vite/register");',
      ].join("\n"),
    );
    writeFileSync(join(root, "src", "imports.css"), '@import "tailwindcss/theme.css";');
    writeFileSync(join(root, "package.json"), JSON.stringify({
      devDependencies: {
        "@xyflow/react": "1.0.0",
        swr: "1.0.0",
        "lucide-react": "1.0.0",
        motion: "1.0.0",
        vite: "1.0.0",
        tailwindcss: "1.0.0",
        "unused-pkg": "latest",
      },
    }));
    const scope = compileContext7ReviewScope({ projectId: "coding-agent", workspace: root });
    assert.equal(scope.scopeFailure, null);
    assert.deepEqual(
      scope.claims.filter((claim) => claim.kind === "external").map((claim) => claim.package),
      ["@xyflow/react", "lucide-react", "motion", "swr", "tailwindcss", "vite"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
