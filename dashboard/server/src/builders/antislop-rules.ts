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
 *   owner standing    THE OWNER, 2026-08-05, verbatim: "designs are always made
 *   rule 2026-08-05   using gemini connection rather than pulled from some
 *                     library". It owns `AS-STOCK-ASSET` and `AS-ICON-LIBRARY`.
 *                     It is cited SEPARATELY from the spec on purpose: the spec
 *                     bans placeholder GENERATORS, the owner bans TAKEN imagery
 *                     of every kind, and merging the two would lose the fact
 *                     that the second is newer and overrode a decision this file
 *                     had already made the other way (see `AS-PLACEHOLDER-IMAGE`
 *                     below).
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
export type AntiSlopSource =
  | "craft-floor.md"
  | "spec §8 Layer 1"
  | "spec §8 Layer 2"
  | "owner standing rule 2026-08-05";

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
 * THE NEAR-MISS THIS ONCE PROTECTED, AND THE REVERSAL — KEPT, NOT DELETED.
 * Until 2026-08-05 this rule's reason told the builder, verbatim: "(A specific
 * chosen photograph, e.g. an `images.unsplash.com/photo-...` URL, is fine — it
 * is the random/dimension generators that are not.)" and the comment here argued
 * for it: `https://images.unsplash.com/photo-1518791841217` is a CHOSEN
 * photograph, `https://source.unsplash.com/random/800x600` is a generator, and
 * matching "unsplash" would have failed both the same way. THAT ARGUMENT IS
 * STILL CORRECT ABOUT THE ANCHOR and it is why the anchor below is unchanged.
 *
 * IT WAS WRONG ABOUT THE POLICY, and the policy was decided by someone this file
 * does not get to overrule. THE OWNER, 2026-08-05: "designs are always made
 * using gemini connection rather than pulled from some library". A chosen
 * photograph from a stock library is pulled, not made. So the blessing is gone
 * from the reason and the chosen photograph is now REFUSED — by
 * {@link STOCK_ASSET}, under the owner's citation, not under the spec's. This
 * rule keeps exactly the scope the spec gave it (generators are not shippable
 * content, ticket or no ticket) and the two stay separable, because they can be
 * overridden on different terms: see {@link ticketAllowances}.
 */
