"use client";

/**
 * rail.tsx — the left icon rail, and the one panel it opens.
 *
 * WHAT THIS REPLACED, IN THE OWNER'S WORDS: "but this looks terrible and needs to
 * be changed. I suggest designing some icons with the taste agent that then will
 * sit on the left side of the canva and when I click them they expand into
 * different things. Like chat, [VS Code's activity bar], the index where the code
 * structure is. Maybe like a overview of the project and what has been entered."
 *
 * What was there: a permanently-visible stack down the left — the run chip, a
 * `chat` button, and whatever notices and dialogue panels the run's state added —
 * plus a SECOND navigation on the right, a 560px sheet with seven tabs behind a
 * button reading "run detail". Two places to look for run-level facts, one of them
 * always on screen whether or not anyone was reading it.
 *
 * Now: one rail, always visible, 48px wide, and exactly one panel open at a time.
 *
 * THE ICONS ARE ASSETS, NOT AN ICON LIBRARY AND NOT HAND-WRITTEN SVG PATHS. They
 * live in `public/rail/`, drawn for this product, and the build that produced them
 * is recorded in `docs/superpowers/specs/2026-08-04-icon-rail.md` §1. Every mark is
 * a WHITE GLYPH WHOSE ALPHA IS THE DRAWING, painted through a CSS mask with
 * `background-color: currentColor` — so the asset carries no hue at all and the
 * button's own state rules do the tinting. The seven role hues in `roles.ts` stay
 * the exclusive property of the canvas; an icon here cannot fight them because it
 * has no colour to fight with.
 *
 * THE MASK TRAP, WHICH IS SILENT WHEN IT FIRES. A CSS mask image will not load
 * cross-origin or from a `file://` page: the buttons stay clickable, the tooltips
 * still work, and the rail goes blank. Served from Next's own `public/` on the
 * same origin it renders correctly. `rail.browser.spec.ts` asserts both the
 * computed `mask-image` AND that every URL inside it answers 200, because the
 * computed value alone is the DECLARED string and stays non-`none` even when the
 * file behind it is gone.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button, cx } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* What the rail can open                                              */
/* ------------------------------------------------------------------ */

export type RailPanelId =
  | "questions"
  | "overview"
  | "chat"
  | "files"
  | "result"
  | "activity";

interface RailEntry {
  readonly id: RailPanelId;
  /** The word on the panel header, and the accessible name's first word. */
  readonly label: string;
  /** The asset stem under `public/rail/`. */
  readonly icon: string;
  /**
   * The whole sentence, on `aria-label` AND on `title`.
   *
   * An icon-only rail with no text affordance is a guessing game, so the tooltip
   * is not polish — it is the only place the label is written down for a reader
   * who has not learned the marks yet.
   */
  readonly hint: string;
}

/**
 * THE LABELS ARE THE PLAIN-ENGLISH MAPPING, and each one is a decision.
 *
 * Seven tabs (`ticket`, `chat`, `verdict`, `code`, `agents`, `env`, `trace`) became
 * five entries plus one conditional. What was buried and where it went:
 *
 *   · `ticket` → Overview, section "What you asked for".
 *   · `env` (whose tab label was already "Run") → Overview, "Machine and cost".
 *     The word "Env" is gone from this app entirely. "The machine it ran on and
 *     what it cost" is a property of the run, and Overview IS the run; it was
 *     never a peer of Chat.
 *   · `agents` → Overview, "Who worked on it". The roster component is unmodified
 *     and still selects cards on the canvas — the job `sheet.tsx` documented for
 *     it ("the faster read when you already know the name") is preserved whole.
 *     It is not a rail entry because the canvas IS the agent list, and an icon
 *     that opens a list of the things already drawn on screen is the definition of
 *     a redundant entry.
 *
 * "Verdict" → **Result**, and deliberately NOT "Checks": that panel also carries
 * the artifact path and the published copy, so "Checks" would be inaccurate about
 * half of it. A friendly label that misleads is worse than the jargon it replaced.
 *
 * "Trace" → **Activity**, not "Log" and not "History". It is the event record AND
 * a live tail with a reconnect control; "Activity" is the only plain word that
 * covers both.
 *
 * Checked against the copy test at `server/src/graph.test.ts` — its banned list is
 * `seat`, `digest`, `suite`, `freeze`, and none of them appears in any label,
 * eyebrow or hint here. That test is not touched or weakened by this file.
 *
 * AND THE LABELS WERE ONLY EVER HALF OF IT — 2026-08-05. Renaming these six
 * entries left the panel BODIES untouched, so "Not the design references on the
 * Verdict tab", "Whether a seat was given the text is the run's trace to answer"
 * and a card headed TRACE inside Activity all survived a rename that had deleted
 * the surfaces they named, with every check green. `tests/panel-copy.browser.spec.ts`
 * is the guard for the other half: it opens every entry below, subtracts the text
 * the RUN supplied (the ticket, the chat, the criteria statements, the server's
 * failure cause — a check that reddens on the owner's own prose is a check that
 * gets deleted) and applies the banned list to what is left, which is the copy
 * this product writes about itself.
 */
