/**
 * owner-reference.ts — the image the OWNER attached, made reachable by the
 * grader without widening the fence that keeps a generated ref honest.
 *
 * THE PROBLEM THIS EXISTS FOR, IN THE OWNER'S OWN WORDS: "it builds the design I
 * PROVIDED". Until this file, it could not. `http.ts` writes his attachment to
 * `runs/<id>/references/reference-N.<ext>` and digests it; `design-manifest.ts`
 * then fences every ref to `<workspace>/design-refs/`, and `design-lock.ts`
 * refuses to lock any path that is not already one of those refs. The owner's
 * image is outside both, so it can never be `lockedMockup` — the gate compares
 * the build against a mockup a MODEL generated, and "does this match what he
 * gave us" has no referent at all. (2026-08-05 design-fidelity spec §4.1.)
 *
 * THE FENCE IS NOT WIDENED, AND IT MUST NOT BE. The reason `design-manifest.ts`
 * validates ref paths is that they arrive in a manifest an AGENT wrote: "an
 * unvalidated absolute path there is a file-read primitive with a prompt
 * attached" (design-manifest.ts:9-13). Relaxing it so the owner's image can be a
 * ref would relax it for every agent-authored path too. Instead this module
 * opens a SECOND slot that only host code can fill: `references.json` is written
 * by `http.ts` inside `runs/<id>/references/`, which is outside the build
 * sandbox's `sandbox.filesystem.allowWrite: [workspace]`, so nothing in a run
 * can put a path here. The owner's image reaches the grader as a criterion's
 * `reference`; it never becomes a lock candidate. (Spec §4.2.)
 *
 * SO WHY VALIDATE AT ALL, IF NO AGENT CAN WRITE THE MANIFEST. Because the value
 * this returns is handed to an agent to `Read`, which makes it exactly the
 * primitive the fence next door exists to contain, and "no agent can write it
 * today" is a fact about the current `allowWrite` rather than a property of this
 * function. `readReferenceManifest` says plainly that it does NOT validate field
 * by field — "this file editing itself" — and it is right for its callers, which
 * only forward paths already in the prompt. This one is the caller that turns a
 * manifest string into a file an agent opens on the strength of it being "the
 * design the owner supplied", so it checks every property that claim rests on:
 * where the file is, what it is, and whether its bytes are still the bytes the
 * TICKET was minted from.
 *
 * THE DIGEST IS CHECKED, AND THAT IS NOT BELT-AND-BRACES. `ReferenceImage.sha256`
 * is what enters the ticket id (ticket-refs.ts:130-133), and the run is graded
 * under that ticket. A file whose bytes no longer hash to the recorded digest is
 * not the design this run was minted from, so grading against it would compare
 * the build to an image the ticket does not cover — a fidelity check whose
 * referent drifted is worse than no fidelity check, because it reads as
 * evidence. 560 KB of sha256 is about a millisecond; the reads are per-request
 * and rare.
 *
 * EVERY REFUSAL IS `null` OR AN OMISSION, NEVER A THROW, and that direction is
 * deliberate in the same way `readReferenceManifest`'s flattening is: the DESIGN
 * lane degrades rather than blocks. A run whose owner-image slot cannot be
 * validated grades against the locked mockup alone, exactly as every run before
 * this file did. Nothing here can fail a run, and nothing here should be able
 * to.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { readReferenceManifest, referenceDirFor } from "./ticket-refs.js";

/**
 * One image the owner attached, validated to the standard a path handed to an
 * agent needs.
 *
 * DELIBERATELY NOT `ReferenceImage` ITSELF even though the fields are a subset.
 * That type is what the intake WROTE; this one is what a reader was willing to
 * VOUCH FOR after opening the file. Sharing the name would let a caller that
 * holds an unvalidated manifest entry satisfy a signature that means "validated"
 * — which is the entire distinction this module exists to draw.
 */
