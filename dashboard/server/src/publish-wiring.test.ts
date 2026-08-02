/**
 * publish-wiring.test.ts — the README's provenance block, THROUGH THE CALL SITE.
 *
 * WHAT THIS EXISTS TO CATCH, AND WHY NOTHING ELSE COULD. `publishProject`'s
 * `run` argument is OPTIONAL (`PublishRequest.run?: PublishRunFacts | undefined`)
 * because it was written before its only caller was available to edit. Every
 * existing test of the publish path calls `publishProject` DIRECTLY and passes
 * `run` itself, so all of them stayed green while `orchestrator.ts
 * #publishProject` — the one call site a real run goes through — omitted it. The
 * result was measured on 2026-08-02 and carried in
 * `docs/STATE-2026-08-02-end-to-end.md` as "still unwired": every NEW run's
 * published README printed `not recorded` for run id, ticket id, verdict and
 * model, under a fully green suite.
 *
 * SO THIS TEST DRIVES THE ORCHESTRATOR, NOT THE FUNCTION. A unit test of
 * `publishProject({run: …})` cannot observe a caller that omits the argument —
 * it supplies the very thing whose absence is the defect. The only check with
 * teeth reaches `#publishProject` through `#finish` and reads the README off
 * disk.
 *
 * IT ASSERTS CONTENT, NOT THE ARGUMENT. Nothing here spies on the call. The run
 * id, ticket id, model id and verdict are given distinctive values at seed time
 * and looked for in the rendered file, so the test states the owner-facing
 * property — "the README names the run that produced this folder" — rather than
 * an implementation detail that a refactor could satisfy while the README stayed
 * wrong.
 *
 * NEGATIVE CONTROL (measured, and it is the reason this file exists). With
 * `run: row,` absent from `orchestrator.ts #publishProject` — the state of the
 * tree when this was written — both tests below fail on the provenance
 * assertions, reporting `not recorded` where the run id belongs. Restoring the
 * line turns them green. That mutation is the ONE this file is the control for;
 * every other publish test is green in both states.
 *
 * CANCEL IS THE CHEAPEST ROUTE TO `#finish`, and it is a real one rather than a
 * shortcut. Every terminal status publishes — `#publishProject` hangs off
 * `#finish` deliberately, because a failed or cancelled run's code is still the
 * thing the owner asked to be able to open. A queued run that is cancelled
 * reaches the same line a passed run reaches, with no seat call, no subprocess
 * and no quota spent.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { readPublishedProject } from "./project-publish.js";

/** A run id shaped like the ones the server mints — `runIdSuffix` reads its tail. */
const RUN_ID = "run-2026-08-02T12-00-00-000Z-abcd1234";
const TICKET_ID = "ticket-7f3c9e2b1a04d658";
const MODEL_ID = "claude-opus-5-provenance-probe";

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: Orchestrator;
  readonly dir: string;
  readonly paths: ReturnType<typeof resolvePaths>;
  cleanup(): void;
}

/**
 * `DASHBOARD_PROJECTS_DIR` IS PINNED, AND LEAVING IT UNSET IS A REAL LEAK.
 *
 * `resolvePaths` derives `projects` as `resolve(home, "..", "projects")` — the
 * SIBLING of home, which is right for the real layout (`dashboard/runs` beside
 * `dashboard/projects`) and wrong for a `mkdtemp` home: the sibling of
 * `$TMPDIR/dash-publish-wiring-XXXX` is `$TMPDIR/projects`, one shared directory
 * that no harness owns and `rmSync(dir)` cannot reach.
 *
 * MEASURED, not theorised. An earlier version of this file left it unset and its
 * publishes landed in `$TMPDIR/projects` alongside 155 `portfolio*` directories
 * dated 31 July from other suites. The collision is not cosmetic: `candidateNames`
 * falls back to `<slug>-<suffix>`, then `-2`, `-3`, so the SECOND run of this file
 * got a different destination from the first and an assertion about the folder's
 * name flipped between runs. Pinning it inside the temp home makes the fixture
 * hermetic and lets `cleanup` actually delete what the test wrote.
 */
