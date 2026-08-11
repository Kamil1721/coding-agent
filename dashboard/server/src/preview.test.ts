/**
 * preview.test.ts — a preview belongs to a run, not to the dashboard.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewHost } from "./preview.js";


/* ===========================================================================
 * TWO RUNS, TWO PREVIEWS — the singleton served the wrong artefact
 *
 * `serve()` used to open with `await this.stop()`, so run B's deploy freed 4321
 * and rebound it to B's workspace while run A's `previewUrl` column still said
 * 4321. A's link then served B's site. Worse than a dead link: #adversaryPhase
 * feeds that column to a live agent told to "Attack the running web app at ...",
 * so A's adversary attacks B and the findings are filed under A.
 * ======================================================================== */

test("two runs get two previews, and neither is served the other's files", async () => {
  const a = mkdtempSync(join(tmpdir(), "prev-a-"));
  const b = mkdtempSync(join(tmpdir(), "prev-b-"));
  writeFileSync(join(a, "index.html"), "<h1>RUN-A-ARTEFACT</h1>", "utf8");
  writeFileSync(join(b, "index.html"), "<h1>RUN-B-ARTEFACT</h1>", "utf8");
  const host = new PreviewHost();
  try {
    const urlA = await host.serve("run-a", a);
    const urlB = await host.serve("run-b", b);
    assert.notEqual(urlA, urlB, "the second run took the first run's port — this is the whole defect");

    // The assertion that actually catches it: read both, by the URL each run
    // recorded, and require each to serve ITS OWN artefact.
    const bodyA = await (await fetch(urlA)).text();
    const bodyB = await (await fetch(urlB)).text();
    assert.match(bodyA, /RUN-A-ARTEFACT/, `run A's URL served: ${bodyA.slice(0, 60)}`);
    assert.match(bodyB, /RUN-B-ARTEFACT/, `run B's URL served: ${bodyB.slice(0, 60)}`);

    assert.equal(host.activeFor("run-a")?.url, urlA);
    assert.equal(host.activeFor("run-b")?.url, urlB);
  } finally {
    await host.stop();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("stopping one run's preview leaves the other serving", async () => {
  // The arm that proves stop() got narrower rather than broken: shutdown still
  // needs the no-argument form to close everything, and that is asserted too.
  const a = mkdtempSync(join(tmpdir(), "prev-a-"));
  const b = mkdtempSync(join(tmpdir(), "prev-b-"));
  writeFileSync(join(a, "index.html"), "<h1>A</h1>", "utf8");
  writeFileSync(join(b, "index.html"), "<h1>B</h1>", "utf8");
  const host = new PreviewHost();
  try {
    await host.serve("run-a", a);
    const urlB = await host.serve("run-b", b);
    await host.stop("run-a");
    assert.equal(host.activeFor("run-a"), null, "the stopped run still has a preview");
    assert.equal(host.activeFor("run-b")?.url, urlB, "stopping A took B down with it");
    assert.match(await (await fetch(urlB)).text(), /B/, "B stopped serving when A was stopped");
    await host.stop();
    assert.equal(host.activeFor("run-b"), null, "the no-argument form must still close everything");
  } finally {
    await host.stop();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
