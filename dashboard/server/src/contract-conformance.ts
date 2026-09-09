/** Static contract/HTML observation, independent of rendering and filesystem access.
 * Section comparison removes exactly ONE leading `s.` from either section ID.
 * Legacy recovery deliberately uses raw IDs and exact quoted substrings instead.
 * An eyebrow-position label is a paragraph immediately before the first owned
 * h1–h6 heading in the same parent (whitespace/comments do not intervene).
 * Nested marked sections own their own text. Comments, script/style contents,
 * templates and explicitly hidden subtrees supply no observed text. Hidden
 * elements still carry section markers; aria-hidden alone does not hide text.
 * This is a tokenizer for authored static HTML, not browser tree repair, CSS
 * visibility, JavaScript execution, or an inference about visual typography.
 */
import type { CreativeContractV1 } from "./creative-contract.js";

export const CONFORMANCE_ISSUE_CODES = [
  "contract_section_missing", "contract_section_unknown", "contract_eyebrow_count",
  "contract_eyebrow_text", "contract_headline_text",
] as const;
export type ConformanceIssueCode = (typeof CONFORMANCE_ISSUE_CODES)[number];
export const CONFORMANCE_ISSUE_SEVERITIES = ["blocking", "warning"] as const;
export type ConformanceIssueSeverity = (typeof CONFORMANCE_ISSUE_SEVERITIES)[number];
export interface ConformanceIssue {
  readonly code: ConformanceIssueCode;
  readonly severity: ConformanceIssueSeverity;
  readonly sectionId: string | null;
  readonly expected: string | number;
  readonly observed: string | number;
  readonly detail: string;
}

type MarkerAttribute = "data-creative-route" | "data-creative-section" | "data-motion-id";
export type ContractMarkerBinding = readonly [attribute: MarkerAttribute, id: string];

/** Tolerant walk inherited from recovery: malformed containers/items are ignored. */
export function contractMarkerBindings(contract: unknown): readonly ContractMarkerBinding[] {
  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) return [];
  const record = contract as Record<string, unknown>;
  const attributes = [
    ["routes", "data-creative-route"], ["sections", "data-creative-section"], ["motion", "data-motion-id"],
  ] as const;
  return attributes.flatMap(([key, attribute]) => {
    const values = record[key];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value): ContractMarkerBinding[] => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const id = (value as Record<string, unknown>)["id"];
      return typeof id === "string" ? [[attribute, id]] : [];
    });
  });
}

/** Exact legacy semantics: no HTML parsing, namespace/whitespace normalization or unescaping. */
export function hasRawLegacyMarkerConflict(text: string, bindings: readonly ContractMarkerBinding[]): boolean {
  const hasAnyMarker = /data-(?:creative-(?:route|section)|motion-id)=["'][^"']+["']/u.test(text);
  return hasAnyMarker && bindings.some(([attribute, id]) =>
    !text.includes(`${attribute}="${id}"`) && !text.includes(`${attribute}='${id}'`));
}

interface Element {
  readonly tag: string;
  readonly parent: Element | null;
  readonly children: Element[];
  readonly sectionId: string | null;
  readonly hidden: boolean;
  readonly inert: boolean;
  readonly precedingElement: Element | null;
  trailingText: boolean;
  text: string;
}
interface ObservedSection {
  readonly id: string;
  readonly text: string;
  readonly headings: readonly string[];
  readonly eyebrows: readonly string[];
}
/**
 * Section kinds whose contract `headline` is a brand string in ordinary text rather than a
 * heading element. Their headline is compared against the section's full text.
 */