function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dash-publish-wiring-"));
  const paths = resolvePaths({
    DASHBOARD_HOME: dir,
    DASHBOARD_PROJECTS_DIR: join(dir, "projects"),
  });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  // Both binaries are absent on purpose: nothing in this file may reach a model.
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: {},
  });
  return {
    store,
    orchestrator,
    dir,
    paths,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A run row with facts worth printing, and a workspace worth copying.
 *
 * THE WORKSPACE SHIPS NO `README.md`, deliberately: `publishProject` renders one
 * only when the builder shipped none, so a fixture that included one would test
 * nothing and would look exactly like a pass.
 */
function seedRunWithWorkspace(h: Harness, title: string): void {
  h.store.createRun({
    runId: RUN_ID,
    ticketId: TICKET_ID,
    ticketTitle: title,
    ticketText: `build ${title}`,
    ticketSha256: "d".repeat(64),
    modelId: MODEL_ID,
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
  const workspace = runPathsFor(h.paths, RUN_ID).workspace;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "index.html"), "<!doctype html><title>built</title>\n", "utf8");
  writeFileSync(join(workspace, "main.js"), "console.log('built');\n", "utf8");
}

/** The published folder's README, via the record the run wrote about itself. */
function publishedReadme(h: Harness): { readonly path: string; readonly text: string } {
  const record = readPublishedProject(runPathsFor(h.paths, RUN_ID).results);
  assert.ok(record !== null, "the run wrote no publish record at all — #publishProject never ran");
  assert.equal(
    record.published,
    true,
    record.published ? "" : `the publish DECLINED (${record.reason}): ${record.detail}`,
  );
  assert.ok(record.published);
  const readme = join(record.path, "README.md");
  assert.ok(existsSync(readme), `the publish reported success but wrote no README at ${readme}`);
  return { path: record.path, text: readFileSync(readme, "utf8") };
}

test("a published README names the run that produced it — the orchestrator's own call site passes the row", async () => {
  const h = harness();
  try {
    seedRunWithWorkspace(h, "Provenance probe site");
    // `shutdown()` first so `cancel` takes the queued-run branch and no start is
    // attempted; the existing orchestrator tests use the same ordering.
    await h.orchestrator.shutdown();
    assert.equal(h.orchestrator.cancel(RUN_ID), true, "a queued run must be cancellable");

    const row = h.store.getRun(RUN_ID);
    assert.ok(row !== null);
    assert.equal(row.status, "cancelled", "the run must have gone terminal, or nothing publishes");

    const { text } = publishedReadme(h);

    // THE FOUR FACTS THE HANDOVER RECORDED AS "not recorded". Each is asserted
    // by VALUE, so a README that printed the right shape with the wrong run —
    // the folder-collision case — is red too.
    assert.match(
      text,
      new RegExp(`\\| Run \\| \`${RUN_ID}\` \\|`),
      "the README's provenance block does not name this run: `run: row` is missing from the " +
        "publishProject call in orchestrator.ts #publishProject, so the owner cannot trace the folder back",
    );
    assert.match(
      text,
      new RegExp(`\\| Ticket \\| \`${TICKET_ID}\` \\|`),
      "the README does not name the ticket this folder was built from",
    );
    assert.match(text, /\| Verdict \| cancelled \|/, "the README does not state how the run ended");
    assert.match(
      text,
      new RegExp(`\\| Model \\| \`${MODEL_ID}\` \\|`),
      "the README does not name the model that built this folder",
    );

    // AND THE ABSENCE, NAMED. The four assertions above would also pass if the
    // block rendered every row twice; this is the statement that nothing in the
    // provenance table is the placeholder the unwired call site produced.
    assert.doesNotMatch(
      text,
      /not recorded/,
      "the README still carries `not recorded` — the provenance block is rendering placeholders " +
        "for facts the run row holds",
    );
  } finally {
    h.cleanup();
  }
});

test("the run id in the README is the whole minted id, not a slug or a suffix", async () => {
  /*
   * A SEPARATE TEST BECAUSE A SUBSTRING MATCH IS NOT AN IDENTITY MATCH. The
   * published folder's NAME already contains `runIdSuffix(runId)` — the last
   * eight characters — so a README that printed only the suffix, or that printed
   * the folder's own slug, would satisfy a loose "does it mention the run" check
   * while still leaving the owner unable to find `runs/<id>/` on disk. The id is
   * the join key back to the run record, the event stream and the verdict.
   *
   * THE LENGTH IS 37, MEASURED, AND SIX DOCBLOCKS IN THIS REPO SAY 44. The id is
   * built at `http.ts:1712` as
   * `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
   * which is 4 + 24 + 1 + 8 = 37. Checked three ways: a freshly minted id, the
   * id of the one run that reached a verdict on this machine
   * (`run-2026-07-30T20-16-40-242Z-052c6e02`), and this fixture — all 37. The
   * assertion is here so the fixture cannot quietly stop being the shape the
   * server mints, which is the only thing that makes the suffix check below mean
   * anything.
   */
  const h = harness();
  try {
    seedRunWithWorkspace(h, "Identity probe");
    await h.orchestrator.shutdown();
    assert.equal(h.orchestrator.cancel(RUN_ID), true);

    const { path, text } = publishedReadme(h);

    const rows = text.split("\n").filter((line) => line.startsWith("| Run |"));
    assert.equal(rows.length, 1, `the provenance block must have exactly one Run row, got ${String(rows.length)}`);
    const row = rows[0];
    assert.ok(row !== undefined);
    // The WHOLE id, and the id's own length, so a truncation is red rather than
    // "close enough".
    assert.ok(
      row.includes(RUN_ID),
      `the Run row is \`${row}\` and does not carry the full run id ${RUN_ID}`,
    );
    assert.equal(RUN_ID.length, 37, "this fixture's id must be the shape the server actually mints");

    /*
     * AND THE FOLDER'S OWN NAME CANNOT SUBSTITUTE FOR IT — which is why the
     * README is the only place the link back exists.
     *
     * MEASURED, having first assumed the opposite: `candidateNames` yields the
     * bare slug FIRST and only falls back to `<slug>-<runIdSuffix>` on an
     * EEXIST collision, so an uncontended publish is named `identity-probe`
     * with no run id in it at all. An earlier version of this test asserted the
     * path ended in the suffix and went red for that reason. So on the ordinary
     * path there is nothing on disk outside this README that says which run
     * produced the folder.
     */
    assert.ok(
      path.endsWith("identity-probe"),
      `the uncontended destination is the bare slug; got ${path}`,
    );
    assert.ok(
      !path.includes(RUN_ID),
      "the folder name does not carry the run id, so the README is the only join key back to the run",
    );
    assert.ok(
      !row.trim().endsWith("| `abcd1234` |"),
      "the README names only the run id SUFFIX, which is not a run identifier",
    );
  } finally {
    h.cleanup();
  }
});
