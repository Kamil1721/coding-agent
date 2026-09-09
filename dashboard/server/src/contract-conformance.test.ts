import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CreativeContractV1 } from "./creative-contract.js";
import { canonicalJson } from "./creative-contract.js";
import { CONFORMANCE_ISSUE_CODES, CONFORMANCE_ISSUE_SEVERITIES, compareContractConformance, contractMarkerBindings, hasRawLegacyMarkerConflict } from "./contract-conformance.js";
import { CONTRACT_CONFORMANCE_FILE, writeContractConformanceArtifact } from "./contract-conformance-artifact.js";

const fixture = new URL("../src/fixtures/contract-conformance/", import.meta.url);
const html = readFileSync(new URL("study/index.html", fixture), "utf8");
const contract = JSON.parse(readFileSync(new URL("study/creative-contract.json", fixture), "utf8")) as CreativeContractV1;
const conforming = readFileSync(new URL("conforming.html", fixture), "utf8");
function heroContract(headline = "Hero", eyebrow: string | null = null): CreativeContractV1 {
  const hero = contract.sections[0];
  assert.ok(hero);
  return { ...contract, sections: [{ ...hero, headline, eyebrow }], routes: [{ id: "home", path: "/", sectionIds: ["hero"] }], motion: [] };
}

test("study eyebrow count observes HTML instead of reading contract twice", () => {
  const issue = compareContractConformance(html, contract).find((item) => item.code === "contract_eyebrow_count");
  assert.deepEqual(issue && { expected: issue.expected, observed: issue.observed }, { expected: 1, observed: 3 },
    "AC4_CONTRACT_VS_HTML: study must report contract 1 versus observed 3 eyebrows");
});

test("study artifacts expose missing unknown and copy divergences with exact values", () => {
  const issues = compareContractConformance(html, contract);
  assert.ok(issues.some((issue) => issue.code === "contract_section_missing" && issue.sectionId === "positioning"), "STUDY_MISSING_POSITIONING");
  assert.ok(issues.some((issue) => issue.code === "contract_section_unknown" && issue.sectionId === "s.standard"), "STUDY_UNKNOWN_STANDARD");
  assert.ok(issues.some((issue) => issue.code === "contract_eyebrow_text" && issue.expected === "Engagements" && String(issue.observed).includes("Services")), "STUDY_EYEBROW_TEXT");
  assert.ok(issues.some((issue) => issue.code === "contract_headline_text" && issue.sectionId === "hero" && issue.observed === "Websites and apps, designed and built by Kamil Borzecki"), "STUDY_HERO_HEADLINE");
  for (const issue of issues) {
    assert.ok(CONFORMANCE_ISSUE_CODES.includes(issue.code));
    assert.ok(CONFORMANCE_ISSUE_SEVERITIES.includes(issue.severity));
    assert.equal(issue.severity, "warning");
    assert.ok(issue.detail.includes(`expected ${JSON.stringify(issue.expected)}`));
    assert.ok(issue.detail.includes(`observed ${JSON.stringify(issue.observed)}`));
  }
});

test("conforming page derived from study returns no findings", () => {
  assert.deepEqual(compareContractConformance(conforming, contract), [], "AC4_CONFORMING_EMPTY: edited real page must be able to pass");
});

test("deleting a contract section leaves an unknown HTML section", () => {
  const changed = { ...contract, sections: contract.sections.filter((section) => section.id !== "work") };
  const issues = compareContractConformance(conforming, changed);
  assert.ok(issues.some((issue) => issue.code === "contract_section_unknown" && issue.sectionId === "s.work"),
    "AC4_TWO_DIRECTIONAL: deleting contract work must expose unchanged HTML s.work");
});

test("section comparison strips exactly one leading namespace prefix", () => {
  assert.deepEqual(compareContractConformance("<section data-creative-section='s.hero'><h1>Hero</h1></section>", heroContract()), []);
  const issues = compareContractConformance("<section data-creative-section='s.s.hero'><h1>Hero</h1></section>", heroContract());
  assert.ok(issues.some((issue) => issue.code === "contract_section_missing" && issue.sectionId === "hero"), "SINGLE_PREFIX_ONLY: s.s.hero must not match hero");
  assert.ok(issues.some((issue) => issue.code === "contract_section_unknown" && issue.sectionId === "s.s.hero"));
});