export interface OwnerReference {
  /** Absolute host path, proven to sit directly inside this run's `references/`. */
  readonly path: string;
  /** sha256 of the bytes ON DISK, proven equal to the digest in the manifest. */
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * The extensions an owner reference may carry.
 *
 * TAKEN FROM THE INTAKE'S OWN GRAMMAR, not invented here: `decodeReferenceDataUrl`
 * (ticket-refs.ts:116) accepts `png|jpeg|jpg|webp|gif` and normalises `jpeg` to
 * `jpg`, so those five are the whole set of extensions this directory can
 * legitimately contain. `jpeg` is kept anyway because the normalisation is the
 * intake's, not the filesystem's, and a manifest written by a future intake that
 * stops normalising would otherwise silently produce zero references.
 *
 * THE POINT OF THE CHECK IS THE `.json` AND THE `.pdf`, NOT THE `.png`. The same
 * directory holds `references.json`, and `documents/` next door holds files
 * whose bytes `document-intake.ts` says cannot be redacted. This is what stops a
 * mis-typed manifest entry putting either in front of a vision grader as "the
 * design the owner supplied".
 */
const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * DIRECTORY EQUALITY, NOT A PREFIX TEST, and the difference is a real escape.
 * `resolve(path).startsWith(dir)` is satisfied by
 * `runs/<id>/references-elsewhere/x.png` — a sibling directory whose name merely
 * begins with the fence's — and by any depth of subdirectory under it. The
 * intake writes `reference-N.<ext>` FLAT into this one directory, so no
 * legitimate entry has a parent other than exactly this one, and equality on the
 * resolved parent refuses both shapes without a separator dance.
 *
 * `resolve` FIRST, so `references/../workspace/index.html` is compared as the
 * workspace path it actually names rather than as the reference path it spells.
 */
function insideReferenceDir(candidate: string, referenceDir: string): boolean {
  return dirname(resolve(candidate)) === resolve(referenceDir);
}

function validate(raw: unknown, referenceDir: string): OwnerReference | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const path = entry["path"];
  const sha256 = entry["sha256"];
  if (typeof path !== "string" || path.trim().length === 0) return null;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  if (!insideReferenceDir(path, referenceDir)) return null;
  if (!IMAGE_EXTENSIONS.includes(extname(path).toLowerCase())) return null;
  if (!existsSync(path)) return null;
  let bytes: Buffer;
  try {
    if (!statSync(path).isFile()) return null;
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  // THE BYTES DECIDE, NOT THE MANIFEST. See the header: this digest is the
  // ticket's identity, and a reference that no longer matches it is not the
  // design this run is being graded under.
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return null;
  return { path: resolve(path), sha256, bytes: bytes.byteLength };
}

/**
 * Every image the owner attached to this run's ticket, in the order he attached
 * them, minus any entry this module could not vouch for.
 *
 * A CAPTURE IS NOT A SUPPLIED DESIGN, AND THE 2026-07-30 RUN IS WHY THE
 * DISTINCTION IS DRAWN HERE RATHER THAN LEFT TO A CALLER. That run's
 * `references.json` opens `"images": []` and carries a three-shot `capture` of
 * `kamilborzecki.dev` — screenshots this program took of a page the owner NAMED,
 * which is a reference in the loose sense and is emphatically not "the design I
 * provided". Folding the capture in here would hand the grader a screenshot of
 * an existing site as the thing the build was supposed to reproduce, and the one
 * run on disk that would have hit that branch is a run where it would have been
 * wrong. `manifest.capture` is therefore never read by this file.
 *
 * DOCUMENTS ARE NOT READ EITHER, for `hasReferences`' stated reason one door
 * down: this returns paths that go in front of something that LOOKS, and a PDF
 * produces nothing to look at.
 */
export function ownerReferencesFor(runsRoot: string, runId: string): readonly OwnerReference[] {
  const referenceDir = referenceDirFor(runsRoot, runId);
  const manifest = readReferenceManifest(referenceDir);
  if (manifest === null) return [];
  return manifest.images
    .map((image) => validate(image, referenceDir))
    .filter((image): image is OwnerReference => image !== null);
}

/**
 * The ONE image a fidelity comparison is made against, or null.
 *
 * FIRST BY MANIFEST ORDER, WHICH IS THE ORDER HE ATTACHED THEM. `http.ts`
 * ordinal-names them "so the manifest order and the on-disk order are the same
 * reading, and a builder listing the directory sees the owner's sequence"
 * (http.ts:1940-1941); the first is the one his prose is most likely about.
 *
 * ONE, NOT ALL, AND THE REASON IS THE SAME ONE §17.2 GAVE FOR THE LOCK ITSELF:
 * comparing a design against a SET answers "does this resemble something he sent
 * us", which is not a question. If he attaches three images, the other two are
 * still in his ticket, still in front of the builder, and still listed by
 * {@link ownerReferencesFor} for a caller that wants to say how many there were.
 * What they are not is a second referent for a comparison that only means
 * something when it has exactly one.
 */
export function ownerReferenceFor(runsRoot: string, runId: string): OwnerReference | null {
  return ownerReferencesFor(runsRoot, runId)[0] ?? null;
}
