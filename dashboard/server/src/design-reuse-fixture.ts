/**
 * design-reuse-fixture.ts — a run with a complete, LOCKED design set on disk.
 *
 * NOT A TEST FILE, ON PURPOSE, and the same reason `container-fixture.ts` and
 * `graph-fixture.ts` are not: `node --test "dist/**\/*.test.js"` runs every file
 * whose name matches, so a shared builder living in a `.test.ts` would execute as
 * a suite of its own with nothing in it.
 *
 * ONE SHAPE, THREE CONSUMERS. `design-reuse.test.ts` (the module), the intake
 * route's test and the orchestrator's both need a lendable source run. Three
 * hand-written fixtures would drift, and the drift would be invisible: a source
 * that is subtly incomplete makes a refusal test pass for the wrong reason.
 *
 * THE NUMBERS ARE THE MEASURED ONES. Three directions with seven stills for the
 * locked one and two for each of the others — 11 images, one lock — which is
 * `run-2026-08-12T09-00-35-066Z-6ec44b2f`'s own `design-refs/` and its
 * `"images": 11` in `results/design-lane.json`.
 *
 * IT ALSO WRITES TWO DECOYS. `workspace/src/index.html` and
 * `results/score.json` are the source run's own artefact and its own record —
 * exactly what a reuse must never carry across — so the exclusion can be asserted
 * rather than assumed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyDesignLockRecord, writeDesignLock } from "./design-lock.js";
import type { DesignManifest, DesignRef } from "./design-manifest.js";
import { refsDirFor, writeDesignManifest } from "./design-manifest.js";
import type { RunPaths } from "./paths.js";

/** A real PNG signature, because `countDesignPngs` sniffs CONTENT and not names. */
export const FIXTURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

export const FIXTURE_DIRECTIONS = [
  { slug: "desk-scatter", sections: ["hero", "work", "project", "about", "contact", "not-found", "selected-work"] },
  { slug: "margin-annotation", sections: ["hero", "work"] },
  { slug: "ruled-ledger", sections: ["hero", "work"] },
] as const;

/** The locked direction, and therefore the direction a reusing run inherits. */
export const FIXTURE_CHOSEN = FIXTURE_DIRECTIONS[0].slug;

export const FIXTURE_IMAGE_COUNT = FIXTURE_DIRECTIONS.reduce((sum, d) => sum + d.sections.length, 0);

export const FIXTURE_LOCKED_AT = "2026-08-12T11:07:26.512Z";

/**
 * Write a lendable design set into `source`, and return the locked still's path.
 *
 * `writeDesignManifest` and `writeDesignLock` are the HOST's own writers, so the
 * fixture cannot express a manifest the production parser would reject — which is
 * the property that makes a refusal test's negative control trustworthy.
 */
export function writeReusableDesign(source: RunPaths): string {
  const refsDir = refsDirFor(source.workspace);
  mkdirSync(refsDir, { recursive: true });
  mkdirSync(source.results, { recursive: true });
  mkdirSync(join(source.workspace, "src"), { recursive: true });
  writeFileSync(join(source.workspace, "src", "index.html"), "<!doctype html>the source run's site", "utf8");
  writeFileSync(join(source.results, "score.json"), '{"heldOutPass":true}\n', "utf8");

  const refs: DesignRef[] = [];
  for (const direction of FIXTURE_DIRECTIONS) {
    writeFileSync(join(refsDir, `direction-${direction.slug}.md`), `# ${direction.slug}\n`, "utf8");
    for (const [index, section] of direction.sections.entries()) {
      const name = `${direction.slug}-0${String(index + 1)}-${section}.png`;
      writeFileSync(join(refsDir, name), FIXTURE_PNG);
      refs.push({
        path: join(refsDir, name),
        section,
        aspect: "16:9",
        intent: `the ${section} of ${direction.slug}`,
        direction: direction.slug,
        origin: index < 2 ? "canvass" : "expansion",
        // TWO REFS CARRY THE VIDEO MARK, WHICH IS THE MEASURED COUNT:
        // `grep -c '"animate": true'` over
        // `run-2026-08-12T09-00-35-066Z-6ec44b2f/workspace/design-refs/manifest.json`
        // returns 2. It matters because `runVideoLane` runs on the BUILD segment —
        // the only segment a reused run takes — and `planVideoLegs` buys a metered
        // Veo leg per marked ref. A fixture with no marks could not see that.
        ...(direction.slug === FIXTURE_CHOSEN && index < 2 ? { animate: true } : {}),
      });
    }
  }
  writeFileSync(join(refsDir, "direction.md"), "# Desk scatter\nwarm off-white paper, tilted sheets\n", "utf8");
  writeFileSync(join(refsDir, "direction-choice.json"), `{"slug":"${FIXTURE_CHOSEN}"}\n`, "utf8");

  const locked = join(refsDir, `${FIXTURE_CHOSEN}-01-hero.png`);
  const manifest: DesignManifest = {
    version: 1,
    refs,
    directions: FIXTURE_DIRECTIONS.map((direction) => ({
      slug: direction.slug,
      name: direction.slug,
      distinction: `what makes ${direction.slug} different from the other two`,
      notes: join(refsDir, `direction-${direction.slug}.md`),
    })),
    chosenDirection: FIXTURE_CHOSEN,
    directionChoice: { by: "ui-designer", reason: "it reproduces the reference one-to-one", at: FIXTURE_LOCKED_AT },
    lockedMockup: locked,
    lockedBy: "ui-designer",
    lockedReason: '"Desk scatter" — the only direction that reproduces the reference',
    lockedAt: FIXTURE_LOCKED_AT,
  };
  writeDesignManifest(source.workspace, manifest);
  writeDesignLock(source.results, {
    ...emptyDesignLockRecord(FIXTURE_LOCKED_AT),
    locked,
    lockedBy: "ui-designer",
    reason: manifest.lockedReason,
    chosenDirection: FIXTURE_CHOSEN,
    chosenDirectionBy: "ui-designer",
    chosenDirectionReason: "it reproduces the reference one-to-one",
    expanded: true,
  });
  return locked;
}
