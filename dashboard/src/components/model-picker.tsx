"use client";

/**
 * model-picker.tsx — one dropdown, and the reason it is not a `<select>`.
 *
 * THE OWNER ASKED FOR A DROPDOWN (2026-07-30). What was here before was a list
 * of radio rows grouped by billing tier, with each unavailable model's `reason`
 * printed under it. The grouping went with the metered vendors the owner removed
 * on the same day — one tier left is not a grouping — but the REASON did not, and
 * it is the whole reason this is a custom listbox rather than a native control.
 *
 * A `<select>` CANNOT CARRY THE REASON. `ModelOption` pairs `available: boolean`
 * with `reason: string`, and the honest rendering of an unavailable model is the
 * model AND its explanation. A `<option disabled>` has no room for a second line
 * and no way to expose one: its accessible name is its text content, so the
 * reason would have to be crammed into the label or dropped. Dropping it is the
 * failure mode this file exists to avoid — "why can't I pick that?" answered in
 * someone's memory instead of on the screen.
 *
 * TWO MORE THINGS A NATIVE SELECT COSTS HERE, both measured rather than assumed:
 * its popup is drawn by the OS, so it cannot be screenshotted with the page and
 * cannot be styled to this app's dark surface; and its option list cannot hold
 * the mono model id next to the label, which is the string that actually goes on
 * the wire.
 *
 * SO: the APG select-only combobox. `role="combobox"` on the button,
 * `role="listbox"` on the popup, `aria-activedescendant` moving over
 * `role="option"` rows while DOM focus never leaves the button.
 *
 * DISABLED OPTIONS ARE NAVIGABLE AND NOT SELECTABLE, and those are two separate
 * decisions:
 *   - navigable, because the reason lives inside the option element and is part
 *     of its accessible name. Skipping the row would read the model's existence
 *     to a screen-reader user and withhold the explanation, which is the
 *     sighted/non-sighted asymmetry this component is supposed to close.
 *   - not selectable, because `POST /api/runs` would refuse it with 409 anyway.
 *     `aria-disabled="true"` (never the `disabled` attribute — invalid on a
 *     `role="option"` div) plus a hard refusal in `commit`.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { ModelOption } from "@/lib/api-types";
import { Badge, Skeleton, cx } from "./ui";

/**
 * Where the active option moves for a navigation key, or `null` when the key is
 * not one this listbox owns.
 *
 * EXPORTED SO IT CAN BE TESTED AS ARITHMETIC. A browser test can only observe
 * this through `aria-activedescendant` one keystroke at a time; the edges — first
 * press with nothing active, both ends of the list, an empty list — are cheaper
 * and more completely covered here.
 *
 * IT DOES NOT WRAP, DELIBERATELY. APG makes wrapping optional, and a list whose
 * ends are hard stops tells a keyboard reader where they are: `ArrowDown` held
 * down settles on the last row instead of cycling forever past the one they
 * wanted. `Home`/`End` are the fast path to either end.
 *
 * `-1` MEANS "NOTHING ACTIVE YET", which is why the first `ArrowUp` lands on the
 * last option rather than refusing to move: opening upward from the bottom is
 * what the key means when nothing is active.
 */
export function moveActive(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp":
      return current < 0 ? last : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * Which option a freshly opened list should start on.
 *
 * The current selection, so that opening and pressing Enter is a no-op rather
 * than a silent change of model. With nothing selected it starts on the first
 * SELECTABLE row — landing on a row that cannot be chosen would make the first
 * Enter do nothing, which reads as a broken control.
 */
export function initialActive(models: readonly ModelOption[], value: string | null): number {
  const selected = models.findIndex((model) => model.id === value);
  if (selected !== -1) return selected;
  const firstUsable = models.findIndex((model) => model.available);
  return firstUsable === -1 ? 0 : firstUsable;
}

const NO_REASON = "Unavailable. The API gave no reason.";

/**
 * The line under the closed trigger, or `null` when there is nothing to say.
 *
 * A DROPDOWN HIDES WHAT IT IS NOT SHOWING, AND THIS IS THE PART THAT MAY NOT BE
 * HIDDEN. The radio list this replaced printed every reason at once. Two cases
 * survive the collapse:
 *
 *   1. THE SELECTED MODEL CANNOT RUN — its reason is why the Start button is
 *      dead, so it belongs next to the control, not one click inside it.
 *   2. NOTHING IN THE LIST CAN RUN, which is exactly what the owner sees with the
 *      Claude CLI logged out: `/api/models` returns one unavailable row,
 *      `pickDefaultModel` finds nothing to select, and the trigger says "No model
 *      selected". Without this line that screen states a problem and withholds
 *      its cause. The rows all share one cause (no login), so the first reason is
 *      the reason.
 */
export function selectionNotice(
  models: readonly ModelOption[],
  value: string | null,
): string | null {
  const selected = models.find((model) => model.id === value) ?? null;
  if (selected !== null) return selected.available ? null : (selected.reason ?? NO_REASON);
  if (models.length === 0) return null;
  if (models.some((model) => model.available)) return null;
  const first = models[0];
  if (first === undefined) return null;
  return `No model in this list can run. ${first.reason ?? NO_REASON}`;
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "ml-auto shrink-0 font-mono text-[10px] leading-none text-ink-faint transition-transform duration-150 motion-reduce:transition-none",
        open && "rotate-180",
      )}
    >
      {/* A glyph, not an SVG: this app ships no icon set, and a hand-rolled
          triangle path would be the first one. */}
      ▾
    </span>
  );
}