/**
 * THE HINTS WERE CUT TO ONE CLAUSE EACH — 2026-08-05.
 *
 * A tooltip is not a place to explain a panel; it is the NAME of an icon, and the
 * panel behind it is one click away and says everything the second sentence said.
 * Four of the six carried a trailing sentence describing what the reader would
 * find AFTER opening it — "Opens by itself when it is waiting on one", "The panel
 * says whether it is delivered live or queued", "The raw record" — which is the
 * "consequence of an action not yet taken" case exactly. Deleted, all four.
 *
 * NONE OF THEM MOVES BEHIND AN `<Explain>`, and that is a rule rather than an
 * omission: `explain.tsx` names this surface as the one place a `title` is
 * CORRECT, because a one-word name for an icon-only button is what `title` is
 * for. An `i` glyph on a 24px mask inside a 48px rail would be a second control
 * six times over.
 *
 * WHAT SURVIVES IS THE MAPPING. Every hint still opens with the panel's own word
 * and still says, in the reader's language, what is behind the icon — which is
 * the whole load an icon-only rail puts on its tooltips. `Result` keeps all three
 * of its clauses because each one names a section that is actually in that panel
 * (the outcome notice, the criteria, the two paths) and dropping any of them
 * would make the icon look narrower than it is.
 */
const ENTRIES: readonly RailEntry[] = [
  {
    id: "questions",
    label: "Questions",
    icon: "questions",
    hint: "Questions — what this run asked you, and your answers.",
  },
  {
    id: "overview",
    label: "Overview",
    icon: "overview",
    hint: "Overview — how this run went, and what you asked for.",
  },
  {
    id: "chat",
    label: "Chat",
    icon: "chat",
    hint: "Chat — send this run an instruction or a reference image.",
  },
  {
    id: "files",
    label: "Files",
    icon: "files",
    hint: "Files — the run's workspace, read-only.",
  },
  {
    id: "result",
    label: "Result",
    icon: "result",
    hint: "Result — whether it passed, what it was checked against, and where the work landed.",
  },
  {
    id: "activity",
    label: "Activity",
    icon: "activity",
    hint: "Activity — every event this run sent, oldest first.",
  },
];

/** Looked up by the page so a panel header and its rail button cannot drift. */
export const RAIL_LABEL: Readonly<Record<RailPanelId, string>> = Object.fromEntries(
  ENTRIES.map((entry) => [entry.id, entry.label]),
) as Readonly<Record<RailPanelId, string>>;

/**
 * Pinned to the bottom of the rail, under the flex spacer.
 *
 * Activity is the raw record — the thing you go to last and least — so it sits
 * where a reader's eye lands last, the same place VS Code puts its settings gear.
 */
const BOTTOM: RailPanelId = "activity";

/* ------------------------------------------------------------------ */
/* The mask                                                            */
/* ------------------------------------------------------------------ */

/**
 * One asset per mark per DPI, and both the prefixed and unprefixed properties.
 *
 * Chromium still needs `-webkit-mask-image` on some paths and Safari needs it
 * outright, so writing only the standard property is how the rail goes blank on
 * somebody else's machine.
 *
 * THE `1x` SLOT POINTS AT `-48.png`, NOT `-24.png`, AND THAT IS A CORRECTION MADE
 * AFTER LOOKING AT IT. The asset set ships all three sizes and its own notes say
 * the 24px master "is legible but visibly softer — a 1024px master resolved to 24
 * pixels carries more antialiasing smear than the same glyph resolved to 48 and
 * then halved by the browser", with this exact one-line fix named as the remedy.
 * Screenshotted at `deviceScaleFactor: 1` the -24 masters read mushy in the ink of
 * the mark; the browser's own downscale of -48 does not. Nothing was redrawn.
 */