test("nested section headings cannot satisfy the parent headline", () => {
  const issues = compareContractConformance('<header data-creative-section="hero"><nav data-creative-section="nav"><h2>Hero</h2></nav><h1>Wrong</h1></header>', heroContract());
  assert.ok(issues.some((issue) => issue.code === "contract_headline_text" && issue.sectionId === "hero" && issue.observed === "Wrong"),
    "SECTION_OWNERSHIP: nested nav heading cannot satisfy hero");
});

test("tokenizer excludes inert markup and accepts quoted greater-than and entities", () => {
  const page = `<!-- <section data-creative-section="fake"><h1>Fake</h1></section> -->
    <script>const fake = '<section data-creative-section="fake">';</script>
    <style>.x::before { content: '<h1>Fake</h1>' }</style>
    <template><section data-creative-section="fake"><p>Label</p><h1>Fake</h1></section></template>
    <section data-creative-section="hero" title="a > b">
      <div hidden><p>Hidden</p><h1>Hidden</h1></div>
      <div aria-hidden="true">Decorative but visible text</div>
      <p>Design &amp; build</p><!-- comment --><h1>Hello <span>world</span><br> &lt; &#x41; &#66;</h1>
    </section>`;
  assert.deepEqual(compareContractConformance(page, heroContract("Hello world < A B", "Design & build")), [],
    "STATIC_TOKENIZER: inert content excluded, quoted > and encoded text parsed");
});

test("eyebrow observation uses position without class or word-count rules", () => {
  const page = '<section data-creative-section=hero><p class="arbitrary">An arbitrarily long paragraph serving as the label directly before this heading</p><h1>Hero</h1><p class="meta">Body</p></section>';
  const issues = compareContractConformance(page, heroContract());
  assert.deepEqual(issues.map((issue) => [issue.code, issue.expected, issue.observed]), [["contract_eyebrow_count", 0, 1]]);
});

test("legacy binding walk tolerates malformed lists and preserves exact raw syntax", () => {
  const bindings = contractMarkerBindings({ routes: [{ id: "home" }, null, [], { id: 1 }], sections: ["bad", { id: "hero" }, { id: "" }], motion: false });
  assert.deepEqual(bindings, [["data-creative-route", "home"], ["data-creative-section", "hero"], ["data-creative-section", ""]]);
  assert.deepEqual(contractMarkerBindings(null), []);
  const expected = contractMarkerBindings({ sections: [{ id: "hero" }] });
  assert.equal(hasRawLegacyMarkerConflict("data-creative-section='hero'", expected), false);
  assert.equal(hasRawLegacyMarkerConflict('data-creative-section="hero"', expected), false);
  assert.equal(hasRawLegacyMarkerConflict('data-creative-section="s.hero"', expected), true);
  assert.equal(hasRawLegacyMarkerConflict('data-creative-route="home" data-creative-section = "hero"', expected), true);
  assert.equal(hasRawLegacyMarkerConflict('data-creative-route="home" data-creative-section=hero', expected), true);
  assert.equal(hasRawLegacyMarkerConflict('no markers', expected), false);
  assert.equal(hasRawLegacyMarkerConflict('<!-- data-creative-section="hero" -->', expected), false);
});

