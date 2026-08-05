"use client";

/**
 * motion.tsx — WHAT THE REFERENCE PAGE WAS OBSERVED TO DO, on the tab about the
 * ticket. A record, not a control: nothing here is clickable except the address
 * that was read.
 *
 * WHY IT EXISTS AT ALL. `RunDetail.motion` went on the wire on 2026-08-04 and
 * nothing in this app read it — the second stage of the shape `references` and
 * `documents` shipped in two days earlier. `contract-parity.test.ts` proves the
 * type matches on both sides and passes perfectly while the field renders
 * nowhere; parity is a claim about two declarations, and only a browser can see
 * a renderer.
 *
 * THE THREE STATES, AND THIS FILE IS THE FIRST THING THAT COULD COLLAPSE THEM.
 * The server keeps them apart deliberately (`api-types.ts`, `http.ts#toDetail`):
 *
 *   `motion === null`         no reading was taken — no `motionUrl` was
 *                             submitted, the address was refused, or the browser
 *                             would not start. Renders NOTHING. It is the state
 *                             of every ticket that named no reference, which is
 *                             most of them, and a box announcing that absence
 *                             would sit on almost every run on this machine.
 *
 *   `entries.length === 0`    A PAGE WAS READ AND NOTHING MOVED while it was
 *                             watched. That is a fact about the reference, not
 *                             about this dashboard, and folding it into the case
 *                             above would report an opened, watched page as an
 *                             ignored one. It gets a panel, with one sentence and
 *                             no list — never a heading over an empty list.
 *
 *   entries                   the reading.
 *
 * EVERY NUMBER IS A BUCKET AND IS PRINTED AS ONE. `ApiMotionEntry` says duration
 * is rounded to 50 ms and stagger to 20 ms because two readings of the same page
 * do not agree more closely, so this panel writes "about 650ms" and never
 * "650ms". No figure is converted, re-rounded or turned into seconds here: a
 * renderer that reformats a bucket is asserting a precision the capture refused.
 *
 * `parity: false` MEANS THE CONTENT WAS NEVER COMPARED, AND ITS FIGURES ARE
 * ABOUT THE SAMPLER. Two families are presence-only (route transitions,
 * canvas/WebGL repaints): they were observed to run, their `durationMs`
 * describes the sampling window rather than a declared animation, and their
 * stagger and scroll ratio were never compared against anything. So this file
 * RETURNS BEFORE PRINTING ANY OF THEM — the same cut `motion-brief.ts#entryLine`
 * makes for the same reason — and says in the row what was and was not checked.
 * The branch is on `entry.parity`, never on the family name, because the server
 * owns that classification and a second copy of the list here would drift.
 *
 * `family` IS `string` ON BOTH SIDES DELIBERATELY, so a newer server may send a
 * thirteenth name. The prose table below is keyed by `string` with a fallback
 * that prints the raw slug: an unknown family is NAMED rather than dropped, and
 * dropping it is the failure mode that would make a reading look shorter than it
 * was. The known wordings are transcribed from `server/src/motion-brief.ts` so
 * this panel and the brief the spec seat reads describe a row the same way.
 *
 * WHAT THIS PANEL DOES NOT CLAIM, stated because claiming more than the data
 * contains is the defect this repository keeps shipping:
 *
 *   - It is not an inventory. Motion outside the sampling window, below the
 *     sampled viewport, or behind an interaction the sampler never performed is
 *     absent from it, and that limit is still stated on screen — since
 *     2026-08-05 behind the subtitle's `Explain` glyph rather than as a
 *     paragraph under it. Hiding it was allowed because it changes what a reader
 *     concludes; deleting it would not have been.
 *   - It says nothing about what was BUILT. This is the reference page as it was
 *     on the day the ticket was submitted; whether the artefact matches it is
 *     the gate's answer, not this panel's.
 *   - `respectsReducedMotion: false` is NOT "the page ignores the preference".
 *     `motion-capture.ts#probeReducedMotion` opens a second context and returns
 *     `false` from its own `catch` as well as from a page that kept moving, so
 *     the two are indistinguishable on the wire and the sentence names both.
 *     `true` is a real observation and is worded as one.
 *   - No role is re-validated here. `motion-brief.ts#safeRole` exists because the
 *     brief is hashed into the ticket id; this is display, and a second shape
 *     guard would only mean two places to disagree about what a role is.
 *
 * `ink-dim` FOR A SENTENCE, `ink-faint` FOR A NUMBER — the split
 * `attachments.tsx` measured: against `--color-surface` the tokens compute to
 * 7.97:1 and 4.14:1, so faint is under WCAG AA for body text. Every string here
 * that carries a claim is `ink-dim` or `ink`; `ink-faint` is left to the metric
 * line and the timestamp, which sit beside a role that is already `ink`.
 */