function OptionRow({
  model,
  id,
  selected,
  active,
  onPick,
}: {
  model: ModelOption;
  id: string;
  selected: boolean;
  active: boolean;
  onPick: () => void;
}): ReactNode {
  const disabled = !model.available;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      // NOT `disabled`. That attribute does nothing on a div and, worse, tells a
      // reader nothing: `aria-disabled` is what removes the row from the set of
      // choices while leaving it announced and navigable.
      aria-disabled={disabled || undefined}
      // Focus stays on the combobox button (activedescendant pattern), so the
      // mousedown that would move it is cancelled before the click lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
      className={cx(
        "flex cursor-pointer items-start gap-2 px-2.5 py-1.5 transition-colors",
        disabled && "cursor-not-allowed",
        // ACTIVE AND SELECTED ARE DIFFERENT STATES AND LOOK DIFFERENT. Active is
        // where the keyboard is; selected is what the form will submit. Collapsing
        // them would make arrowing over the list look like it had already changed
        // the answer.
        active ? "bg-accent-dim/35" : "hover:bg-surface-raised",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "mt-[3px] w-3 shrink-0 font-mono text-[11px] leading-none",
          selected ? "text-accent" : "text-transparent",
        )}
      >
        ✓
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cx(
              "text-[13px] font-medium",
              disabled ? "text-ink-faint" : "text-ink",
            )}
          >
            {model.label}
          </span>
          <code className="font-mono text-[11px] text-ink-faint">{model.id}</code>
          {disabled && <Badge tone="warn">unavailable</Badge>}
        </span>
        {disabled && (
          // INSIDE THE OPTION ON PURPOSE. `role="option"` computes its accessible
          // name from its contents, so a reason rendered here is read out with the
          // model. A sibling line outside the option would be visible to a sighted
          // reader and absent for everyone else — a difference no test that only
          // queries the DOM would catch.
          <span className="mt-1 block text-[11.5px] leading-snug text-warn">
            {model.reason ?? NO_REASON}
          </span>
        )}
      </span>
    </div>
  );
}

