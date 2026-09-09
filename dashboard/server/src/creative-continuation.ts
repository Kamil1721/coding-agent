/** Isolated evidence lineage for creative continuation amendments.
 *
 * Snapshots contain the source inputs, never a resolver that trusts claimed hashes.
 * Every read reconstructs their fact projections and verifies the frozen contract.
 * Legacy projection rights verify unchanged ancestors only. New output receives
 * current projections and the ordinary strict compiler. Ancestors can be archived.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Ticket } from "bakeoff/dist/contracts.js";
import { canonicalJson, sha256Hex } from "./creative-contract.js";
import type { CreativeContractV1 } from "./creative-contract.js";
import type { CreativeAuthorFact } from "./creative-contract-author.js";
import {
  CREATIVE_AUTHOR_FILE, CREATIVE_CONTRACT_FILE, authorInputFor, checkCreativeContract,
} from "./creative-pilot.js";
import type { CreativeAmendmentProvenance } from "./creative-pilot.js";
import { ticketFromStoredReferences } from "./ticket.js";
import type { ReferenceManifest } from "./ticket-refs.js";

export const CREATIVE_INHERITANCE_FILE = "creative-inheritance.json";
/** Setting false restores the original re-authoring branch. */
export const CREATIVE_CONTINUATION_AMEND_ENABLED = true;
type AuthorPacket = ReturnType<typeof authorInputFor>;

interface Snapshot {
  readonly schemaVersion: 1;
  readonly sourceRunId: string;
  readonly ticketBrief: string;
  readonly ticketId: string;
  readonly ticketHash: string;
  readonly manifest: ReferenceManifest | null;
  readonly contract: CreativeContractV1;
  readonly author: unknown;
  readonly parent: Snapshot | null;
  readonly followup: string;
}