test("artifact writer persists reproducible warning observations in isolated results", () => {
  const root = mkdtempSync(join(tmpdir(), "contract-conformance-"));
  try {
    const results = join(root, "results");
    const record = writeContractConformanceArtifact(results, html, contract);
    assert.deepEqual(JSON.parse(readFileSync(join(results, CONTRACT_CONFORMANCE_FILE), "utf8")), record);
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    assert.equal(record.htmlSha256, hash(html));
    assert.equal(record.contractCanonicalSha256, hash(canonicalJson(contract)));
    assert.deepEqual(record.issues, compareContractConformance(html, contract));
    assert.deepEqual(readdirSync(results), [CONTRACT_CONFORMANCE_FILE]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("meaningful text between paragraph and heading prevents eyebrow adjacency", () => {
  const page = '<section data-creative-section="hero"><p>Label</p>Intervening text<h1>Hero</h1></section>';
  assert.deepEqual(compareContractConformance(page, heroContract()), [],
    "EYEBROW_TEXT_BOUNDARY: meaningful sibling text must break paragraph adjacency");
});

test("HTML entity aliases decode once while contract text remains literal", () => {
  const page = '<section data-creative-section="hero"><h1>A &AMP; B &amp;amp; &NbSp;</h1></section>';
  assert.deepEqual(compareContractConformance(page, heroContract("A & B &amp; &NbSp;")), [],
    "ENTITY_TEXT_BOUNDARY: HTML aliases decode but JSON contract is literal text");
});

test("hidden markers remain structural and aria-hidden text remains observable", () => {
  const page = '<section hidden data-creative-section="hero"><h1>Hero</h1></section>';
  const issues = compareContractConformance(page, heroContract());
  assert.deepEqual(issues.map((issue) => issue.code), ["contract_headline_text"],
    "HIDDEN_MARKER: hidden section exists even though it supplies no heading text");
  assert.deepEqual(compareContractConformance('<section data-creative-section="hero"><h1 aria-hidden="true">Hero</h1></section>', heroContract()), [],
    "ARIA_HIDDEN_TEXT: aria-hidden does not imply visual absence");
});

/**
 * A navigation bar and a footer carry a contract `headline` that is a brand string rendered as a
 * link or a logo, not an `h*`. Before the exemption every page with a nav and a footer reported
 * two spurious `contract_headline_text` issues, measured on the T28 continuation fixture.
 */
test("navigation and footer headlines match section text, and a wrong brand still reports", () => {
  const contract = {
    sections: [
      { id: "nav", kind: "navigation", headline: "Kamil Borzecki", eyebrow: null },
      { id: "footer", kind: "footer", headline: "Kamil Borzecki", eyebrow: null },
      { id: "hero", kind: "hero", headline: "Websites and apps", eyebrow: null },
    ],
  } as unknown as Parameters<typeof compareContractConformance>[1];

  const clean = compareContractConformance(
    `<nav data-creative-section="s.nav"><a>Kamil Borzecki</a></nav>` +
    `<section data-creative-section="s.hero"><h1>Websites and apps</h1></section>` +
    `<footer data-creative-section="s.footer"><p>Kamil Borzecki</p></footer>`,
    contract,
  );
  assert.deepEqual(
    clean.filter((issue) => issue.code === "contract_headline_text").map((issue) => issue.sectionId),
    [],
    "AC_NAV_FOOTER_NOT_SPURIOUS: a brand string outside a heading must not report",
  );

  // NEGATIVE CONTROL: the exemption must not become a blanket skip of nav and footer.
  const wrong = compareContractConformance(
    `<nav data-creative-section="s.nav"><a>Some Other Studio</a></nav>` +
    `<section data-creative-section="s.hero"><h1>Websites and apps</h1></section>` +
    `<footer data-creative-section="s.footer"><p>Kamil Borzecki</p></footer>`,
    contract,
  );
  assert.deepEqual(
    wrong.filter((issue) => issue.code === "contract_headline_text").map((issue) => issue.sectionId),
    ["nav"],
    "AC_NAV_FOOTER_STILL_CHECKED: a wrong brand string in a nav must still report",
  );

  // NEGATIVE CONTROL: an ordinary section still requires a real heading.
  const noHeading = compareContractConformance(
    `<nav data-creative-section="s.nav"><a>Kamil Borzecki</a></nav>` +
    `<section data-creative-section="s.hero"><p>Websites and apps</p></section>` +
    `<footer data-creative-section="s.footer"><p>Kamil Borzecki</p></footer>`,
    contract,
  );
  assert.deepEqual(
    noHeading.filter((issue) => issue.code === "contract_headline_text").map((issue) => issue.sectionId),
    ["hero"],
    "AC_ORDINARY_SECTION_NEEDS_HEADING: text alone must not satisfy a non-exempt section",
  );
});