import type { ReactNode } from "react";

import type { ApiMotionEntry, ApiMotionSpec } from "@/lib/api-types";
import { formatClock } from "@/lib/format";
import { Explain } from "@/components/explain";
import { Panel } from "@/components/ui";

/**
 * How each family reads in a sentence, transcribed from `FAMILY_PROSE` in
 * `server/src/motion-brief.ts` so the panel and the brief agree.
 *
 * KEYED BY `string`, NOT BY A UNION, and that is the opposite call to the
 * server's — deliberately. There the key is the union so a thirteenth family is
 * a compile error before it can be hashed into a ticket id; here the wire type
 * is `string`, an older client will meet a newer server, and the failure worth
 * avoiding is a row that renders as nothing.
 */
const FAMILY_PROSE: Readonly<Record<string, string>> = {
  "load-entrance": "on load, entering",
  "scroll-reveal": "revealed once on scroll into view",
  "scroll-linked": "driven by scroll position rather than by time",
  "hover-focus": "on hover and on keyboard focus",
  "ambient-loop": "looping continuously with no trigger",
  "split-text": "per-character, staggered",
  "path-draw": "an SVG stroke drawing itself",
  "scroll-inertia": "smooth-scroll inertia on the document",
  "cursor-follow": "following the pointer",
  "tilt-3d": "tilting in 3D toward the pointer",
  "route-transition": "between routes",
  "canvas-ambient": "a canvas or WebGL surface repainting continuously",
};

/** The sentence for a family, or the slug itself when this client has no word. */
function familyProse(family: string): string {
  return FAMILY_PROSE[family] ?? family;
}

/** `opacity and transform`, `opacity, transform and filter`. */
function propsPhrase(props: readonly string[]): string | null {
  if (props.length === 0) return null;
  if (props.length === 1) return props[0] ?? null;
  const head = props.slice(0, -1).join(", ");
  return `${head} and ${String(props[props.length - 1])}`;
}

/**
 * The clauses that carry a figure, in the order `motion-brief.ts` prints them.
 *
 * ONLY EVER CALLED FOR A PARITY ROW. `MotionRow` returns before this for a
 * presence-only entry, so no number on this list can describe the sampler rather
 * than the page.
 */
function parityClauses(entry: ApiMotionEntry): readonly string[] {
  const clauses: string[] = [`about ${String(entry.durationMs)}ms`];
  if (entry.easing !== null) clauses.push(entry.easing);
  // `null` stagger is "this role had no siblings to be staggered against", which
  // is not `0` — zero would say the siblings moved together.
  if (entry.staggerMs !== null) clauses.push(`about ${String(entry.staggerMs)}ms apart across siblings`);
  if (entry.scrollRatio !== null) clauses.push(`${entry.scrollRatio.toFixed(2)}px per px scrolled`);
  // `null` iterations is "it repeats without end", which is why it is not `0`.
  if (entry.iterations === null) clauses.push("repeating without end");
  return clauses;
}

