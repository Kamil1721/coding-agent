/**
 * The model dropdown's three pure functions — the arithmetic a browser test can
 * only see one keystroke at a time.
 *
 * WHY THESE THREE AND NOT THE COMPONENT. `moveActive` is the entire keyboard
 * contract, and its interesting cases are edges: the first press with nothing
 * active, both ends of the list, a list of one, an empty list. Driving each of
 * those through a real page costs a navigation apiece and still only observes the
 * result through `aria-activedescendant`. `initialActive` decides whether opening
 * the list and pressing Enter changes the owner's model, which is a silent-damage
 * failure rather than a visible one. `selectionNotice` is the answer to "what does
 * a closed dropdown still have to say out loud" — the reason a run cannot start.
 *
 * WHAT IS NOT HERE, deliberately: that the component WIRES these up. Nothing in
 * this file would fail if `onKeyDown` ignored `moveActive` entirely, or if the
 * notice were computed and never rendered. `model-picker.browser.spec.ts` is the
 * half that measures the page, and both halves are needed — that suite cannot
 * enumerate these edges, and this one cannot see a component at all.
 */

import { expect, test } from "@playwright/test";

import {
  initialActive,
  moveActive,
  selectionNotice,
} from "../src/components/model-picker";
import type { ModelOption } from "../src/lib/api-types";

function model(id: string, available: boolean, reason: string | null = null): ModelOption {
  return { id, label: id.toUpperCase(), provider: "anthropic", tier: "included", available, reason };
}

const THREE: readonly ModelOption[] = [
  model("sonnet", true),
  model("opus", true),
  model("haiku", true),
];

/* ------------------------------------------------------------------ */
/* moveActive                                                          */
/* ------------------------------------------------------------------ */

test("the first ArrowDown lands on the first option, the first ArrowUp on the last", () => {
  // -1 is "nothing active yet". Opening with ArrowUp means "from the bottom",
  // and refusing to move (or moving to 0) would make the key a no-op for the one
  // reader who used it on purpose.
  expect(moveActive(3, -1, "ArrowDown")).toBe(0);
  expect(moveActive(3, -1, "ArrowUp")).toBe(2);
});

test("the ends are hard stops, not a cycle", () => {
  expect(moveActive(3, 2, "ArrowDown")).toBe(2);
  expect(moveActive(3, 0, "ArrowUp")).toBe(0);
});

test("Home and End reach either end from anywhere, including from nothing", () => {
  expect(moveActive(3, 1, "Home")).toBe(0);
  expect(moveActive(3, 1, "End")).toBe(2);
  expect(moveActive(3, -1, "Home")).toBe(0);
  expect(moveActive(3, -1, "End")).toBe(2);
});

test("a key this listbox does not own returns null so the page keeps it", () => {
  // The null is load-bearing: the component only calls `preventDefault` when a
  // key moved something. Returning 0 here would swallow Tab, typing and every
  // browser shortcut while the list is open.
  for (const key of ["Tab", "Enter", " ", "Escape", "a", "PageDown"]) {
    expect(moveActive(3, 0, key)).toBeNull();
  }
});

test("an empty list refuses every key rather than returning index 0", () => {
  // `models.length === 0` renders a sentence instead of a control, but the
  // arithmetic must not hand out an index into an empty array either way.
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    expect(moveActive(0, -1, key)).toBeNull();
  }
});

test("a list of one has nowhere to go and says so by staying put", () => {
  expect(moveActive(1, -1, "ArrowDown")).toBe(0);
  expect(moveActive(1, 0, "ArrowDown")).toBe(0);
  expect(moveActive(1, 0, "ArrowUp")).toBe(0);
});

/* ------------------------------------------------------------------ */
/* initialActive                                                       */
/* ------------------------------------------------------------------ */

test("opening starts on the CURRENT selection, so open-then-Enter changes nothing", () => {
  expect(initialActive(THREE, "opus")).toBe(1);
  expect(initialActive(THREE, "haiku")).toBe(2);
});

test("with nothing selected it starts on the first option that can actually be chosen", () => {
  // Starting on a disabled row would make the first Enter do nothing at all,
  // which reads as a broken control rather than as a refusal.
  const mixed = [model("default", false, "run `claude setup-token`"), model("sonnet", true)];
  expect(initialActive(mixed, null)).toBe(1);
});

test("when NOTHING can be chosen it still starts somewhere real", () => {
  const dead = [model("default", false, "run `claude setup-token`")];
  expect(initialActive(dead, null)).toBe(0);
  expect(initialActive([], null)).toBe(0);
});

test("a selected id the list does not contain falls back to the first usable row", () => {
  // The catalog is refetched on an interval; a selection can outlive its model.
  expect(initialActive(THREE, "kimi-k3")).toBe(0);
});

/* ------------------------------------------------------------------ */
/* selectionNotice                                                     */
/* ------------------------------------------------------------------ */

test("an available selection says nothing — no notice on the happy path", () => {
  expect(selectionNotice(THREE, "sonnet")).toBeNull();
  expect(selectionNotice([], null)).toBeNull();
});

test("an unavailable SELECTION shows its own reason, verbatim", () => {
  const models = [model("default", false, "Claude CLI reports no session. Run `claude setup-token`.")];
  expect(selectionNotice(models, "default")).toBe(
    "Claude CLI reports no session. Run `claude setup-token`.",
  );
});

test("THE LOGGED-OUT SCREEN: nothing selectable, nothing selected, and the cause is still stated", () => {
  // The real shape of `/api/models` with no CLI login: one row, unavailable, and
  // `pickDefaultModel` returns null so `value` is null. This is the case a
  // dropdown loses if nobody writes it down — the old radio list printed the
  // reason under the row it could not offer, and a collapsed control shows
  // neither the row nor the reason.
  const models = [model("default", false, "Claude CLI reports no authenticated session.")];
  expect(selectionNotice(models, null)).toBe(
    "No model in this list can run. Claude CLI reports no authenticated session.",
  );
});

test("a null selection with usable models is silent — that is a default about to resolve", () => {
  expect(selectionNotice(THREE, null)).toBeNull();
});

test("an unavailable model with a null reason still produces a sentence", () => {
  // `reason` is `string | null` on the wire. A blank notice would be a lie by
  // omission on the one screen that has to explain itself.
  expect(selectionNotice([model("default", false, null)], "default")).toBe(
    "Unavailable. The API gave no reason.",
  );
});