function maskStyle(stem: string): CSSProperties {
  const image = [
    `image-set(url("/rail/${stem}-48.png") 1x,`,
    `url("/rail/${stem}-48.png") 2x,`,
    `url("/rail/${stem}-72.png") 3x)`,
  ].join(" ");
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskSize: "24px 24px",
    WebkitMaskSize: "24px 24px",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  } as CSSProperties;
}

/* ------------------------------------------------------------------ */
/* The dot on the Overview icon                                        */
/* ------------------------------------------------------------------ */

export type RailDot = "live" | "warn" | "fail" | "pass" | null;

const DOT_CLASS: Readonly<Record<"live" | "warn" | "fail" | "pass", string>> = {
  live: "bg-accent motion-safe:animate-pulse",
  warn: "bg-warn",
  fail: "bg-fail",
  pass: "bg-pass",
};

/**
 * The one piece of the old always-visible run chip that survives as CHROME rather
 * than as panel content.
 *
 * A rail with everything closed would otherwise say nothing at all about how the
 * run is going, and "how is it going" is the question this screen is opened to
 * answer. The 2px ring in `--color-surface` is what stops the dot merging into the
 * glyph behind it.
 *
 * `motion-safe:` on the live pulse: under `prefers-reduced-motion` the colour
 * stays and the animation goes. That is the whole of this design's motion budget —
 * the rail does not slide, the panel does not spring, the icons do not animate.
 */
function StatusDot({ tone }: { tone: "live" | "warn" | "fail" | "pass" }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "absolute right-[6px] top-[7px] size-1.5 rounded-full ring-2 ring-surface",
        DOT_CLASS[tone],
      )}
    />
  );
}

/* ------------------------------------------------------------------ */
/* The rail and its panel                                              */
/* ------------------------------------------------------------------ */

export interface RailProps {
  /** Which panel is open, or `null` for none. */
  readonly open: RailPanelId | null;
  readonly onOpen: (next: RailPanelId | null) => void;
  /**
   * The Questions BUTTON renders only when there is a dialogue to show.
   *
   * Its 44px SLOT is reserved either way — see the render below. An entry with
   * nothing to show is absent rather than greyed out; no rail entry is ever
   * disabled.
   */
  readonly showQuestions: boolean;
  readonly statusDot: RailDot;
  readonly questionsDot: RailDot;
  /** The panel's header. Title is the label; eyebrow is the run's own word. */
  readonly panelTitle: string;
  readonly panelEyebrow: string;
  readonly children: ReactNode;
}

