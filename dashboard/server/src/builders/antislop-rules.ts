/**
 * builders/antislop-rules.ts — Phase 2a, the lexical craft floor as pure
 * functions. No SDK types, no filesystem, no hook. `antislop-hook.ts` is where
 * these reach the engine.
 *
 * WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT. Layer 1 is a CRAFT GATE. It is
 * not a security boundary and nothing here is load-bearing for `heldOutPass`.
 * The sealed-suite boundary is `managedSettings.permissions.deny` at the policy
 * tier plus the delegation `PreToolUse` slot, and this file touches neither.
 * That framing decides the whole design: a craft gate MUST NOT be able to wedge
 * the builder, so it abstains wherever it cannot be exact, and the hook that
 * carries it escalates rather than looping (see `antislop-hook.ts`).
 *
 * WHERE EVERY RULE COMES FROM, CITED SEPARATELY AND NEVER MERGED:
 *
 *   craft-floor       `~/.claude/skills/impeccable/reference/craft-floor.md` —
 *                     the globally installed `impeccable` skill, which the
 *                     design spec §6.3 names authoritative. IT IS NOT VENDORED
 *                     IN THIS REPO: `impeccable/reference/craft-floor.md` does
 *                     not exist here, verified by `find` and a repo-wide grep.
 *                     It owns gradient text, the coloured side border, the
 *                     tracking floor and the eyebrow.
 *   spec §8 Layer 1   `docs/superpowers/specs/2026-07-28-orchestration-canvas-
 *                     design.md` — owns the placeholder-media list (`picsum`,
 *                     `placehold.co`, `unsplash.com/random`, lorem ipsum), the
 *                     purple→pink gradient and the Inter-and-slate default.
 *   spec §8 Layer 2   owns the three motion satisfiers and the failing case.
 *
 * `visual-criteria.ts` encodes overlapping material as GRADING criteria. It is
 * read and NOT imported: grading reports after the fact and may be vague, a hook
 * stops a write and must be exact. Where both speak, the citation above is the
 * source rather than that file.
 *
 * ANCHOR TO SHAPE, NEVER TO A SUBSTRING. A previous rule in this codebase
 * matched the English word "fit" and CSS `object-fit` because it was unanchored.
 * Every rule below anchors to a URL AUTHORITY, a CSS DECLARATION, a computed
 * HUE BAND, or a co-occurring PAIR inside one declaration block — never to a
 * bare word in a stream of text.
 */

/** Which document owns a rule. Kept as literal strings so a denial can cite it. */
export type AntiSlopSource = "craft-floor.md" | "spec §8 Layer 1" | "spec §8 Layer 2";

export interface AntiSlopRule {
  readonly id: string;
  readonly source: AntiSlopSource;
  /**
   * What the model is told, verbatim. A `PreToolUse` deny delivers
   * `permissionDecisionReason` as an `is_error` tool_result, so this is MODEL
   * INPUT and not an internal code: it names the rule, says what is wrong, and
   * says what to do instead. A reason a builder cannot act on turns a craft gate
   * into a mysterious build failure — the exact trap this phase was warned about.
   */
  readonly reason: string;
  /** Every violating span, in order. Empty means clean. */
  readonly find: (text: string) => readonly string[];
}

export interface SlopFinding {
  readonly ruleId: string;
  readonly source: AntiSlopSource;
  readonly reason: string;
  /** The literal text that matched, for the denial and for the corpus report. */
  readonly evidence: string;
}

/* ────────────────────────────── shared parsing ────────────────────────────── */

/**
 * The artefact surface, and the reason Layer 1 is scoped to it.
 *
 * A `.md` or `.txt` that DISCUSSES placeholder media is prose about pages, not a
 * page. Scoping matters more than it looks: the denial reasons below quote the
 * banned literals, so an unscoped rule would deny the model writing down why it
 * was denied — and this plan, this file and `visual-criteria.ts` would all be
 * unwritable by the system that enforces them.
 */
const ARTEFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
]);

export function isArtefactPath(filePath: string): boolean {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return ARTEFACT_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/**
 * The bodies of CSS declaration blocks — the text between `{` and the next `}`.
 *
 * PAIR RULES NEED A SCOPE OR THEY ARE CO-OCCURRENCE RULES. `background-clip:
 * text` in one selector and `color: transparent` in an unrelated one is two
 * ordinary declarations; only together in ONE block are they gradient text.
 * Deliberately not a CSS parser: a hook that needs a parser to decide is a hook
 * that will disagree with the parser one day and deny a legitimate write.
 */
function cssBlocks(text: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (ch === "}") {
      if (depth === 1 && start >= 0) out.push(text.slice(start, i));
      depth = Math.max(0, depth - 1);
    }
  }
  if (depth > 0 && start >= 0) out.push(text.slice(start));
  return out;
}

/**
 * Quoted runs — a `class`/`className` attribute, a `clsx()` argument, a template
 * literal of utilities. The Tailwind equivalent of a declaration block, and the
 * same argument applies: a pair rule needs a scope.
 */
function quotedRuns(text: string): readonly string[] {
  const out: string[] = [];
  const re = /"([^"\n]{0,600})"|'([^'\n]{0,600})'|`([^`]{0,600})`/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Trim a matched span so a denial reason and a report line stay readable. */
function clip(span: string): string {
  const flat = span.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/* ─────────────────────────────── colour maths ─────────────────────────────── */

interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

const NAMED_COLOURS: Readonly<Record<string, string>> = {
  purple: "#800080",
  rebeccapurple: "#663399",
  blueviolet: "#8a2be2",
  darkviolet: "#9400d3",
  darkorchid: "#9932cc",
  mediumpurple: "#9370db",
  violet: "#ee82ee",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  orchid: "#da70d6",
  hotpink: "#ff69b4",
  deeppink: "#ff1493",
  pink: "#ffc0cb",
  lightpink: "#ffb6c1",
  palevioletred: "#db7093",
};

function hexToHsl(hex: string): Hsl | null {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: (max + min) / 2 };
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta + 6) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return { h: hue, s: delta / max, l: (max + min) / 2 };
}

/**
 * Every colour literal inside one gradient's argument list, as HSL.
 *
 * Greys and near-blacks are dropped: their hue is an artefact of rounding, and a
 * `#111 → #ec4899` gradient must not be classified by a hue nobody chose.
 */