function MotionRow({ entry }: { entry: ApiMotionEntry }): ReactNode {
  const props = propsPhrase(entry.props);

  return (
    <li className="min-w-0 rounded border border-line bg-canvas/40 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 break-all font-mono text-[11.5px] text-ink">{entry.role}</span>
        <span className="text-[12px] text-ink-dim">{familyProse(entry.family)}</span>
      </div>

      {props !== null && (
        <p className="mt-0.5 text-[11.5px] leading-snug text-ink-dim">animating {props}</p>
      )}

      {entry.parity ? (
        <p className="numeric mt-1 text-[11px] leading-snug text-ink-faint">
          {parityClauses(entry).join(" · ")}
        </p>
      ) : (
        /*
         * NO FIGURES ON THIS BRANCH, AND THAT IS THE WHOLE POINT OF IT. This
         * entry's `durationMs` is the window the sampler watched for, not a
         * declared animation, and its stagger and scroll ratio were never
         * compared against anything. Printing them beside a scroll reveal's
         * numbers would invent a measurement.
         */
        <p className="mt-1 text-[11.5px] leading-snug text-ink-dim">
          Seen to run. Nothing was measured about how it moves.
        </p>
      )}
    </li>
  );
}

/** The address that was read, as a link — this is a URL, never a host path. */
function ReadAddress({ spec }: { spec: ApiMotionSpec }): ReactNode {
  return (
    <>
      <a
        href={spec.url}
        target="_blank"
        rel="noreferrer"
        title={`Open ${spec.url} in a new tab — the page this reading was taken from`}
        className="break-all text-ink-dim underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink"
      >
        {spec.url}
      </a>
      <span className="text-ink-faint">{`, read ${formatClock(spec.capturedAt)}. `}</span>
    </>
  );
}

/**
 * The libraries found on the reference page.
 *
 * THE TWO SENTENCES AFTER THE LIST ARE GONE, 2026-08-05 ("That names what the
 * reference used. It is not an instruction to build with the same one."). The
 * first restated the clause in front of it — "found on the reference page" —
 * and the second answered a question this panel's reader is not asking: nobody
 * reading a record of what a page did is choosing a dependency, and the builder
 * who might be never sees this screen. The scope is carried by the words "on
 * the reference page", which is why they stayed in the line.
 */
function LibrariesNote({ libraries }: { libraries: readonly string[] }): ReactNode {
  if (libraries.length === 0) return null;
  return (
    <p className="text-[11.5px] leading-snug text-ink-dim">
      Motion libraries found on the reference page:{" "}
      <span className="font-mono text-[11px] text-ink">{libraries.join(", ")}</span>.
    </p>
  );
}