export function RunRail({
  open,
  onOpen,
  showQuestions,
  statusDot,
  questionsDot,
  panelTitle,
  panelEyebrow,
  children,
}: RailProps): ReactNode {
  const buttons = useRef<Map<RailPanelId, HTMLButtonElement>>(new Map());
  const panel = useRef<HTMLDivElement | null>(null);

  /*
   * DRAG-TO-RESIZE — owner's ask, 2026-08-18: "I cant actually see the codebase"
   * at a fixed 400px. The width is a number in state once the reader has ever
   * dragged, and stays the stylesheet's own 400px until then, so nothing changes
   * for anyone who never touches the handle.
   *
   * CLAMPED, AND BOTH ENDS ARE REASONED: 320 is the floor the file pane's own
   * docblock already assumes ("must not assume a width above 320px" — the panel
   * bodies were written against it); the ceiling leaves the canvas 480px,
   * because a rail that can eat the whole screen is a second full-screen page
   * wearing a resize handle.
   *
   * PERSISTED per machine, not per run — the reader's screen is the thing the
   * number belongs to. Read lazily so SSR never touches localStorage.
   */
  const [railWidth, setRailWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = Number(window.localStorage.getItem("run-rail-width"));
    // Below the floor is not honoured: 320 was the old floor, and Safari CLIPS
    // where Chromium wraps at that width — a stored 320 painted a cut-off panel
    // on the owner's machine (measured 2026-08-18). Invalid falls back to 400.
    return Number.isFinite(stored) && stored >= 360 ? stored : null;
  });

  const clampWidth = useCallback((px: number): number => {
    const ceiling = Math.max(360, Math.min(960, window.innerWidth - 480));
    return Math.min(ceiling, Math.max(360, px));
  }, []);

  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const node = panel.current;
      if (node === null) return;
      const left = node.getBoundingClientRect().left;
      const handle = event.currentTarget;
      // Capture is an optimisation — the window listeners below do the real
      // tracking — and it THROWS for a pointer the browser is not holding
      // (synthetic events, some pen drivers). A resize that dies on that is a
      // resize that works on exactly one input stack.
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* tracked by the window listeners */
      }
      const move = (ev: PointerEvent): void => {
        setRailWidth(clampWidth(ev.clientX - left));
      };
      const up = (ev: PointerEvent): void => {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          /* never captured */
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setRailWidth((width) => {
          if (width !== null) window.localStorage.setItem("run-rail-width", String(width));
          return width;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [clampWidth],
  );

  // Keyboard resize on the separator: arrows step 24px, Home returns to default.
  const onResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const step =
        event.key === "ArrowRight" ? 24 : event.key === "ArrowLeft" ? -24 : null;
      if (step !== null) {
        event.preventDefault();
        setRailWidth((width) => {
          const next = clampWidth((width ?? 400) + step);
          window.localStorage.setItem("run-rail-width", String(next));
          return next;
        });
      } else if (event.key === "Home") {
        event.preventDefault();
        window.localStorage.removeItem("run-rail-width");
        setRailWidth(null);
      }
    },
    [clampWidth],
  );

  const present = ENTRIES.filter(
    (entry) => entry.id !== "questions" || showQuestions,
  );

  /*
   * ROVING TABINDEX: exactly one rail button is in the tab order at a time — the
   * selected one, else the first present entry. Six tab stops for six buttons in
   * a 48px column would make Tab past the rail cost six presses on every visit.
   */
  const roving =
    open !== null && present.some((entry) => entry.id === open)
      ? open
      : (present[0]?.id ?? null);

  const focusEntry = useCallback((id: RailPanelId): void => {
    buttons.current.get(id)?.focus();
  }, []);

  /*
   * ArrowUp/ArrowDown move between rail buttons AND WRAP; Home/End jump to the
   * ends. Wrapping is what makes a vertical toolbar navigable without counting:
   * one more ArrowDown from the bottom is the top.
   */
  const onRailKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const order = present.map((entry) => entry.id);
      const active = document.activeElement;
      const index = order.findIndex((id) => buttons.current.get(id) === active);
      if (index === -1) return;
      const last = order.length - 1;
      let next = -1;
      switch (event.key) {
        case "ArrowDown":
          next = index === last ? 0 : index + 1;
          break;
        case "ArrowUp":
          next = index === 0 ? last : index - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        default:
          return;
      }
      const target = order[next];
      if (target === undefined) return;
      event.preventDefault();
      focusEntry(target);
    },
    [present, focusEntry],
  );

  /*
   * Opening a panel moves focus INTO it, so Escape works without a click first and
   * a screen reader is told something appeared. `preventScroll` because the panel
   * lives inside a fixed-height, `overflow-hidden` run view and scrolling it into
   * view would shift the whole page by a pixel.
   *
   * Keyed on `open`, not on mount: switching from Chat to Files is the same event
   * as opening Files, and a reader who arrives on a panel by keyboard must land in
   * the thing they just opened.
   */
  useEffect(() => {
    if (open === null) return;
    panel.current?.focus({ preventScroll: true });
  }, [open]);

  /*
   * Escape inside the panel closes it and returns focus to the button that opened
   * it — otherwise closing with the keyboard drops the reader at the top of the
   * document. The listener is on the panel rather than on the window for the same
   * reason `sheet.tsx` gives: Escape on a canvas card already means "clear the
   * selection", and a window listener would fire both.
   */
  const onPanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Escape") return;
      /*
       * A PORTAL RENDERED FROM INSIDE THIS PANEL STILL BUBBLES THROUGH IT, and
       * that is not a hypothetical: `design-directions.tsx`'s `ChooserLayer` is a
       * `createPortal` to `document.body` with a `window` Escape listener of its
       * own, and it is mounted by the Questions panel. React propagates synthetic
       * events along the REACT tree, not the DOM tree, so its keypresses arrive
       * here — and one Escape closed the comparison layer AND this panel, which
       * `design-lock.browser.spec.ts` catches as "the owner asks for his image
       * back and loses the three directions he was reading it against".
       *
       * The DOM containment check is the fix: an event whose target is not
       * physically inside this panel belongs to whatever is on top of it.
       */
      const target = event.target;
      if (target instanceof Node && panel.current?.contains(target) !== true) return;
      event.stopPropagation();
      const returning = open;
      onOpen(null);
      if (returning !== null) focusEntry(returning);
    },
    [open, onOpen, focusEntry],
  );

  const closePanel = useCallback((): void => {
    const returning = open;
    onOpen(null);
    if (returning !== null) focusEntry(returning);
  }, [open, onOpen, focusEntry]);

  return (
    <>
      <div
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Run panels"
        data-testid="run-rail"
        onKeyDown={onRailKeyDown}
        /*
         * `z-30` puts the rail above the panel's shadow at narrow widths, where
         * the panel overlays the canvas and its shadow would otherwise fall
         * across the rail's own right border.
         */
        className="relative z-30 flex w-12 shrink-0 flex-col border-r border-line bg-surface py-1.5"
      >
        {/*
         * THE QUESTIONS SLOT IS RESERVED WHETHER OR NOT THERE IS A DIALOGUE, and
         * that is a positional argument rather than a cosmetic one. An icon-only
         * rail lives entirely on position memory; if the button were merely
         * absent, every other icon would slide 44px up and down as a run
         * progresses. An empty 44px at the top reads as padding. A sliding rail
         * reads as broken.
         *
         * ITS SEPARATOR IS NOT RESERVED. The rule renders only when the button
         * does — a hairline with 44px of nothing above it reads as a rendering
         * fault, which is the same failure the full-bleed button shape avoids.
         */}
        <div className="h-11 shrink-0">
          {showQuestions && (
            <RailButton
              entry={ENTRIES[0] as RailEntry}
              open={open}
              roving={roving}
              onOpen={onOpen}
              dot={questionsDot}
              register={buttons}
            />
          )}
        </div>
        {showQuestions && <div className="mx-2.5 my-1.5 h-px shrink-0 bg-line" />}

        {present
          .filter((entry) => entry.id !== "questions" && entry.id !== BOTTOM)
          .map((entry) => (
            <RailButton
              key={entry.id}
              entry={entry}
              open={open}
              roving={roving}
              onOpen={onOpen}
              dot={entry.id === "overview" ? statusDot : null}
              register={buttons}
            />
          ))}

        <div className="flex-1" />
        <div className="mx-2.5 my-1.5 h-px shrink-0 bg-line" />
        {present
          .filter((entry) => entry.id === BOTTOM)
          .map((entry) => (
            <RailButton
              key={entry.id}
              entry={entry}
              open={open}
              roving={roving}
              onOpen={onOpen}
              dot={null}
              register={buttons}
            />
          ))}
      </div>

      {/*
       * THE PANEL IS MOUNTED EVEN WHEN IT IS CLOSED, and `hidden` is the whole
       * mechanism rather than a shortcut.
       *
       * The chat composer's draft text lives in `OrchestratorChat`'s own state and
       * that component takes no `value`/`onChange` pair, so the only way not to
       * throw away a half-typed instruction when the reader clicks Files — or
       * closes the panel entirely — is to leave the subtree mounted. `hidden` is
       * the HTML attribute, so this is `display: none`: out of the layout, out of
       * the tab order, out of the accessibility tree, still mounted, draft intact.
       *
       * WHAT STAYS CONDITIONAL, because it must: the caller renders the Files and
       * Result bodies only for their own panel. `CodeBrowser` fetches on mount and
       * an always-mounted one would pull a workspace tree on every run view.
       *
       * THE PUSH/OVERLAY SWITCH IS A MEDIA QUERY, NOT A MEASUREMENT. At 1120px and
       * up the panel is a flex sibling and PUSHES the canvas — the owner's whole
       * complaint is that the canvas is crowded out, and a push keeps every node
       * visible at a smaller zoom where an overlay would hide the ones he is
       * looking at. 48 + 400 + 672 = 1120, so the canvas never goes below 672px.
       * Below that there is nothing to push into and it overlays instead, with no
       * scrim: the canvas behind stays readable and clickable.
       */}
      <div
        ref={panel}
        id="rail-panel"
        data-testid="rail-panel"
        hidden={open === null}
        tabIndex={-1}
        role="region"
        aria-label={panelTitle}
        onKeyDown={onPanelKeyDown}
        className={cx(
          "absolute inset-y-0 left-12 z-20 flex w-[min(400px,calc(100vw-48px))] flex-col overflow-x-hidden",
          "border-r border-line bg-surface shadow-[24px_0_48px_-32px_rgba(0,0,0,0.9)]",
          "min-[1120px]:relative min-[1120px]:z-auto min-[1120px]:w-[400px] min-[1120px]:shrink-0 min-[1120px]:shadow-none",
        )}
        /* A dragged width wins over both stylesheet widths; `maxWidth` keeps a
           stored desktop width from covering a phone. */
        style={railWidth === null ? undefined : { width: railWidth, maxWidth: "calc(100vw - 48px)" }}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <div className="min-w-0">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
              {panelEyebrow}
            </p>
            {/*
             * AN `h2`, NOT AN `h1`. The run page carries exactly one `h1` — the
             * ticket's own name — and it is rendered by the page whether or not a
             * panel is open, so a run view with everything closed is still a
             * document with a title.
             */}
            <h2 className="truncate text-[13.5px] font-semibold text-ink">{panelTitle}</h2>
          </div>
          <Button variant="ghost" onClick={closePanel} title="Close (Escape)">
            close
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {/*
         * THE HANDLE: a 10px strip straddling the right border. `role=separator`
         * with the panel as its control; arrows resize, Home resets — stated in
         * the title because a resize handle with no affordance is a rumour.
         */}
        <div
          data-testid="rail-resize"
          role="separator"
          aria-orientation="vertical"
          aria-controls="rail-panel"
          aria-valuenow={railWidth ?? 400}
          aria-valuemin={360}
          tabIndex={0}
          title="Drag to resize. Arrow keys resize, Home resets."
          onPointerDown={beginResize}
          onKeyDown={onResizeKeyDown}
          className="group absolute -right-[5px] inset-y-0 z-30 flex w-[10px] cursor-col-resize items-center justify-center outline-none"
        >
          {/* The grip is visible AT REST — an invisible handle is a rumour, and
              the owner measured it as one ("I cant see the drag working"). */}
          <span
            aria-hidden
            className="h-[44px] w-[3px] rounded-full bg-line-strong transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
          />
        </div>
      </div>
    </>
  );
}