const HEADLINE_MATCHES_SECTION_TEXT: ReadonlySet<string> = new Set(["navigation", "footer"]);

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HEADING = /^h[1-6]$/u;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", AMP: "&", LT: "<", GT: ">", QUOT: '"' };
function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole: string, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? whole;
    const point = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\ufffd";
  });
}
function normalizedText(text: string): string { return decode(text).replace(/\s+/gu, " ").trim(); }
function normalizedContractText(text: string): string { return text.replace(/\s+/gu, " ").trim(); }
function normalizedSectionId(id: string): string { return id.startsWith("s.") ? id.slice(2) : id; }
function attributes(token: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const body = token.replace(/^<[^\s/>]+/u, "").replace(/\/?\s*>$/u, "");
  for (const match of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    const key = (match[1] ?? "").toLowerCase();
    if (!result.has(key)) result.set(key, decode(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return result;
}

function observedSections(html: string): readonly ObservedSection[] {
  const root: Element = { tag: "#root", parent: null, children: [], sectionId: null, hidden: false, inert: false, precedingElement: null, trailingText: false, text: "" };
  const stack = [root];
  const elements: Element[] = [];
  // Raw-text elements must be removed before tokenizing their non-HTML contents.
  const source = html.replace(/<!--[\s\S]*?-->|<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/giu, "");
  const append = (text: string): void => {
    const current = stack.at(-1);
    if (current !== undefined && normalizedText(text).length > 0) current.trailingText = true;
    if (current?.hidden) return;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const node = stack[index];
      if (node === undefined) continue;
      node.text += text;
      if (node.sectionId !== null) break;
    }
  };
  for (const match of source.matchAll(/<![^>]*>|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</giu)) {
    const token = match[0];
    if (token.startsWith("<!")) continue;
    if (!token.startsWith("<")) { append(token); continue; }
    const tag = /^<\/?([a-z][\w:-]*)/iu.exec(token)?.[1]?.toLowerCase();
    if (tag === undefined) { append(token); continue; }
    if (token.startsWith("</")) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const parent = stack.at(-1) ?? root;
    const attrs = attributes(token);
    const element: Element = {
      tag, parent, children: [], sectionId: attrs.get("data-creative-section") ?? null,
      hidden: parent.hidden || tag === "template" || attrs.has("hidden"),
      inert: parent.inert || tag === "template",
      precedingElement: parent.trailingText ? null : parent.children.at(-1) ?? null,
      trailingText: false, text: "",
    };
    parent.trailingText = false;
    parent.children.push(element);
    elements.push(element);
    if (tag === "br") append(" ");
    if (!VOID_TAGS.has(tag) && !token.endsWith("/>")) stack.push(element);
  }
  const owner = (node: Element): Element | null => {
    let current: Element | null = node;
    while (current !== null && current.sectionId === null) current = current.parent;
    return current;
  };
  return elements.filter((node) => node.sectionId !== null && !node.inert).map((section) => {
    const headings = elements.filter((node) => !node.hidden && HEADING.test(node.tag) && owner(node) === section);
    const firstHeading = headings[0];
    const previous = firstHeading?.precedingElement;
    const eyebrows = previous?.tag === "p" && !previous.hidden && owner(previous) === section
      ? [normalizedText(previous.text)] : [];
    return { id: section.sectionId ?? "", text: normalizedText(section.text), headings: headings.map((node) => normalizedText(node.text)), eyebrows };
  });
}

export function compareContractConformance(html: string, contract: CreativeContractV1): readonly ConformanceIssue[] {
  const observed = observedSections(html);
  const expectedIds = contractMarkerBindings(contract).filter(([attribute]) => attribute === "data-creative-section").map(([, id]) => id);
  const issues: ConformanceIssue[] = [];
  const report = (code: ConformanceIssueCode, sectionId: string | null, expected: string | number, actual: string | number): void => {
    issues.push({ code, severity: "warning", sectionId, expected, observed: actual,
      detail: `${sectionId === null ? "Page" : `Section ${JSON.stringify(sectionId)}`}: expected ${JSON.stringify(expected)}; observed ${JSON.stringify(actual)}` });
  };
  for (const id of expectedIds) {
    if (!observed.some((section) => normalizedSectionId(section.id) === normalizedSectionId(id))) {
      report("contract_section_missing", id, id, "absent");
    }
  }
  for (const section of observed) {
    if (!expectedIds.some((id) => normalizedSectionId(id) === normalizedSectionId(section.id))) {
      report("contract_section_unknown", section.id, expectedIds.join(", "), section.id);
    }
  }
  const expectedEyebrows = contract.sections.filter((section) => section.eyebrow !== null).length;
  const observedEyebrows = observed.reduce((count, section) => count + section.eyebrows.length, 0);
  if (expectedEyebrows !== observedEyebrows) report("contract_eyebrow_count", null, expectedEyebrows, observedEyebrows);
  for (const section of contract.sections) {
    const matches = observed.filter((item) => normalizedSectionId(item.id) === normalizedSectionId(section.id));
    if (matches.length === 0) continue;
    if (section.eyebrow !== null && !matches.some((item) => item.text.includes(normalizedContractText(section.eyebrow ?? "")))) {
      report("contract_eyebrow_text", section.id, section.eyebrow, matches.map((item) => item.text).join(" | "));
    }
    // A navigation bar and a footer carry a contract `headline` that is a brand string, rendered
    // as a link or a logo rather than an `h*`. Matching those against headings alone reported a
    // false positive on every page with a nav and a footer, measured on the T28 continuation
    // fixture: `s.nav` expected "Sections" and `s.footer` expected "Kamil Borzecki", both against
    // an empty heading list. Compare their full section text instead, exactly as the eyebrow
    // check above already does, so a genuinely wrong brand string still reports.
    const headlineHaystack = HEADLINE_MATCHES_SECTION_TEXT.has(section.kind)
      ? matches.map((item) => item.text)
      : matches.flatMap((item) => item.headings);
    if (!headlineHaystack.some((candidate) => candidate.includes(normalizedContractText(section.headline)))) {
      report("contract_headline_text", section.id, section.headline, headlineHaystack.join(" | "));
    }
  }
  return issues;
}
