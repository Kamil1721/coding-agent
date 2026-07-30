/**
 * activity.ts — turning one recorded tool call into a line a person reads.
 *
 * WHY THIS EXISTS. `GraphNode.activity` is faithful and unreadable:
 *
 *   Bash  command: /Users/kamilborzecki/.claude/scripts/gemini-image.sh "A premium
 *         website design comp — hero section for 'Coglane', a neighbourhood bicycle…
 *   Read  file_path: /Users/kamilborzecki/Projects/coding-agent/dashboard/runs/
 *         run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/design-refs/01-hero.png
 *
 * Both lines are 60% absolute path. The owner's ask was the opposite of faithful:
 * "I just want to see the thinking and design process, for example what it was
 * looking at in order… for example designing the hero image or text boxes". So this
 * module reads the SHAPE of a summary and says what happened:
 *
 *   generating   hero section reference
 *   looking at   01-hero.png
 *
 * TWO RULES IT HOLDS TO.
 *
 * 1. IT NEVER INVENTS. Every verb below is licensed by the tool name, and every
 *    object is a substring of the recorded detail. When a shape is not recognised
 *    the fall-through prints the tool name and the detail rather than guessing —
 *    an unrecognised call must look unrecognised, not plausible. `raw` carries the
 *    untouched detail so the UI can always show exactly what was recorded.
 *
 * 2. IT IS PURE AND TESTED SEPARATELY, because it is the one place in this feature
 *    where a wrong answer is invisible. A mis-parsed path still renders as a tidy
 *    line, so `activity.unit.spec.ts` drives the REAL summaries taken off the
 *    recorded run rather than invented ones.
 */

import type { GraphActivityEntry } from "./api-types";

export interface ActivityLine {
  /** The server's recorded instant, or null when the row predates timestamps. */
  readonly at: string | null;
  /** What happened, as a verb phrase: `generating`, `looking at`, `writing`. */
  readonly verb: string;
  /** What it happened to. Always a substring of the recorded detail. */
  readonly object: string;
  /**
   * Coarse class, for weight in the timeline. `design` is what the owner wants to
   * see first; `housekeeping` is a `mkdir` and should not compete with it.
   */
  readonly kind: "design" | "read" | "write" | "search" | "delegate" | "skill" | "housekeeping";
  /** The untouched recorded detail, for a title attribute and the raw view. */
  readonly raw: string;
  /** True when the recorded detail was already cut on the server. */
  readonly truncated: boolean;
}