function RailButton({
  entry,
  open,
  roving,
  onOpen,
  dot,
  register,
}: {
  entry: RailEntry;
  open: RailPanelId | null;
  roving: RailPanelId | null;
  onOpen: (next: RailPanelId | null) => void;
  dot: RailDot;
  register: React.RefObject<Map<RailPanelId, HTMLButtonElement>>;
}): ReactNode {
  const selected = open === entry.id;
  return (
    <button
      type="button"
      ref={(element) => {
        if (element === null) register.current.delete(entry.id);
        else register.current.set(entry.id, element);
      }}
      data-testid={`rail-${entry.id}`}
      /*
       * SELECTED IS ANNOUNCED, NOT ONLY DRAWN. Everything in the class list below
       * is paint, and a screen-reader user gets none of it — six equally-shaped
       * buttons with no indication of which panel is open would be a worse rail
       * than the stack it replaces.
       */
      aria-expanded={selected}
      aria-controls="rail-panel"
      aria-label={entry.hint}
      title={entry.hint}
      tabIndex={roving === entry.id ? 0 : -1}
      onClick={() => onOpen(selected ? null : entry.id)}
      /*
       * FULL-BLEED, RADIUS 0 — the one place this app's `rounded-sm` control shape
       * is deliberately not used. Measured in the mock: a rounded 44px chip inside
       * a 48px rail leaves a 2px sliver of rail surface either side that reads as
       * a rendering bug. A strip is the correct shape for an edge rail.
       *
       * `outline-offset:-2px` IS NOT A PREFERENCE EITHER. The global focus rule is
       * `outline: 2px solid accent; outline-offset: 1px`, and on a button flush to
       * the window's left edge the outer ring is clipped by the window — the focus
       * ring showed as three sides. Inset it and it is a rectangle again.
       */
      className={cx(
        "relative flex h-11 w-12 shrink-0 items-center justify-center",
        "transition-colors duration-[120ms] active:translate-y-px",
        "[outline-offset:-2px]",
        selected
          ? "bg-surface-raised text-ink"
          : "text-ink-dim hover:bg-surface-raised hover:text-ink",
      )}
    >
      {/*
       * SELECTED IS DOUBLE-CODED — accent bar, raised background, brighter ink —
       * because 2px of colour on a 48px rail is not enough on its own, and a
       * missed selection state costs a click into the wrong panel.
       */}
      {selected && (
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-0 top-2 w-[2px] bg-accent"
        />
      )}
      <span
        aria-hidden="true"
        data-testid={`rail-icon-${entry.id}`}
        // `background-color: currentColor` is what paints the glyph: the mask is
        // the shape, the button's own text colour is the ink.
        className="block size-6 bg-current"
        style={maskStyle(entry.icon)}
      />
      {dot !== null && <StatusDot tone={dot} />}
    </button>
  );
}