export interface CreativeInheritance {
  readonly contract: CreativeContractV1;
  readonly followup: string;
  readonly provenance: CreativeAmendmentProvenance;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readSnapshot(results: string): Snapshot | null {
  const path = join(results, CREATIVE_INHERITANCE_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

function facts(packet: AuthorPacket): readonly CreativeAuthorFact[] {
  return [...packet.input.ticket.facts, ...packet.input.designFacts, ...packet.input.referenceFacts];
}

/** Add only re-derived source facts. Exact evidence identity, including kind, is mandatory. */
function mergePacket(current: AuthorPacket, source: AuthorPacket, contract: CreativeContractV1): AuthorPacket {
  const referenced = new Set<string>();
  const pending: unknown[] = [contract];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else {
      const item = object(value);
      if (item === null) continue;
      if (["kind", "locator", "sha256", "excerptSha256"].every((key) => typeof item[key] === "string")) referenced.add(canonicalJson(item));
      pending.push(...Object.values(item));
    }
  }
  const identities = new Set(facts(current).map((fact) => canonicalJson(fact.evidence)));
  const inherited = facts(source).filter((fact) => {
    const key = canonicalJson(fact.evidence);
    if (!referenced.has(key) || identities.has(key)) return false;
    identities.add(key);
    return true;
  }).map((fact, index) => ({ ...fact, id: `inherited.${String(index + 1)}` }));
  return {
    input: { ...current.input, designFacts: [...current.input.designFacts, ...inherited] },
    resolver: { resolve(reference) { return current.resolver.resolve(reference) ?? source.resolver.resolve(reference); } },
    warnings: [...current.warnings, ...source.warnings],
  };
}

function provenance(snapshot: Snapshot, packet: AuthorPacket): CreativeAmendmentProvenance {
  return {
    sourceContractHash: sha256Hex(canonicalJson(snapshot.contract)),
    snapshotHash: sha256Hex(canonicalJson(snapshot)),
    inputHash: sha256Hex(canonicalJson(packet.input)),
    followupHash: sha256Hex(snapshot.followup),
  };
}

function authorProvenanceMatches(author: unknown, expected: CreativeAmendmentProvenance, field: "amendment" | "continuationReauthor" = "amendment"): boolean {
  const item = object(author);
  const other = field === "amendment" ? "continuationReauthor" : "amendment";
  return item?.["status"] === "compiled" && item["inputHash"] === expected.inputHash &&
    item[other] === undefined && canonicalJson(item[field] ?? null) === canonicalJson(expected);
}

function verifySnapshot(raw: unknown): { snapshot: Snapshot; packet: AuthorPacket } {
  const chain: Snapshot[] = [];
  const seen = new Set<unknown>();
  let node: unknown = raw;
  while (node !== null) {
    if (seen.has(node)) throw new Error("creative inheritance has a cycle");
    seen.add(node);
    const item = object(node);
    if (item === null || !Object.hasOwn(item, "parent")) throw new Error("creative inheritance snapshot is malformed");
    chain.push(node as Snapshot);
    node = item["parent"];
  }
  let verified: { snapshot: Snapshot; packet: AuthorPacket } | null = null;
  for (const snapshot of chain.reverse()) verified = verifySnapshotNode(snapshot, verified);
  if (verified === null) throw new Error("creative inheritance snapshot is empty");
  return verified;
}

function verifySnapshotNode(raw: unknown, parent: { snapshot: Snapshot; packet: AuthorPacket } | null): { snapshot: Snapshot; packet: AuthorPacket } {
  const item = object(raw);
  if (item === null || item["schemaVersion"] !== 1 || typeof item["sourceRunId"] !== "string" ||
    typeof item["ticketBrief"] !== "string" || typeof item["ticketId"] !== "string" ||
    typeof item["ticketHash"] !== "string" || typeof item["followup"] !== "string" ||
    !(item["manifest"] === null || object(item["manifest"]) !== null) ||
    !Object.hasOwn(item, "parent") || !Object.hasOwn(item, "author") || !Object.hasOwn(item, "contract")) {
    throw new Error("creative inheritance snapshot is malformed");
  }
  const snapshot = raw as Snapshot;
  const ticket = ticketFromStoredReferences(snapshot.ticketBrief, snapshot.manifest);
  if (ticket.id !== snapshot.ticketId || ticket.sha256 !== snapshot.ticketHash) {
    throw new Error("creative inherited source ticket digest changed");
  }
  let packet = authorInputFor(ticket, snapshot.manifest);
  if (parent !== null) {
    if (!authorProvenanceMatches(snapshot.author, provenance(parent.snapshot, packet), "continuationReauthor")) {
      packet = mergePacket(packet, parent.packet, parent.snapshot.contract);
      if (!authorProvenanceMatches(snapshot.author, provenance(parent.snapshot, packet))) {
        throw new Error("creative inherited source amendment provenance changed");
      }
    }
  } else if (object(snapshot.author)?.["amendment"] !== undefined || object(snapshot.author)?.["continuationReauthor"] !== undefined) {
    throw new Error("creative inherited source lineage snapshot is missing");
  }
  const checked = checkCreativeContract(JSON.stringify(snapshot.contract), snapshot.author, packet.resolver);
  if (checked.fresh === null) throw new Error(`creative inherited source is not frozen and resolvable: ${JSON.stringify(checked.compile.findings)}`);
  return { snapshot: { ...snapshot, contract: checked.fresh.contract }, packet };
}

/** Called after the four canonical results are copied and before the target is queued. */
export function stageCreativeInheritance(
  sourceRunId: string, sourceResults: string, targetResults: string,
  ticket: Ticket, manifest: ReferenceManifest | null, followup: string,
): void {
  if (!existsSync(join(sourceResults, CREATIVE_CONTRACT_FILE))) {
    let author: Record<string, unknown> | null = null;
    try { author = object(JSON.parse(readFileSync(join(sourceResults, CREATIVE_AUTHOR_FILE), "utf8")) as unknown); } catch { /* A failed fresh author may have no result. */ }
    if (existsSync(join(sourceResults, CREATIVE_INHERITANCE_FILE)) || author?.["amendment"] !== undefined || author?.["continuationReauthor"] !== undefined) {
      throw new Error("creative source results are incomplete: contract is missing");
    }
    return;
  }
  // The copied canonical contract is independently required; removing it from
  // the copy list cannot be concealed by authoring from this snapshot later.
  const contract = JSON.parse(readFileSync(join(targetResults, CREATIVE_CONTRACT_FILE), "utf8")) as CreativeContractV1;
  const author: unknown = JSON.parse(readFileSync(join(targetResults, CREATIVE_AUTHOR_FILE), "utf8"));
  const snapshot: Snapshot = {
    schemaVersion: 1, sourceRunId, ticketBrief: ticket.brief, ticketId: ticket.id, ticketHash: ticket.sha256,
    manifest, contract, author, parent: readSnapshot(sourceResults), followup,
  };
  verifySnapshot(snapshot);
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  mkdirSync(targetResults, { recursive: true });
  const path = join(targetResults, CREATIVE_INHERITANCE_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, path);
}

/** One evidence adaptation for contract entry, build, review, and recovery reads. */
export function continuationAuthorInputFor(ticket: Ticket, manifest: ReferenceManifest | null, results: string): AuthorPacket & {
  readonly inheritance: CreativeInheritance | null;
  readonly reuseAllowed: boolean;
  readonly reauthoring: CreativeAmendmentProvenance | null;
} {
  const current = authorInputFor(ticket, manifest);
  const raw = readSnapshot(results);
  if (raw === null) return { ...current, inheritance: null, reuseAllowed: true, reauthoring: null };
  const source = verifySnapshot(raw);
  const packet = mergePacket(current, source.packet, source.snapshot.contract);
  const inheritance = { contract: source.snapshot.contract, followup: source.snapshot.followup, provenance: provenance(source.snapshot, packet) };
  const reauthoring = provenance(source.snapshot, current);
  let completedAmendment = false;
  let completedReauthoring = false;
  try {
    const author: unknown = JSON.parse(readFileSync(join(results, CREATIVE_AUTHOR_FILE), "utf8"));
    const contract = readFileSync(join(results, CREATIVE_CONTRACT_FILE), "utf8");
    completedAmendment = authorProvenanceMatches(author, inheritance.provenance) && checkCreativeContract(contract, author, packet.resolver).fresh !== null;
    completedReauthoring = authorProvenanceMatches(author, reauthoring, "continuationReauthor") && checkCreativeContract(contract, author, current.resolver).fresh !== null;
  } catch { /* A copied or interrupted result has no verified completed mode. */ }
  // A frozen result retains its admitted resolver when the rollback flag moves.
  // The flag chooses the mode only for a phase that still needs to author.
  if (completedReauthoring || (!CREATIVE_CONTINUATION_AMEND_ENABLED && !completedAmendment)) {
    return { ...current, inheritance: null, reuseAllowed: completedReauthoring, reauthoring };
  }
  return { ...packet, reuseAllowed: true, reauthoring: null, inheritance };
}

export function completedCreativeAmendment(results: string, inheritance: CreativeInheritance): boolean {
  try {
    return authorProvenanceMatches(JSON.parse(readFileSync(join(results, CREATIVE_AUTHOR_FILE), "utf8")) as unknown, inheritance.provenance);
  } catch { return false; }
}

export function requireCompletedCreativeAmendment(results: string, inheritance: CreativeInheritance | null): void {
  if (inheritance !== null && !completedCreativeAmendment(results, inheritance)) {
    throw new Error("creative continuation has no completed amendment for the current input and inherited source");
  }
}