function gradientStopHues(args: string): readonly number[] {
  const hues: number[] = [];
  const push = (hsl: Hsl | null): void => {
    if (hsl === null) return;
    if (hsl.s < 0.3 || hsl.l < 0.12 || hsl.l > 0.94) return;
    hues.push(hsl.h);
  };
  for (const m of args.matchAll(/#[0-9a-f]{3,8}\b/gi)) push(hexToHsl(m[0]));
  for (const m of args.matchAll(/\bhsla?\(\s*(-?[\d.]+)(deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/gi)) {
    const h = ((Number(m[1] ?? "0") % 360) + 360) % 360;
    push({ h, s: Number(m[3] ?? "0") / 100, l: Number(m[4] ?? "0") / 100 });
  }
  for (const [name, hex] of Object.entries(NAMED_COLOURS)) {
    if (new RegExp(`(?:^|[\\s,(])${name}(?=[\\s,)]|$)`, "i").test(args)) push(hexToHsl(hex));
  }
  return hues;
}

/**
 * The two bands, taken from the literals the rule is aimed at rather than from
 * taste: Tailwind `violet-500` #8b5cf6 is hue 258 and `purple-500` #a855f7 is
 * 271, both PURPLE; `pink-500` #ec4899 is 330 and `deeppink` is 328, both PINK.
 * `fuchsia-500` #d946ef lands at 292 and is therefore counted purple — which is
 * why the Tailwind half below pairs a purple-family `from-` with a pink-family
 * `to-` by NAME instead of re-deriving it.
 */
const PURPLE_BAND = (h: number): boolean => h >= 250 && h < 305;
const PINK_BAND = (h: number): boolean => h >= 305 && h <= 350;

/** Balanced-paren extraction — a gradient's args contain `rgb(...)` commas. */
function gradientCalls(text: string): readonly string[] {
  const out: string[] = [];
  const re = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
    }
    out.push(text.slice(start, Math.max(start, i - 1)));
  }
  return out;
}

/* ──────────────────────────────── the rules ──────────────────────────────── */

/**
 * Placeholder media, anchored to the URL AUTHORITY rather than to the host as a
 * substring.
 *
 * THE NEAR-MISS THIS PROTECTS IS REAL AND COMMON:
 * `https://images.unsplash.com/photo-1518791841217` is a CHOSEN photograph and
 * must be allowed; `https://source.unsplash.com/random/800x600` is the
 * placeholder generator and must not. Matching "unsplash" would have failed both
 * the same way.
 */
const PLACEHOLDER_IMAGE: AntiSlopRule = {
  id: "AS-PLACEHOLDER-IMAGE",
  source: "spec §8 Layer 1",
  reason:
    "Placeholder image services are not shippable content. Use a real asset committed to the " +
    "workspace, or a design still from `design-refs/`. If no image exists yet, write the section " +
    "without one rather than reserving space with a generated rectangle. (A specific chosen " +
    "photograph, e.g. an `images.unsplash.com/photo-...` URL, is fine — it is the random/dimension " +
    "generators that are not.)",
  find: (text) => {
    const hits: string[] = [];
    const hosts = /(?:^|[\s"'`(=,:])(?:https?:)?\/\/(?:[a-z0-9-]+\.)*(?:picsum\.photos|placehold\.co)(?=[/"'`)\s,;]|$)/gi;
    for (const m of text.matchAll(hosts)) hits.push(clip(m[0]));
    const random = /(?:^|[\s"'`(=,:])(?:https?:)?\/\/(?:[a-z0-9-]+\.)*unsplash\.com\/random\b/gi;
    for (const m of text.matchAll(random)) hits.push(clip(m[0]));
    return hits;
  },
};

/**
 * Lorem ipsum, anchored to the two words ADJACENT. `loremIpsum` as an
 * identifier does not match and that is deliberate: the rule is about shipped
 * copy, and a symbol name is not copy.
 */
const LOREM_IPSUM: AntiSlopRule = {
  id: "AS-LOREM-IPSUM",
  source: "spec §8 Layer 1",
  reason:
    "Filler latin is not copy. Write the product's own language: a control names its action, an " +
    "error names the problem and the recovery, and a paragraph says the thing the section is for. " +
    "If the copy is genuinely unknown, ship a shorter section rather than filler.",
  find: (text) => {
    const hits: string[] = [];
    for (const m of text.matchAll(/\blorem\s+ipsum\b/gi)) hits.push(clip(m[0]));
    for (const m of text.matchAll(/\bdolor\s+sit\s+amet\b/gi)) hits.push(clip(m[0]));
    return hits;
  },
};

/**
 * The purple→pink gradient, decided by COMPUTED HUE rather than by a palette of
 * banned hex strings — a hex list is the READ_TOOLS mistake in colour: open to
 * every shade nobody enumerated. Blue→teal and orange→red allow, because their
 * stops land in neither band.
 */
const PURPLE_PINK_GRADIENT: AntiSlopRule = {
  id: "AS-PURPLE-PINK-GRADIENT",
  source: "spec §8 Layer 1",
  reason:
    "A violet-to-pink gradient is the category's house style, not a decision. Pick the palette from " +
    "the locked design still (or from the subject), and get emphasis from weight, size and " +
    "figure-to-ground rather than from a two-stop ramp.",
  find: (text) => {
    const hits: string[] = [];
    for (const args of gradientCalls(text)) {
      const hues = gradientStopHues(args);
      if (hues.some(PURPLE_BAND) && hues.some(PINK_BAND)) hits.push(clip(args));
    }
    const from = /\bfrom-(violet|purple|indigo)-\d{2,3}\b/gi;
    for (const m of text.matchAll(from)) {
      const window = text.slice(m.index, m.index + 140);
      const to = /\bto-(pink|fuchsia|rose)-\d{2,3}\b/i.exec(window);
      if (to !== null) hits.push(clip(`${m[0]} ... ${to[0]}`));
    }
    return hits;
  },
};

/**
 * Gradient text, as the PAIR and only as the pair — craft-floor: "Gradient text.
 * Emphasis comes from weight or size."
 *
 * Either half alone is ordinary: `background-clip: padding-box` is a background
 * decision, and `text-transparent` alone is how a skeleton or an icon-only
 * button hides a label. Both in ONE declaration block, or both in ONE class run,
 * is the technique.
 */
const GRADIENT_TEXT: AntiSlopRule = {
  id: "AS-GRADIENT-TEXT",
  source: "craft-floor.md",
  reason:
    "Gradient text is banned by the craft floor: emphasis comes from weight or size. Delete the " +
    "`background-clip: text` / transparent-fill pair and make the headline carry itself — a heavier " +
    "cut, a larger step, or more space around it.",
  find: (text) => {
    const hits: string[] = [];
    const clipText = /(?:-webkit-)?background-clip\s*:\s*text/i;
    const fill = /-webkit-text-fill-color\s*:\s*transparent/i;
    const colourTransparent = /(?:^|[;{\s])color\s*:\s*transparent/i;
    for (const block of cssBlocks(text)) {
      if (clipText.test(block) && (fill.test(block) || colourTransparent.test(block))) {
        hits.push(clip(block));
      }
    }
    for (const run of quotedRuns(text)) {
      if (/\bbg-clip-text\b/.test(run) && /\btext-transparent\b/.test(run)) hits.push(clip(run));
    }
    return hits;
  },
};

/** A length in px, for comparison only. `em`/`rem` assume the 16px root. */
function lengthPx(value: string, unit: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (unit === "px") return n;
  if (unit === "em" || unit === "rem") return n * 16;
  return 0;
}

/**
 * craft-floor: "A colored `border-left` or `border-right` above 1px on cards,
 * list items, callouts, or alerts."
 *
 * THREE ABSTENTIONS ARE DELIBERATE. `border-top`/`border-bottom` are not named
 * by the floor and are not judged. A 1px rule is AT the floor, not above it.
 * `transparent` and `currentColor` are layout reservations and focus
 * affordances, not colour.
 */
const COLOURED_BORDER_SIDE: AntiSlopRule = {
  id: "AS-COLORED-BORDER-SIDE",
  source: "craft-floor.md",
  reason:
    "A coloured left/right border above 1px is the callout cliche the craft floor refuses. Carry the " +
    "distinction with the surface, the type or the spacing instead — or hold the rule at 1px if a " +
    "divider is genuinely what the element needs.",
  find: (text) => {
    const hits: string[] = [];
    const decl = /border-(?:left|right|inline-start|inline-end)\s*:\s*([^;}]{1,160})/gi;
    for (const m of text.matchAll(decl)) {
      const value = m[1] ?? "";
      const len = /(-?\d*\.?\d+)\s*(px|rem|em)\b/i.exec(value);
      if (len === null) continue;
      if (lengthPx(len[1] ?? "0", (len[2] ?? "px").toLowerCase()) <= 1) continue;
      const named = Object.keys(NAMED_COLOURS).join("|");
      const coloured =
        /#[0-9a-f]{3,8}\b/i.test(value) ||
        /\b(?:rgba?|hsla?|color-mix|oklch|lab)\s*\(/i.test(value) ||
        new RegExp(`\\b(?:${named}|red|blue|green|orange|yellow|teal|cyan|black|white|gray|grey)\\b`, "i").test(value) ||
        /\bvar\(\s*--[a-z0-9-]*(?:colou?r|accent|brand|ink|primary)/i.test(value);
      if (!coloured) continue;
      if (/\b(?:transparent|currentcolor|inherit|unset|initial)\b/i.test(value)) continue;
      hits.push(clip(`border-…: ${value}`));
    }
    for (const run of quotedRuns(text)) {
      const side = /\bborder-([lr])-(\d{1,2})\b/.exec(run);
      if (side === null || Number(side[2] ?? "0") <= 1) continue;
      if (!/\bborder-(?!l-|r-|t-|b-|x-|y-|s-|e-)[a-z]+-\d{2,3}\b/.test(run)) continue;
      hits.push(clip(run));
    }
    return hits;
  },
};

/**
 * craft-floor's "tracking floor -0.04em".
 *
 * THE LEADING ZERO IS OPTIONAL IN CSS AND THAT IS NOT A DETAIL: correct-portfolio
 * writes `letter-spacing:-.03em`, so a rule spelt `-0\.0[4-9]` would have missed
 * the real values in the tree it is measured against. Abstains on `px` — tracking
 * in px is not comparable to a floor in em without a font size, and guessing one
 * is how a craft gate denies a legitimate write.
 */
const TIGHT_TRACKING: AntiSlopRule = {
  id: "AS-TIGHT-TRACKING",
  source: "craft-floor.md",
  reason:
    "The craft floor's tracking floor is -0.04em; this goes tighter. Tighten the display step by " +
    "choosing a cut that is drawn tight rather than by crushing the sidebearings — past -0.04em the " +
    "letterforms collide at large sizes and the line stops being readable at small ones.",
  find: (text) => {
    const hits: string[] = [];
    const decl = /letter-spacing\s*:\s*(-\s*(?:\d*\.)?\d+)\s*(em|rem)\b/gi;
    for (const m of text.matchAll(decl)) {
      if (Number((m[1] ?? "0").replace(/\s+/g, "")) < -0.0400001) hits.push(clip(m[0]));
    }
    const arbitrary = /\btracking-\[\s*(-(?:\d*\.)?\d+)(em|rem)\s*\]/gi;
    for (const m of text.matchAll(arbitrary)) {
      if (Number(m[1] ?? "0") < -0.0400001) hits.push(clip(m[0]));
    }
    // Tailwind's named rung: `tracking-tighter` IS -0.05em. `tracking-tight` is
    // -0.025em and allows — the near-miss is one character away.
    for (const m of text.matchAll(/\btracking-tighter\b/g)) hits.push(clip(m[0]));
    return hits;
  },
};

/**
 * craft-floor: "A tracked uppercase eyebrow over every section. One named kicker
 * is a system; an eyebrow everywhere is grammar you did not choose."
 *
 * THE THRESHOLD IS THE RULE. The floor bans the eyebrow as GRAMMAR, not as an
 * element, so one or two allow and the third is the violation. This is the only
 * rule here that counts, and it counts within a single written file because that
 * is all a write-time hook can see — a component library split across files can
 * still slip past it, which is stated rather than papered over.
 */
const EYEBROW_EVERYWHERE: AntiSlopRule = {
  id: "AS-EYEBROW-EVERYWHERE",
  source: "craft-floor.md",
  reason:
    "Three or more tracked uppercase eyebrows in one file is grammar rather than a decision — the " +
    "craft floor allows one named kicker as a system, not a label over every section. Keep the one " +
    "that carries information and delete the rest; let the heading do the work.",
  find: (text) => {
    const hits: string[] = [];
    for (const run of quotedRuns(text)) {
      if (/\buppercase\b/.test(run) && /\btracking-(?:wide|wider|widest)\b/.test(run)) {
        hits.push(clip(run));
      }
    }
    for (const block of cssBlocks(text)) {
      if (
        /text-transform\s*:\s*uppercase/i.test(block) &&
        /letter-spacing\s*:\s*(?!-)\s*(?:\d*\.)?\d+\s*(?:em|rem|px)/i.test(block)
      ) {
        hits.push(clip(block));
      }
    }
    return hits.length >= 3 ? hits : [];
  },
};

/** The Tailwind slate ramp, as hexes, plus the utility spelling. */
const SLATE_HEXES: readonly string[] = [
  "#f8fafc",
  "#f1f5f9",
  "#e2e8f0",
  "#cbd5e1",
  "#94a3b8",
  "#64748b",
  "#475569",
  "#334155",
  "#1e293b",
  "#0f172a",
  "#020617",
];

/** Is Inter the LEADING family? `Georgia, Inter` is not this rule's target. */
function interLeads(text: string): string | null {
  const lists: string[] = [];
  for (const m of text.matchAll(/font-family\s*:\s*([^;}]{1,200})/gi)) lists.push(m[1] ?? "");
  for (const m of text.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]{1,200})/gi)) {
    // The shorthand: `font: 16px/1.6 Inter, system-ui, sans-serif`. The family
    // list starts after the size/line-height token.
    const after = /\d[^\s]*\s+(.+)$/.exec((m[1] ?? "").trim());
    if (after !== null) lists.push(after[1] ?? "");
  }
  for (const m of text.matchAll(/--font(?:-sans|-family)?[a-z-]*\s*:\s*([^;}]{1,200})/gi)) lists.push(m[1] ?? "");
  for (const list of lists) {
    const first = (list.split(",")[0] ?? "").replace(/["']/g, "").trim();
    if (/^inter(\s+var|\s+tight)?$/i.test(first)) return clip(list);
  }
  return null;
}

/**
 * Does this file define a type scale of its own? Any ONE of these counts, and
 * the bar is deliberately low: the rule below only fires when a file reaches for
 * Inter AND slate AND shows no sign of having decided anything about type, so a
 * generous definition of "decided" is what keeps it off legitimate work.
 */
function hasCustomTypeScale(text: string): boolean {
  if (/font-size\s*:\s*clamp\s*\(/i.test(text)) return true;
  if (/\btext-\[\s*clamp\s*\(/i.test(text)) return true;
  if (/--(?:text|font-size|step)-[a-z0-9-]+\s*:/i.test(text)) return true;
  if (/\bfontSize\s*:\s*[{[]/.test(text)) return true;
  const sizes = new Set<string>();
  for (const m of text.matchAll(/font-size\s*:\s*([^;}]{1,40})/gi)) sizes.add((m[1] ?? "").trim().toLowerCase());
  return sizes.size >= 3;
}

/**
 * spec §8 Layer 1: "Inter+slate boilerplate with no custom type scale."
 *
 * THE THREE CONJUNCTS ARE ALL LOAD-BEARING. Inter alone is a legitimate choice;
 * slate alone is a legitimate neutral; either with a type scale is a decision.
 * Only all three together is the default nobody picked, and the positive control
 * for it is `calibration/stock-motion-only/style.css` — Inter leading, `#0f172a`
 * and `#e2e8f0` from the slate ramp, not one `font-size` declaration — against
 * `correct-portfolio/style.css`, which is Georgia on a warm ground and allows.
 */
const INTER_SLATE_DEFAULT: AntiSlopRule = {
  id: "AS-INTER-SLATE-DEFAULT",
  source: "spec §8 Layer 1",
  reason:
    "Inter on the slate ramp with no type scale of its own is the category default, not a decision. " +
    "Pick the family from the subject and the light or dark ground from the use scene, and declare a " +
    "scale with obvious size and weight steps — a `clamp()` display step and a body size are enough " +
    "to make it yours. (Inter is fine once something in the type has been decided.)",
  find: (text) => {
    const inter = interLeads(text);
    if (inter === null) return [];
    const slateUtility = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration)-slate-\d{2,3}\b/.exec(text);
    const slateHex = SLATE_HEXES.find((hex) => new RegExp(`${hex}\\b`, "i").test(text));
    const slate = slateUtility?.[0] ?? slateHex ?? null;
    if (slate === null) return [];
    if (hasCustomTypeScale(text)) return [];
    return [clip(`${inter} + ${slate}`)];
  },
};

/**
 * THE SHIPPED SET. Every rule here has both a measured false-positive count over
 * this repo and `calibration/correct-portfolio`, and a true-positive count over
 * a corpus it was not written against — see `antislop-corpus.mjs`. A ruleset
 * that matches nothing scores a perfect false-positive rate, which is why the
 * second number exists.
 *
 * WHAT IS DELIBERATELY ABSENT, WITH THE MEASUREMENT THAT EXCLUDED IT:
 *
 *   display type capped at 6rem [craft-floor]  MEASURED FALSE POSITIVE.
 *       `calibration/correct-portfolio/style.css` is
 *       `font-size:clamp(3rem,9vw,7rem)` — a GOOD artefact, over the cap.
 *   centred hero over three cards [spec §8]    MEASURED FALSE POSITIVE.
 *       correct-portfolio is `<header class="hero">` plus exactly three
 *       `<article class="project">`.
 *   zero-offset shadow halo [craft-floor]      The canonical `:focus-visible`
 *       ring IS the banned shape (`0 0 0 3px <colour>`), and Tailwind's `ring-*`
 *       utilities compile to it with no selector in the written text at all. A
 *       write-time rule cannot separate decoration from an accessibility
 *       affordance. `VIS-SURFACE-HABITS` grades it.
 *   contrast >=4.5:1, measure 65-75ch          Need the rendered page and the
 *       computed values — craft-floor's own instruction. Graded, not gated.
 *   nested cards / cards-as-structure          Needs the document tree; a hook
 *       sees text. `VIS-LAYOUT-SCAFFOLD` grades it.
 *   motion poverty [listed under §8 Layer 1]   A single write cannot see the
 *       page's total motion. It is Layer 2's job and it is done there.
 */
export const ANTISLOP_RULES: readonly AntiSlopRule[] = [
  PLACEHOLDER_IMAGE,
  LOREM_IPSUM,
  PURPLE_PINK_GRADIENT,
  GRADIENT_TEXT,
  COLOURED_BORDER_SIDE,
  TIGHT_TRACKING,
  EYEBROW_EVERYWHERE,
  INTER_SLATE_DEFAULT,
];

/**
 * Every Layer-1 finding for one written file, or none when the path is not an
 * artefact.
 *
 * THE PATH GATE IS FIRST AND IT IS THE WHOLE FALSE-POSITIVE STORY for prose:
 * this file, the plan, `visual-criteria.ts` and the spec all contain the banned
 * literals by necessity, and a `.md` is not a page.
 */
export function scanForSlop(filePath: string, text: string): readonly SlopFinding[] {
  if (!isArtefactPath(filePath)) return [];
  const findings: SlopFinding[] = [];
  for (const rule of ANTISLOP_RULES) {
    for (const evidence of rule.find(text)) {
      findings.push({ ruleId: rule.id, source: rule.source, reason: rule.reason, evidence });
    }
  }
  return findings;
}

/* ───────────────────────── Layer 2 — the motion bar ───────────────────────── */

export interface WorkspaceFile {
  readonly path: string;
  readonly text: string;
}

export type MotionVerdict =
  | { readonly kind: "abstain"; readonly why: string }
  | { readonly kind: "satisfied"; readonly satisfier: string }
  | { readonly kind: "unsatisfied"; readonly reason: string };

const WEB_SURFACE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
]);

function extensionOf(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * The motion bar, spec §8 Layer 2 — "bespoke motion derived from the design
 * stills", satisfied by ANY of three mechanisms and failed by stock hover/fade.
 *
 * NO SINGLE LIBRARY MAY BE MANDATED, and this is not a style preference: the
 * owner's own reference, kamilborzecki.dev, runs `document.getAnimations() === 0`
 * with no GSAP, no Framer and no Lenis. A criterion reading "uses GSAP" would
 * grade the reference site a failure, which is how a quality bar gets deleted
 * after it embarrasses itself once (spec §7.1's own correction).
 *
 * VIDEO IS ONE SATISFIER AMONG THREE AND NEVER A REQUIREMENT. Spec §7.1a stages
 * the bar: until Phase 2c lands there is no image→video step, so demanding a
 * scroll-scrubbed `.mp4` would fail every build this phase can produce. The
 * disjunction is what makes the staging automatic — no capability flag needed.
 *
 * IT ABSTAINS ON A NON-WEB WORKSPACE. A CLI or a library has no page to animate,
 * and a completion gate that blocks one is the "mysterious build failure" this
 * phase exists to avoid.
 */
export function decideMotion(files: readonly WorkspaceFile[]): MotionVerdict {
  const web = files.filter((f) => WEB_SURFACE_EXTENSIONS.has(extensionOf(f.path)));
  if (web.length === 0) {
    return { kind: "abstain", why: "no web surface in the workspace — nothing to animate" };
  }
  const scripts = files.filter((f) =>
    [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".html", ".htm"].includes(
      extensionOf(f.path),
    ),
  );
  const code = scripts.map((f) => f.text).join("\n");

  const scrollSignal = /\bscroll(?:Y|Top|Progress|Height)\b|ScrollTrigger|getBoundingClientRect|['"]scroll['"]/;
  if (/\.currentTime\s*=/.test(code) && scrollSignal.test(code)) {
    return { kind: "satisfied", satisfier: "scroll-scrubbed video (currentTime driven by scroll progress)" };
  }
  if (
    (/\bgsap\s*\.\s*timeline\s*\(/.test(code) ||
      /\bScrollTrigger\s*\.\s*(?:create|batch)\s*\(/.test(code) ||
      /\bscrollTrigger\s*:\s*\{/.test(code)) &&
    /\b(?:scrub|pin|stagger|ease)\b/.test(code)
  ) {
    return { kind: "satisfied", satisfier: "a GSAP/ScrollTrigger timeline (pinned, scrubbed or staggered)" };
  }
  if (
    /\brequestAnimationFrame\s*\(/.test(code) &&
    /IntersectionObserver|addEventListener\s*\(\s*['"]scroll['"]|\bscrollY\b|\.style\.|classList\.(?:add|toggle)|\.currentTime/.test(
      code,
    )
  ) {
    return { kind: "satisfied", satisfier: "rAF-driven element scrubbing" };
  }
  if (/\buseScroll\s*\(/.test(code) || /\buseTransform\s*\(/.test(code)) {
    return { kind: "satisfied", satisfier: "a Framer Motion scroll drive (useScroll/useTransform)" };
  }

  const imported = /from\s*['"](?:gsap|framer-motion|motion|@react-spring\/[a-z]+|lenis|animejs)['"]|require\(\s*['"](?:gsap|framer-motion|animejs)['"]/.exec(
    code,
  );
  const stockOnly = /transition(?:-all)?\s*[:=]|:hover\s*\{|\bhover:/.test(files.map((f) => f.text).join("\n"));
  const detail =
    imported !== null
      ? `An animation library is imported (\`${clip(imported[0])}\`) and never driven by a timeline.`
      : stockOnly
        ? "What is there is stock: hover lifts, opacity fades and `transition` alone."
        : "There is no motion at all.";
  return {
    kind: "unsatisfied",
    reason:
      `${detail} This build may not declare done without one authored motion moment derived from the ` +
      "design. Any ONE of these satisfies it: a scroll-scrubbed video or world-journey whose " +
      "`currentTime` is driven by scroll progress; a real GSAP/ScrollTrigger timeline that is pinned, " +
      "scrubbed or staggered with custom easing; rAF-driven element scrubbing; or a Framer " +
      "`useScroll`/`useTransform` drive. One focal sequence, easing out from an already-visible " +
      "default — not the same entrance replayed on every section.",
  };
}
