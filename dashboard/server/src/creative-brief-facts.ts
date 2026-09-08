import type { CreativeAuthorFactKind } from "./creative-contract-author.js";

/** Split prose and numbered/list lines without treating list numbers as sentences. */
export function briefFactSentences(prose: string): readonly string[] {
  return prose.split(/\r?\n/u).flatMap((line) =>
    line.replace(/^\s*(?:\d+[.)]|[-*])\s+/u, "").trim()
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/u)
      .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
      .filter(Boolean));
}

/** Product transitions remain goals even when the owner describes them with “must”. */
export function briefFactKind(sentence: string): CreativeAuthorFactKind {
  if (/\b(?:accessibility|keyboard|focus|semantic (?:form )?controls|associated labels|contrast|screen reader|aria[- ])\b/iu.test(sentence)) return "accessibility";
  if (/\b(?:layout|375px|desktop widths|horizontal scroll(?:ing)?|clipped controls|resizing|viewport|keep all data local|local and deterministic|deterministic|external APIs?|authentication|databases?)\b/iu.test(sentence)) return "constraint";
  if (/\b(?:run instructions|fresh start|static app|local web server|data markers|technical requirements?)\b/iu.test(sentence)) return "technical_constraint";
  if (/^(?:do not|don't|avoid|never)\b/iu.test(sentence)) return "avoid";
  return "goal";
}
