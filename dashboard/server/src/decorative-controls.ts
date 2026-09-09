import type { CreativeSectionV1 } from "./creative-contract.js";

export interface DecorativeLookalike {
  readonly selector: string;
  readonly kind: "control" | "indicator";
  readonly text: string;
}
export interface DecorativeControlSnapshot {
  readonly focusableCount: number | null;
  readonly lookalikes: readonly DecorativeLookalike[];
}
export interface DecorativeControlFinding {
  readonly sectionId: string;
  readonly lookalikes: readonly DecorativeLookalike[];
}

export function classifyDecorativeControls(snapshot: DecorativeControlSnapshot, section: Pick<CreativeSectionV1, "id" | "visualKind" | "requiredStates">): DecorativeControlFinding | null {
  return section.visualKind === "real_component" && section.requiredStates.includes("interaction") && snapshot.focusableCount === 0
    ? { sectionId: section.id, lookalikes: snapshot.lookalikes }
    : null;
}

/** A self-contained browser function: no host values or Node globals cross evaluate. */
export const DECORATIVE_CONTROLS_DOM_FUNCTION = String.raw`(section) => {
  if (!section) return { focusableCount: null, lookalikes: [] };
  const widgets = new Set(["button", "checkbox", "combobox", "grid", "gridcell", "link", "listbox", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "progressbar", "radio", "radiogroup", "scrollbar", "searchbox", "slider", "spinbutton", "switch", "tab", "tablist", "textbox", "tree", "treegrid", "treeitem"]);
  const focusable = (node) => node.matches('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]') || (node.getAttribute('role') || '').split(/\s+/).some(role => widgets.has(role));
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const opaque = (color) => color !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color);
  const rounded = (style) => [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some(value => parseFloat(value) > 0);
  const painted = (style) => opaque(style.backgroundColor) || ['Top','Right','Bottom','Left'].some(side => parseFloat(style['border' + side + 'Width']) > 0 && style['border' + side + 'Style'] !== 'none' && opaque(style['border' + side + 'Color'])) || (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none' && opaque(style.outlineColor));
  const nodes = Array.from(section.querySelectorAll('*'));
  const controls = nodes.filter(node => focusable(node) && visible(node));
  const lookalikes = [];
  for (const node of nodes) {
    if (!visible(node) || focusable(node) || Array.from(node.querySelectorAll('*')).some(focusable)) continue;
    if (node.closest('label') || node.closest('[role],[aria-label],[aria-labelledby]')) continue;
    let parent = node.parentElement;
    let insideControl = false;
    while (parent) { if (focusable(parent)) { insideControl = true; break; } parent = parent.parentElement; }
    if (insideControl) continue;
    const style = getComputedStyle(node);
    const height = node.getBoundingClientRect().height;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const shapeA = height >= 20 && height <= 80 && text.split(/\s+/).filter(Boolean).length <= 4 && rounded(style) && painted(style);
    const children = Array.from(node.children);
    const shapeB = node.getAttribute('aria-hidden') === 'true' && children.length >= 2 && children.every(child => !(child.textContent || '').trim() && opaque(getComputedStyle(child).backgroundColor) && rounded(getComputedStyle(child)));
    if (shapeA || shapeB) {
      const classes = Array.from(node.classList);
      const selector = classes.length ? '.' + CSS.escape(classes[classes.length - 1]) : node.id ? '#' + CSS.escape(node.id) : node.tagName.toLowerCase();
      lookalikes.push({ selector, kind: shapeB ? 'indicator' : 'control', text: text.slice(0, 160) });
    }
  }
  return { focusableCount: controls.length, lookalikes };
}`;

export function decorativeControlsExpression(sectionExpression: string): string {
  return `(${DECORATIVE_CONTROLS_DOM_FUNCTION})(${sectionExpression})`;
}