export function ModelPicker({
  models,
  isLoading,
  errorText,
  value,
  onChange,
}: {
  models: readonly ModelOption[] | undefined;
  isLoading: boolean;
  errorText: string | null;
  value: string | null;
  onChange: (id: string) => void;
}): ReactNode {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-option-${String(index)}`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const options: readonly ModelOption[] = models ?? [];
  const selected = options.find((model) => model.id === value) ?? null;
  const notice = selectionNotice(options, value);

  const close = useCallback((focusTrigger: boolean): void => {
    setOpen(false);
    setActive(-1);
    // THE FOCUS COMES BACK. A dropdown that closes and leaves focus nowhere
    // strands a keyboard reader at the top of the document.
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const openList = useCallback(
    (startAt?: number): void => {
      if (options.length === 0) return;
      setActive(startAt ?? initialActive(options, value));
      setOpen(true);
    },
    [options, value],
  );

  const commit = useCallback(
    (index: number): void => {
      const model = options[index];
      if (model === undefined) return;
      // THE REFUSAL. An unavailable model cannot be chosen from here at all —
      // not "chosen and then blocked at submit". `page.tsx` blocks submission as
      // well, and both are wanted: this one keeps the form's state honest, that
      // one covers a selection that was valid when it was made and stopped being
      // valid when the catalog refreshed.
      if (!model.available) return;
      onChange(model.id);
      close(true);
    },
    [options, onChange, close],
  );

  // Pointer outside closes. `pointerdown` rather than `click`, so the list is
  // gone before whatever was clicked reacts.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && wrapRef.current?.contains(target) === true) return;
      setOpen(false);
      setActive(-1);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // The active row stays on screen. `block: "nearest"` so a list that already
  // shows the row does not jump.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const node = listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  });

  // AND THE LIST ITSELF, ON OPEN. FOUND IN A 375px SCREENSHOT, not by reasoning:
  // the picker is the last panel in a stacked single column on a phone, so a list
  // that opens downward rendered almost entirely below the fold — one and a half
  // rows visible, four models the owner could not see and had to know to scroll
  // for. `block: "nearest"` scrolls the page the minimum distance that puts the
  // whole popup on screen and does nothing at all when it already fits, so the
  // desktop layout is untouched. Not `behavior: "smooth"`: this is a scroll the
  // reader did not ask for, and animating it would be movement for its own sake.
  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const key = event.key;

    if (key === "Escape") {
      // Closes WITHOUT COMMITTING, which is the whole contract of Escape. Guarded
      // on `open` so that Escape in a closed picker is left to the page.
      if (open) {
        event.preventDefault();
        close(true);
      }
      return;
    }

    if (key === "Tab") {
      // Let focus leave, but do not leave a floating list behind it.
      if (open) close(false);
      return;
    }

    if (key === "Enter" || key === " ") {
      // ALWAYS preventDefault: this button lives inside the ticket form, and
      // Enter on a `<button>` in a form submits it. A dropdown that queues a run
      // because someone pressed Enter to open it would be the worst bug in here.
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      commit(active);
      return;
    }

    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        openList(moveActive(options.length, -1, key) ?? undefined);
      }
      return;
    }

    const next = moveActive(options.length, active, key);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  if (errorText !== null && models === undefined) {
    return (
      <p className="rounded border border-warn/40 bg-warn-dim/50 px-3 py-2 text-[12px] text-warn">
        Cannot load the model list: {errorText}
      </p>
    );
  }

  if (models === undefined) {
    return isLoading ? <Skeleton rows={2} /> : null;
  }

  if (models.length === 0) {
    return (
      <p className="text-[12px] text-ink-faint">
        The API returned no models. Nothing can be submitted until at least one is
        available.
      </p>
    );
  }

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        // `type="button"`, load-bearing: see the Enter handling above.
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        // Matches the panel heading this control sits under, so the visible label
        // and the announced one are the same word.
        aria-label="Model"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
        className={cx(
          "flex w-full items-center gap-2 rounded-sm border px-2.5 py-1.5 text-left transition-colors",
          "border-line-strong bg-surface-raised hover:border-ink-faint",
          open && "border-accent/60",
        )}
      >
        {selected === null ? (
          <span className="truncate text-[13px] text-ink-faint">
            {/* Reachable state, not a placeholder: with no CLI login every row is
                unavailable, `pickDefaultModel` returns null, and this is what the
                owner sees. */}
            No model selected
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cx(
                "truncate text-[13px] font-medium",
                selected.available ? "text-ink" : "text-ink-faint",
              )}
            >
              {selected.label}
            </span>
            <code className="font-mono text-[11px] text-ink-faint">{selected.id}</code>
            {!selected.available && <Badge tone="warn">unavailable</Badge>}
          </span>
        )}
        <Chevron open={open} />
      </button>

      {/* `role="status"` because it appears without the reader having moved. See
          `selectionNotice` for which two cases reach here and why. */}
      {notice !== null && (
        <p role="status" className="mt-1.5 text-[11.5px] leading-snug text-warn">
          {notice}
        </p>
      )}

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Model"
          className={cx(
            "picker-popup absolute left-0 right-0 top-full z-30 mt-1 max-h-[min(320px,52vh)] overflow-y-auto",
            "rounded border border-line-strong bg-surface shadow-[0_12px_28px_-12px_rgba(0,0,0,0.85)]",
          )}
        >
          {options.map((model, index) => (
            <OptionRow
              key={model.id}
              model={model}
              id={optionId(index)}
              selected={model.id === value}
              active={index === active}
              onPick={() => commit(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