/** `file_path: /a/b/c.png` → `c.png`. Never throws on a value with no slash. */
function basename(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Split `key: value` — the shape every tool summary in this codebase uses
 * (`command:`, `file_path:`, `description:`, `library:`).
 *
 * Returns a null key rather than throwing when there is no prefix, because a
 * summary is data from a subprocess and may be anything at all.
 */
function splitSummary(detail: string): { key: string | null; value: string } {
  const match = /^([a-z_]+):\s*([\s\S]*)$/i.exec(detail);
  if (match === null) return { key: null, value: detail };
  return { key: match[1] ?? null, value: match[2] ?? "" };
}

/**
 * Pull the subject out of an image-generation prompt.
 *
 * THE REAL FORMAT, quoted from the recorded run rather than assumed:
 *
 *   A premium website design comp — hero section for 'Coglane', a neighbourhood…
 *
 * The subject sits between the em dash and ` for '`. Both delimiters are checked
 * and the whole thing degrades to a short prefix when either is missing, because
 * the prompt is written by a model and its shape is a convention, not a contract.
 */
function imageSubject(command: string): string {
  const quoted = /["']([\s\S]{10,})["']/.exec(command);
  const prompt = quoted?.[1] ?? command;

  const dashed = /[—–-]\s*([^—–]+?)\s+for\s+['"]/.exec(prompt);
  if (dashed?.[1] !== undefined) return `${dashed[1].trim()} reference`;

  const afterDash = /[—–]\s*([^,.]{3,60})/.exec(prompt);
  if (afterDash?.[1] !== undefined) return `${afterDash[1].trim()} reference`;

  return "a design reference";
}

/** The first word of a shell command — `mkdir -p /a/b` → `mkdir`. */
function commandName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? command;
  return basename(first);
}

/** Scripts whose whole purpose is producing a design still or clip. */
const IMAGE_SCRIPTS = /gemini-image\.sh|gemini-video\.sh|imagegen/i;

/**
 * Commands that are plumbing rather than work. Kept in the timeline (removing
 * them would make the order a lie) but classed so the UI can mute them.
 */
const HOUSEKEEPING = new Set(["mkdir", "ls", "cd", "pwd", "rm", "cp", "mv", "chmod", "touch"]);

/**
 * One recorded call → one readable line.
 *
 * Total by construction: every branch either returns or falls through to the
 * generic tail, so an unknown tool name cannot produce an empty line.
 */
export function describeActivity(entry: GraphActivityEntry): ActivityLine {
  const base = { at: entry.at, raw: entry.detail, truncated: entry.truncated } as const;
  const { key, value } = splitSummary(entry.detail);

  if (entry.kind === "skill") {
    /*
     * THE SAME VERB AS THE `Skill` TOOL BRANCH BELOW, DELIBERATELY.
     *
     * One skill load is reported TWICE by the CLI — once as a `Skill` tool call and
     * once as a `graph_skill` event — so the timeline showed
     *
     *     02:48:27  loading skill imagegen-frontend-web
     *     02:48:27  loaded skill imagegen-frontend-web
     *
     * Two lines, one act, observed in the panel before this was changed. Matching
     * the wording is what lets `collapseAdjacent` recognise them as one; the
     * same-instant rule there is what stops the merge being counted as "×2".
     */
    return { ...base, verb: "loading skill", object: entry.name, kind: "skill" };
  }

  switch (entry.name) {
    case "Bash": {
      const command = key === "command" ? value : entry.detail;
      if (IMAGE_SCRIPTS.test(command)) {
        return { ...base, verb: "generating", object: imageSubject(command), kind: "design" };
      }
      const name = commandName(command);
      return {
        ...base,
        verb: "ran",
        object: name,
        kind: HOUSEKEEPING.has(name) ? "housekeeping" : "write",
      };
    }

    case "Read": {
      const file = basename(key === "file_path" ? value : entry.detail);
      // Reading an image IS the design review step — it is the agent looking at
      // what it just made, which is the moment the owner asked to see.
      const isImage = /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file);
      return {
        ...base,
        verb: isImage ? "looking at" : "reading",
        object: file,
        kind: isImage ? "design" : "read",
      };
    }

    case "Write":
      return {
        ...base,
        verb: "writing",
        object: basename(key === "file_path" ? value : entry.detail),
        kind: "write",
      };

    case "Edit":
    case "MultiEdit":
      return {
        ...base,
        verb: "editing",
        object: basename(key === "file_path" ? value : entry.detail),
        kind: "write",
      };

    case "Grep":
    case "Glob":
      return { ...base, verb: "searching for", object: value || entry.detail, kind: "search" };

    case "Agent":
      return {
        ...base,
        verb: "delegating",
        object: key === "description" ? value : entry.detail,
        kind: "delegate",
      };

    case "Skill": {
      /*
       * The Skill tool's summary is JSON — `{"skill":"imagegen-frontend-web"}` —
       * and is the only summary in the set that is not `key: value`. Parsed rather
       * than regexed, and a parse failure falls through to the raw detail instead
       * of printing a broken brace.
       */
      let named = entry.detail;
      try {
        const parsed: unknown = JSON.parse(entry.detail);
        if (typeof parsed === "object" && parsed !== null && "skill" in parsed) {
          const skill = (parsed as { skill: unknown }).skill;
          if (typeof skill === "string") named = skill;
        }
      } catch {
        // Not JSON. `named` stays the recorded detail.
      }
      return { ...base, verb: "loading skill", object: named, kind: "skill" };
    }

    case "TodoWrite":
      return { ...base, verb: "planning", object: "updated its task list", kind: "housekeeping" };

    case "WebFetch":
    case "WebSearch":
      return { ...base, verb: "looking up", object: value || entry.detail, kind: "search" };

    default:
      /*
       * THE HONEST FALL-THROUGH. An MCP tool or a name added after this file was
       * written prints as itself. It must look unhandled rather than be dressed in
       * a plausible verb — a wrong description here is invisible, because it still
       * renders as a tidy line.
       */
      return {
        ...base,
        verb: entry.name,
        object: value || entry.detail,
        kind: "read",
      };
  }
}

/**
 * Collapse an immediate repeat into one line with a count.
 *
 * WHY: the recorded run generates a reference, reads it, generates the next, reads
 * that — but a build segment does `Read` forty times in a row over the same tree,
 * and forty identical lines bury the two that matter. Only ADJACENT identical
 * verb+object pairs collapse, so the ORDER is never altered — which is the one
 * property the owner asked for and the one a naive group-by would destroy.
 */
export interface ActivityRun extends ActivityLine {
  /** How many adjacent identical entries this line stands for. Always ≥ 1. */
  readonly repeats: number;
}

/**
 * How close two identical entries have to be to count as ONE act reported twice.
 *
 * MEASURED, NOT PICKED. The CLI reports a skill load down two channels, and in the
 * recorded run those land 3ms apart:
 *
 *   seq 25  2026-07-30T00:48:27.829Z  tool
 *   seq 27  2026-07-30T00:48:27.832Z  graph_skill
 *
 * So exact timestamp equality does not catch them — the first attempt at this used
 * `===` and the panel still showed "loading skill imagegen-frontend-web ×2".
 *
 * 250ms is chosen against the other side of the gap: the closest two GENUINELY
 * distinct steps in that run are 9 seconds apart (a `gemini-image.sh` call and the
 * `Read` of what it produced), because every real step waits on a subprocess. The
 * window therefore sits two orders of magnitude below anything it could wrongly
 * merge.
 */
const SAME_ACT_MS = 250;

/**
 * True when two entries are ONE act reported down two channels.
 *
 * NARROWED TO `skill` DELIBERATELY, and the first version was not.
 *
 * The double-report this exists for is specific: the CLI emits a skill load as both
 * a `Skill` tool call and a `graph_skill` event. Applying a 250ms window to EVERY
 * kind was wrong for a reason no measurement in this run could have shown — a build
 * segment doing two genuine consecutive `Edit`s on the same file inside 250ms would
 * have been silently merged into one line. That is real work disappearing from the
 * record to make the list look tidier, which is the opposite of this panel's job.
 *
 * So the window only applies where the duplication is known to come from, and every
 * other kind counts repeats however fast they arrive.
 */
function sameAct(a: ActivityLine, b: ActivityLine): boolean {
  if (a.kind !== "skill" || b.kind !== "skill") return false;
  // BOTH NULL IS NOT THE SAME MOMENT. On a pre-timestamp run every entry is null,
  // and treating that as "same act" would swallow every real repeat on every
  // historical run — data loss disguised as a tidier list.
  if (a.at === null || b.at === null) return false;
  const gap = Math.abs(new Date(b.at).getTime() - new Date(a.at).getTime());
  return Number.isFinite(gap) && gap <= SAME_ACT_MS;
}

export function collapseAdjacent(lines: readonly ActivityLine[]): readonly ActivityRun[] {
  const out: ActivityRun[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last !== undefined && last.verb === line.verb && last.object === line.object) {
      /*
       * SAME INSTANT AND SAME DESCRIPTION MEANS ONE ACT REPORTED TWICE, so the
       * count does NOT rise.
       *
       * The CLI emits a skill load down two channels — a `Skill` tool call and a
       * `graph_skill` event — with the same recorded time. Counting that as "×2"
       * would state that the agent loaded the skill twice, which is a claim the data
       * does not make. A genuine repeat has a different `at`, because it happened
       * later.
       *
       * The comparison is a WINDOW, not equality — the two channels land a few
       * milliseconds apart. See {@link SAME_ACT_MS}.
       */
      if (sameAct(last, line)) continue;
      out[out.length - 1] = { ...last, repeats: last.repeats + 1 };
      continue;
    }
    out.push({ ...line, repeats: 1 });
  }
  return out;
}

