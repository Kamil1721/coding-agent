import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { authorInputFor } from "../creative-pilot.js";
import type { CreativeContractV1 } from "../creative-contract.js";
import { ticketFromStoredReferences } from "../ticket.js";

const source = new URL("../../src/test-fixtures/", import.meta.url);
export const clinicTicketText = readFileSync(new URL("clinic-t21-ticket.md", source), "utf8");
export const clinicHistoricalBytes = readFileSync(new URL("clinic-t21-contract.json", source), "utf8");
export const clinicHistorical = JSON.parse(clinicHistoricalBytes) as CreativeContractV1;
export const clinicAuthorBytes = readFileSync(new URL("clinic-t21-author.json", source), "utf8");
export function clinicPacket() { return authorInputFor(ticketFromStoredReferences(clinicTicketText, null), null); }

// Anchors select a unique generated sentence; all locators and digests come from the splitter.
const anchors: Readonly<Record<string, string>> = {
  "p.wizard": "Implement a three-step wizard",
  "p.types": "Choose one of exactly three appointment types",
  "p.slots": "Choose a date and one of exactly four predefined time slots",
  "p.controls": "Include Back and Continue controls",
  "p.confirm": "Include Back and Continue controls",
  "p.reset": "Reset must return to Step 1",
  "p.local": "Keep all data local and deterministic",
  "p.a11y": "Accessibility requirements:",
  "p.focus": "After a validation failure",
  "p.responsive": "The layout must work at 375px",
  "p.run": "Deliver a static app or local web server",
};
export function deriveClinicContract(): CreativeContractV1 {
  const packet = clinicPacket();
  const facts = [...packet.input.ticket.facts, ...packet.input.designFacts];
  return {
    ...clinicHistorical,
    contentProof: clinicHistorical.contentProof.map((proof) => {
      const anchor = anchors[proof.id];
      const matches = facts.filter((fact) => proof.id === "p.markers"
        ? fact.id === "host.web-surface"
        : anchor !== undefined && fact.statement.startsWith(anchor));
      assert.equal(matches.length, 1, `T21 clinic anchor must select one generated fact: ${proof.id}`);
      return { ...proof, evidence: matches[0]!.evidence };
    }),
  };
}
