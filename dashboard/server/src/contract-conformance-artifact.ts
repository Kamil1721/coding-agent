/** Opt-in artifact writer. No run admission, repair, renderer, or scorer integration. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./creative-contract.js";
import type { CreativeContractV1 } from "./creative-contract.js";
import { compareContractConformance } from "./contract-conformance.js";
import type { ConformanceIssue } from "./contract-conformance.js";

export const CONTRACT_CONFORMANCE_FILE = "contract-conformance.json";
export interface ContractConformanceArtifact {
  readonly schemaVersion: 1;
  readonly htmlSha256: string;
  readonly contractCanonicalSha256: string;
  readonly issues: readonly ConformanceIssue[];
}
export function writeContractConformanceArtifact(resultsDir: string, html: string, contract: CreativeContractV1): ContractConformanceArtifact {
  const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
  const artifact: ContractConformanceArtifact = {
    schemaVersion: 1, htmlSha256: hash(html), contractCanonicalSha256: hash(canonicalJson(contract)),
    issues: compareContractConformance(html, contract),
  };
  mkdirSync(resultsDir, { recursive: true });
  const target = join(resultsDir, CONTRACT_CONFORMANCE_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return artifact;
}