export function MotionReadoutPanel({
  motion,
}: {
  /**
   * `run.motion ?? null` — REQUIRED rather than optional, so the caller has to
   * state what a run recorded before this field existed means.
   * `exactOptionalPropertyTypes` is on, so an optional prop here would refuse
   * the `undefined` the flattening exists for. Same contract as
   * `TicketAttachmentsPanel`'s two lists.
   */
  motion: ApiMotionSpec | null;
}): ReactNode {
  // NOTHING AT ALL — no reading was taken for this run. See the header: this is
  // most tickets, and it is not the same fact as a reading that saw nothing.
  if (motion === null) return null;

  const nothingMoved = motion.entries.length === 0;

  return (
    <Panel
      title="Motion read from the reference"
      subtitle={
        <>
          <ReadAddress spec={motion} />
          {/*
           * THE SUBTITLE'S SECOND HALF IS BEHIND THE "i", 2026-08-05, AND BOTH
           * FACTS IN IT SURVIVE INTACT.
           *
           * "not an inventory of the page" changes what a reader concludes from
           * a SHORT list — motion below the sampled viewport, outside the
           * window, or behind a click is missing rather than absent — so it may
           * be hidden and may not be cut. The rounding sentence that used to sit
           * at the foot of the panel is in the same bubble for the same reason:
           * it changes what a reader DOES, because copying "250ms" into a
           * criterion as an exact value authors something no second reading can
           * satisfy. Two facts, one glyph, because the panel takes ONE reading
           * and both are properties of it.
           *
           * WHAT WAS DELETED RATHER THAN MOVED: "by sampling the rendered page
           * frame by frame" (how the reading was taken, which changes nothing a
           * reader does) and "Whether what was built matches any of it is the
           * run's verdict to answer, not this panel's" — that one both used the
           * banned word and described a consequence on a different panel.
           */}
          <span className="text-ink-dim">
            What moved on the page, watched once as the ticket was submitted.
          </span>
          <Explain about="this reading" className="ml-1" testId="explain-motion">
            A sample of what moved while the page was watched, not an inventory
            of the page. Times are rounded — to 50ms, and stagger to 20ms —
            because two readings of the same page do not agree more closely.
          </Explain>
        </>
      }
    >
      {nothingMoved ? (
        /*
         * A PAGE WAS READ AND NOTHING MOVED. Not `motion: null`, and the
         * difference is the reason this branch exists rather than returning
         * `null` for an empty list too.
         *
         * THE REDUCED-MOTION VERDICT IS DELIBERATELY OMITTED HERE. With no
         * observation for it to be about, `respectsReducedMotion: true` only
         * says a second reading of a page that already moved nothing also moved
         * nothing — printing it as "the reference honours the preference" would
         * be the panel claiming more than the data contains.
         */
        /*
         * SECOND SENTENCE MOVED BEHIND THE "i", 2026-08-05. On this branch it is
         * the whole story rather than a caveat: a reader who takes an empty
         * panel as "this page is still" has been misled by it, so the limit is
         * kept — hidden, not cut. The first sentence lost "inside the sampling
         * window", which the bubble now carries in words a reader has.
         */
        <p className="text-[12px] leading-relaxed text-ink-dim">
          This page was opened and watched, and nothing moved.
          <Explain about="what this reading saw" className="ml-1" testId="explain-still">
            It is not proof that the page is still. Motion outside the moment it
            was watched, or behind a click the reading never made, would not
            appear here.
          </Explain>
        </p>
      ) : (
        <div className="space-y-2.5">
          <ul className="space-y-1.5">
            {motion.entries.map((entry, index) => (
              <MotionRow
                // The wire carries no id, and two rows can share a role and a
                // family (two hover targets of the same shape), so position is
                // the only stable key. The list is re-rendered whole, never
                // reordered in place.
                key={`${entry.family}:${entry.role}:${String(index)}`}
                entry={entry}
              />
            ))}
          </ul>

          <LibrariesNote libraries={motion.libraries} />

          {/*
           * WHAT THE FLAG ACTUALLY MEANS, IN BOTH DIRECTIONS.
           * `probeReducedMotion` opens a second context at `reducedMotion:
           * "reduce"` and reports `true` only when it harvested nothing. Its
           * `catch` also returns `false`, so a failed second reading and a page
           * that kept moving arrive here identical — the false branch says so
           * rather than accusing the reference of ignoring the preference.
           */}
          <p className="text-[11.5px] leading-snug text-ink-dim">
            {motion.respectsReducedMotion
              ? "Read again with reduced motion switched on, this page moved nothing."
              : "Read again with reduced motion switched on, this page did not stop — or that second reading could not be taken. The record cannot tell those apart."}
          </p>

          {/*
           * THE ROUNDING PARAGRAPH THAT WAS HERE IS IN THE SUBTITLE'S "i",
           * 2026-08-05, and the reason it is kept at all is unchanged: every
           * figure above is a bucket, and a reader who copies one into a
           * criterion as an exact value authors something no second reading can
           * satisfy. Its second sentence — "Whether what was built matches any
           * of it is the run's verdict to answer, not this panel's" — is DELETED
           * rather than moved: it named a different panel's job, and this
           * panel's title already says the reading is of the reference.
           *
           * THIS BRANCH IS NOW SILENT, WHICH IS THE POINT. Both remaining lines
           * under the list state an observation; neither explains the panel.
           */}
        </div>
      )}
    </Panel>
  );
}