const PLACEHOLDER_IMAGE: AntiSlopRule = {
  id: "AS-PLACEHOLDER-IMAGE",
  source: "spec §8 Layer 1",
  reason:
    "Placeholder image services are not shippable content. Use a real asset committed to the " +
    "workspace, or a design still from `design-refs/`. If no image exists yet, write the section " +
    "without one rather than reserving space with a generated rectangle. No ticket asks for a " +
    "grey rectangle with its own dimensions printed on it, so this one has no override.",
  find: (text) => {
    const hits: string[] = [];
    const generators = [
      "picsum\\.photos",
      "placehold\\.co",
      "placeholder\\.com",
      "dummyimage\\.com",
      "placekitten\\.com",
      "placeimg\\.com",
      "loremflickr\\.com",
      "baconmockup\\.com",
      "ui-avatars\\.com",
      "robohash\\.org",
      "placedog\\.net",
    ].join("|");
    const hosts = new RegExp(
      `(?:^|[\\s"'\`(=,:])(?:https?:)?//(?:[a-z0-9-]+\\.)*(?:${generators})(?=[/"'\`)\\s,;]|$)`,
      "gi",
    );
    for (const m of text.matchAll(hosts)) hits.push(clip(m[0]));
    const random = /(?:^|[\s"'`(=,:])(?:https?:)?\/\/(?:[a-z0-9-]+\.)*unsplash\.com\/random\b/gi;
    for (const m of text.matchAll(random)) hits.push(clip(m[0]));
    return hits;
  },
};

/* ───────────────── the owner's rule: made here, not taken ───────────────── */

/**
 * A remote reference that is being USED AS AN ASSET, with the position it sits
 * in. `where` is kept so a denial can quote the attribute rather than a bare URL.
 */
interface RemoteRef {
  readonly url: string;
  /** The authority, lower-cased and without port or credentials. */
  readonly host: string;
  readonly where: string;
}

/**
 * ASSET POSITION IS THE ANCHOR, and it is the difference between this rule and a
 * rule that forbids the internet.
 *
 * A URL in prose, in a comment, in a `fetch()`, or in an `<a href>` is a
 * REFERENCE. A URL in `src`, `srcset`, `poster`, a CSS `url()`, an `@import` or a
 * `<link>` is the page RENDERING that thing as part of itself. Only the second
 * is an asset, and only the second is judged here. The consequence is deliberate
 * and it is tested: `<a href="https://unsplash.com/photos/abc123">credit</a>`
 * stays legal, `<img src="https://images.unsplash.com/photo-...">` does not.
 *
 * WHAT THIS CANNOT SEE, STATED RATHER THAN PAPERED OVER: a URL assigned to a
 * variable in one file and interpolated into `src={hero}` in another. The
 * property-assignment form below catches the single-file case (`const hero =
 * "//..."`, `image: "//..."`); the cross-file case is Layer 2 / grading's, on the
 * same terms as `AS-EYEBROW-EVERYWHERE`'s cross-file limit.
 */
function remoteAssetRefs(text: string): readonly RemoteRef[] {
  const out: RemoteRef[] = [];
  // ONE REFERENCE, ONE FINDING. `<img src="//x">` is caught by the attribute
  // pattern AND by the property pattern (`src` followed by `=`), and a denial
  // that quotes the same URL twice reads as two problems to fix.
  const seen = new Set<string>();
  const push = (raw: string, where: string): void => {
    const url = raw.trim().replace(/^["'`]/, "");
    const authority = /^(?:https?:)?\/\/(?:[^/@\s]*@)?([a-z0-9.-]+)/i.exec(url);
    if (authority === null) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url: clip(url), host: (authority[1] ?? "").toLowerCase(), where });
  };
  const positions: readonly (readonly [RegExp, string])[] = [
    // HTML/JSX attributes that fetch. `href` is included ONLY inside `<link>`,
    // below — a bare `href` is a link, not an asset.
    [/\b(?:src|srcset|srcSet|poster|data-src|data-srcset)\s*=\s*["'`]?\s*((?:https?:)?\/\/[^"'`\s>]+)/gi, "src"],
    // Every candidate inside one `srcset`, which is a comma-separated list.
    [/\bsrc[sS]et\s*=\s*["'`]([^"'`]*)["'`]/gi, "srcset"],
    [/<link\b[^>]*?\bhref\s*=\s*["'`]?\s*((?:https?:)?\/\/[^"'`\s>]+)/gi, "<link href>"],
    [/\burl\(\s*["']?\s*((?:https?:)?\/\/[^)"'\s]+)/gi, "css url()"],
    [/@import\s+(?:url\(\s*)?["']\s*((?:https?:)?\/\/[^"')]+)/gi, "@import"],
    [
      /\b(?:src|srcSet|poster|image|imageUrl|imageSrc|backgroundImage|thumbnail|avatar|photo)\s*[:=]\s*["'`]\s*((?:https?:)?\/\/[^"'`\s]+)/gi,
      "asset property",
    ],
  ];
  for (const [re, where] of positions) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? "";
      if (where === "srcset") {
        for (const candidate of value.matchAll(/(?:https?:)?\/\/[^\s,]+/gi)) push(candidate[0], where);
      } else {
        push(value, where);
      }
    }
  }
  return out;
}

/** Suffix-aware host match: `unsplash.com` covers `images.unsplash.com`. */
function hostMatches(host: string, authority: string): boolean {
  return host === authority || host.endsWith(`.${authority}`);
}

/**
 * Stock libraries. THE LIST IS NOT THE RULE — the extension test below is, and it
 * is what keeps this from being the READ_TOOLS mistake in hosts (open to every
 * library nobody enumerated). The list exists because the biggest offenders serve
 * images from EXTENSIONLESS paths: `images.unsplash.com/photo-1518791841217`
 * ends in no `.jpg` and would otherwise walk straight through.
 */
const STOCK_MEDIA_HOSTS: readonly string[] = [
  "unsplash.com",
  "pexels.com",
  "pixabay.com",
  "istockphoto.com",
  "shutterstock.com",
  "gettyimages.com",
  "stock.adobe.com",
  "freepik.com",
  "stocksnap.io",
  "burst.shopify.com",
  "flickr.com",
  "giphy.com",
  "tenor.com",
  "lorempixel.com",
];

/**
 * Type foundries and font CDNs. THE OWNER NAMED THE LIBRARY, NOT THE MEDIUM:
 * "pulled from some library" reads on a typeface as squarely as on a photograph,
 * and the one build in this repo that ever passed
 * (`runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/styles.css:22`) sets
 * `--font-sans` to a system stack and links nothing. There IS a route to yes that
 * is not the ticket override: self-host the `.woff2` in the workspace, which is a
 * relative URL and has no authority to match.
 */
const REMOTE_FONT_HOSTS: readonly string[] = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
  "p.typekit.net",
  "fonts.bunny.net",
  "api.fontshare.com",
  "fonts.cdnfonts.com",
  "fast.fonts.net",
];

/** A path that names its medium. Catches a chosen photograph on ANY host. */
const MEDIA_EXTENSION = /\.(?:jpe?g|png|webp|avif|gif|bmp|tiff?|svg|mp4|webm|mov|m4v|woff2?|ttf|otf|eot)(?:[?#]|$)/i;

/* ─────────────────────── the ticket's right to override ─────────────────────── */

/**
 * A ticket may legitimately need a remote resource — an embedded map, a font the
 * owner asked for by name, a photograph he supplied by URL. THE HAZARD THIS
 * EXISTS TO AVOID IS NOT A BAD PAGE, IT IS A DELETED RULE: a gate that fires on a
 * ticket it cannot be right about gets switched off, and then it protects
 * nothing. So there is an override, and its shape is chosen so that using it
 * costs something and leaves a trace.
 *
 * THE GRAMMAR, EXACTLY, written next to the reference it excuses:
 *
 *     antislop-allow: <authority-or-package> — TICKET: <the ticket's own words>
 *
 * THE FOUR BOUNDARIES, each of which is the reason for a line of code below:
 *
 *   NAMED, NEVER BLANKET.  The subject is one authority or one package
 *       specifier. `antislop-allow: maps.googleapis.com` excuses that host and
 *       nothing else; there is no spelling of this that turns the rule off.
 *   SCOPED TO ONE FILE.  A hook sees one write. The marker lives in the artefact
 *       that carries the reference, so it ships with it and greps out of the tree
 *       afterwards. It cannot be parked in a config nobody reads.
 *   IT MUST CITE.  A subject with no `TICKET:` clause of at least twelve
 *       characters is not an allowance. The builder has to write down which
 *       instruction it is standing on, which is the artefact a reviewer or the
 *       grading pass checks against the real ticket.
 *   IT CANNOT REACH THE GENERATORS.  `AS-PLACEHOLDER-IMAGE` ignores allowances
 *       entirely. The owner's rule is a TASTE decision a ticket may outrank; a
 *       placeholder generator is an UNFINISHED page, and no ticket asks for one.
 *
 * WHAT IT IS NOT: unforgeable. Nothing here reads the ticket — a `PreToolUse`
 * hook is handed one file's text and no more — so a builder that writes a
 * citation nobody asked for gets through. That is the honest position and it is
 * the same one the whole layer takes: this is a CRAFT GATE that already
 * escalates-and-ALLOWS after three fires of the same rule (`antislop-hook.ts`
 * :190-204), so the override is strictly NARROWER than the exit that already
 * existed, and unlike that exit it leaves a signed reason in the shipped file.
 * Making it unforgeable means passing the ticket text into `scanForSlop`, which
 * is a signature change in `antislop-hook.ts` and belongs to whoever owns that
 * file.
 */
export interface TicketAllowance {
  /** One authority or one package specifier, lower-cased. */
  readonly subject: string;
  /** The ticket wording the builder says it is standing on. */
  readonly citation: string;
}

/**
 * The subject class deliberately starts `[a-z0-9]`, so the TEMPLATE quoted in a
 * denial reason (`antislop-allow: <host> — TICKET: ...`) does not parse as an
 * allowance. Without that, this file and every denial the model writes down would
 * grant themselves an exemption for a host named `<host>`.
 */
const TICKET_ALLOW_RE =
  /antislop-allow\s*:\s*([a-z0-9][a-z0-9.@/_+-]*)\s*[—–\-:,;]*\s*TICKET\s*:\s*([^\n*]{1,240})/gi;

/**
 * How much the builder has to write down. Twelve characters is roughly four
 * words — enough that "the ticket says so" cannot be typed by reflex, short
 * enough that it never becomes the reason a legitimate override is abandoned.
 * IT IS ENFORCED HERE AND NOT IN THE PATTERN: a length bound inside the regex
 * looks identical from the outside and is untestable, because a citation that is
 * too short simply fails to parse and the check can never be observed failing.
 */
const MIN_TICKET_CITATION = 12;

export function ticketAllowances(text: string): readonly TicketAllowance[] {
  const out: TicketAllowance[] = [];
  for (const m of text.matchAll(TICKET_ALLOW_RE)) {
    const subject = (m[1] ?? "").toLowerCase().replace(/[.,;]+$/, "");
    // The comment TERMINATOR is not part of the citation. `TICKET: yes -->`
    // would otherwise measure seventeen characters and pass a length test that
    // exists to make the builder actually write down what it is standing on.
    const citation = (m[2] ?? "")
      .replace(/(?:-->|\*\/|\/\/|\/\*|[-*/\s])+$/, "")
      .trim();
    if (subject.length === 0 || citation.length < MIN_TICKET_CITATION) continue;
    out.push({ subject, citation });
  }
  return out;
}

function isAllowed(allowances: readonly TicketAllowance[], subject: string): boolean {
  const lower = subject.toLowerCase();
  return allowances.some(
    (a) => hostMatches(lower, a.subject) || lower === a.subject || lower.startsWith(`${a.subject}/`),
  );
}

/**
 * The owner's rule, 2026-08-05: "designs are always made using gemini connection
 * rather than pulled from some library."
 *
 * THIS IS THE REVERSAL. `AS-PLACEHOLDER-IMAGE` above used to bless a chosen
 * photograph in so many words; it is refused here instead, and the two rules are
 * kept apart rather than merged so that the citation stays honest — the spec bans
 * generators, the OWNER bans taken imagery, and only the second can be outranked
 * by a ticket.
 *
 * IT FIRES ON TWO SIGNALS, NOT ONE. A stock/foundry AUTHORITY (because the worst
 * offenders serve extensionless paths), OR a path that ends in an image, video or
 * font extension on ANY host (because a list of libraries is open to every
 * library nobody enumerated). The second is what makes a photograph the builder
 * found on some blog fail too.
 */
const STOCK_ASSET: AntiSlopRule = {
  id: "AS-STOCK-ASSET",
  source: "owner standing rule 2026-08-05",
  reason:
    "Every visual asset in this product is MADE, not taken — the owner's standing rule is that " +
    "designs come from the Gemini image connection rather than pulled from a library. This " +
    "references a picture, video or typeface hosted somewhere else, so it is taken. Generate the " +
    "image through the design step and commit it into the workspace, use a still from " +
    "`design-refs/`, or drop the element; for type, self-host the font file next to the stylesheet " +
    "or use a system stack (the one build in this repo that ever shipped does exactly that). " +
    "IF THE TICKET ITSELF ASKS FOR THIS RESOURCE, keep it and write the override on the line " +
    "beside it as a comment, naming the host and quoting the instruction: " +
    "`antislop-allow: <host> — TICKET: <the words in the ticket that ask for it>`. That excuses " +
    "that one host in that one file and nothing else.",
  find: (text) => {
    const allowances = ticketAllowances(text);
    const hits: string[] = [];
    for (const ref of remoteAssetRefs(text)) {
      const stock = STOCK_MEDIA_HOSTS.some((h) => hostMatches(ref.host, h));
      const foundry = REMOTE_FONT_HOSTS.some((h) => hostMatches(ref.host, h));
      if (!stock && !foundry && !MEDIA_EXTENSION.test(ref.url)) continue;
      if (isAllowed(allowances, ref.host)) continue;
      hits.push(clip(`${ref.where}: ${ref.url}`));
    }
    return hits;
  },
};

/**
 * Iconography, same owner rule, separate id so it gets its own denial text and
 * its own escalation budget (`antislop-hook.ts` counts per rule per agent).
 *
 * TWO SHAPES, BOTH EXACT. A bare-specifier import of a known icon PACKAGE, and an
 * icon CDN in asset position. Neither is a substring guess.
 *
 * DELIBERATELY LEFT: icon-font CLASS NAMES (`<i class="fa fa-user">`,
 * `material-icons`). A class name is a bare word in a stream of text, which the
 * header of this file forbids anchoring to, and it cannot work without the CDN
 * link or the package that IS caught here — so the coverage is already there one
 * step upstream. Also left: inline `<svg>` the builder drew, which is the answer
 * the reason points at.
 */
const ICON_LIBRARY_PACKAGES: readonly string[] = [
  "lucide",
  "lucide-react",
  "lucide-vue-next",
  "lucide-svelte",
  "react-icons",
  "@heroicons/react",
  "@heroicons/vue",
  "heroicons",
  "@fortawesome/fontawesome-free",
  "@fortawesome/react-fontawesome",
  "@fortawesome/free-solid-svg-icons",
  "@tabler/icons",
  "@tabler/icons-react",
  "@mui/icons-material",
  "@radix-ui/react-icons",
  "@phosphor-icons/react",
  "phosphor-react",
  "react-feather",
  "feather-icons",
  "bootstrap-icons",
  "ionicons",
  "@iconify/react",
  "@iconify-icon/react",
  "iconify-icon",
  "simple-icons",
  "@ant-design/icons",
  "remixicon",
];

const ICON_CDN_HOSTS: readonly string[] = [
  "use.fontawesome.com",
  "kit.fontawesome.com",
  "code.iconify.design",
  "api.iconify.design",
  "unicons.iconscout.com",
  "cdn.lineicons.com",
];

/** A CDN that serves everything: judged by what the PATH asks for, not the host. */
const GENERAL_CDN_HOSTS: readonly string[] = ["cdnjs.cloudflare.com", "unpkg.com", "cdn.jsdelivr.net", "esm.sh"];
const ICON_PATH = /(?:font-?awesome|iconify|ionicons|bootstrap-icons|remixicon|material-(?:icons|symbols)|feather|heroicons|lucide|phosphor|tabler[/-]icons|lineicons|boxicons)/i;

const ICON_LIBRARY: AntiSlopRule = {
  id: "AS-ICON-LIBRARY",
  source: "owner standing rule 2026-08-05",
  reason:
    "Icons come from the design too — the owner's standing rule is that designs are made through " +
    "the Gemini connection rather than pulled from a library, and a shipped icon set is the most " +
    "recognisable way a product wears somebody else's drawing. Draw the few marks this page needs " +
    "as inline `<svg>` from the design stills, at the stroke weight the rest of the page uses. " +
    "IF THE TICKET NAMES THIS SET, keep it and record the override beside the import, naming the " +
    "package or host and quoting the instruction: " +
    "`antislop-allow: <package> — TICKET: <the words in the ticket that ask for it>`.",
  find: (text) => {
    const allowances = ticketAllowances(text);
    const hits: string[] = [];
    const specifiers = /(?:from\s*|require\(\s*|import\(\s*)["']([^"'\n]+)["']/gi;
    for (const m of text.matchAll(specifiers)) {
      const spec = (m[1] ?? "").toLowerCase();
      const pkg = ICON_LIBRARY_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`));
      if (pkg === undefined) continue;
      if (isAllowed(allowances, spec) || isAllowed(allowances, pkg)) continue;
      hits.push(clip(spec));
    }
    for (const ref of remoteAssetRefs(text)) {
      const dedicated = ICON_CDN_HOSTS.some((h) => hostMatches(ref.host, h));
      const general = GENERAL_CDN_HOSTS.some((h) => hostMatches(ref.host, h)) && ICON_PATH.test(ref.url);
      if (!dedicated && !general) continue;
      if (isAllowed(allowances, ref.host)) continue;
      hits.push(clip(`${ref.where}: ${ref.url}`));
    }
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
 *   a remote SCRIPT or STYLESHEET that is not an asset [owner rule]
 *       `<script src="//cdn.tailwindcss.com">` and an unpkg React build are
 *       DEPENDENCIES, not design. The owner's rule is about what the product
 *       LOOKS like being made rather than taken; stretching it to every network
 *       reference is how a rule fires on a ticket it cannot be right about and
 *       gets switched off. The same CDNs ARE judged when the path asks for an
 *       icon set — see `GENERAL_CDN_HOSTS` + `ICON_PATH`.
 *   icon-font CLASS NAMES (`fa-user`, `material-icons`) [owner rule]
 *       A bare word in a stream of text, which this file's header forbids
 *       anchoring to. They cannot render without the CDN link or the package
 *       that `AS-ICON-LIBRARY` already catches.
 *   a stock URL reached through a VARIABLE across files [owner rule]
 *       A `PreToolUse` hook sees one write. Same limit, and the same honesty,
 *       as `AS-EYEBROW-EVERYWHERE`'s single-file count.
 */
export const ANTISLOP_RULES: readonly AntiSlopRule[] = [
  PLACEHOLDER_IMAGE,
  STOCK_ASSET,
  ICON_LIBRARY,
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

/**
 * A PAGE OR A COMPONENT — NOT A STYLESHEET, and that is a correction with a
 * measurement behind it. `.css`/`.scss` were in this set until a constructed
 * near-miss was run: a CLI workspace of `src/index.ts` + `report.css` +
 * `README.md` came back `unsatisfied` and would have been told to add a
 * scroll-scrubbed video to a printed report. A stylesheet is evidence that
 * something is styled, never that something is a page.
 */
const WEB_SURFACE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
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
