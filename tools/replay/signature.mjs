/**
 * THE STABLE DEFECT FINGERPRINT — shared contract `DefectRecord.signature`.
 *
 *   "STABLE fingerprint: site + sorted field paths. NOT prose."
 *
 * Prose is excluded on purpose: the validator's sentences are the thing most
 * likely to be improved, and a fingerprint that moves every time a remediation
 * clause is reworded cannot content-address anything. `dashboard/data/defects/
 * <signature>.jsonl` is append-only and keyed by this, so this function must
 * return the same string tomorrow for the same defect.
 *
 * ARRAY INDICES ARE NORMALISED: `dataExpectations[0].id` and
 * `dataExpectations[1].id` collapse to `dataExpectations[].id`. Without this,
 * the same seat mistake made in a manifest with two entries and one with three
 * would be two signatures and two separate learning buckets. a913c871's attempt 1
 * failed the SAME way on both of its entries; that is one defect, not two.
 */

import { createHash } from "node:crypto";

/** `dataExpectations[12].id` → `dataExpectations[].id` */
export function normaliseFieldPath(field) {
  return String(field).replace(/\[\d+\]/g, "[]");
}

export function normaliseFieldPaths(fields) {
  return [...new Set(fields.map(normaliseFieldPath))].sort();
}

/**
 * @param site  where the defect was detected, e.g. "spec/suite.manifest.json".
 *              Stable identifiers only — never a run id, never a timestamp.
 * @param fields the field paths the validator named.
 */
export function defectSignature(site, fields) {
  const paths = normaliseFieldPaths(fields);
  if (paths.length === 0) {
    // A defect the validator could not attribute to any field still needs a
    // bucket, and it must not collide with the well-attributed ones.
    return `${site}#unattributed`;
  }
  const digest = createHash("sha256").update(`${site}\n${paths.join("\n")}`, "utf8").digest("hex");
  return `${site}#${digest.slice(0, 16)}`;
}

/** The human-readable half, for reports. Never used as a key. */
export function describeSignature(site, fields) {
  const paths = normaliseFieldPaths(fields);
  return `${defectSignature(site, paths)}  [${paths.join(" ") || "unattributed"}]`;
}