/**
 * An agent's closing message, made readable.
 *
 * WHAT IT IS GIVEN. `GraphResult.summary` is whatever the agent wrote, and on the
 * recorded run `ui-designer`'s is this:
 *
 *   Chosen: `01-hero.png` — written to
 *   `/Users/kamilborzecki/Projects/coding-agent/dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/design-refs/choice.json`.
 *   Per-ref verdicts: - **01-hero**: strongest overall — eyebrow, display headline …
 *
 * Two thirds of that is one absolute path, and the rest is unrendered markdown. The
 * owner's verdict: "what it reported is useless to me as its just a wall of text…
 * I am just interested in the functionality and the design of the finished product".
 *
 * SO THREE THINGS HAPPEN, and each is a substitution, never a rewrite:
 *
 *   1. absolute paths collapse to their filename — `…/design-refs/choice.json` becomes
 *      `choice.json`. The path identified nothing the filename does not; it was 130
 *      characters of this machine's directory layout.
 *   2. markdown emphasis and list bullets are stripped, because nothing renders them
 *      and `- **01-hero**:` is noise in plain text.
 *   3. whitespace collapses, so a summary written as a wrapped block becomes prose.
 *
 * IT NEVER DROPS A CLAUSE. No sentence is removed and no word is reordered — every
 * fact the agent stated survives, which is why this is safe to show as "what it
 * reported" rather than as a paraphrase. Clamping is the caller's job.
 */
export function readableSummary(summary: string): string {
  return summary
    /*
     * ABSOLUTE POSIX PATHS ONLY, and the anchor is load-bearing.
     *
     * The first version was `/\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g` with no anchor, and it
     * ate any text containing slashes: `plain HTML/CSS/JS` came out as `plain HTMLJS`,
     * observed in the panel. That is silent CONTENT CORRUPTION — worse than the wall of
     * text it was cleaning, because it reads as something the agent wrote.
     *
     * So the slash must start the token: preceded by the string start, whitespace, or an
     * opening quote/paren. `HTML/CSS/JS` has a letter before its slash and is left
     * alone; `/Users/kamilborzecki/…/choice.json` is not.
     */
    .replace(/(^|[\s'"`([])\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g, "$1$2")
    // Markdown ATX headings — `## Handoff Summary` renders as literal hashes here.
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    // Markdown emphasis. The captured text stays.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Leading list bullets, wherever they landed after unwrapping.
    .replace(/(^|\s)[-*]\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
