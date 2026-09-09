/**
 * DOM wiring for the booking wizard.
 *
 * All the rules live in wizard.mjs, which is pure and is what the node tests
 * drive. This file only reads the state and paints it, then reports events
 * back. Nothing here reaches the network.
 */

import {
  initialState, selectType, setDate, selectSlot,
  next, back, confirm, reset,
  firstErrorField, summary, stepName,
} from './wizard.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state = initialState();

const panels = new Map($$('[data-panel]').map((el) => [Number(el.dataset.panel), el]));
const progressCount = $('[data-progress-count]');
const progressSteps = $$('.progress__step');
const heroEntry = $('[data-hero-entry]');
const dateInput = $('#appointment-date');

const errorNodes = { type: $('#type-error'), date: $('#date-error'), slot: $('#slot-error') };
const invalidTargets = {
  type: { field: $('#type-group'), focus: $('#type-general-consultation') },
  date: { field: $('.field[data-field="date"]'), focus: dateInput },
  slot: { field: $('#slot-group'), focus: $('#slot-morning') },
};

/** Which panel is on screen: 1..3 are the steps, 4 is the confirmation. */
function activePanel() {
  return state.confirmed ? 4 : state.step;
}

function renderProgress() {
  const shown = !state.confirmed;
  const nav = $('[data-creative-section="s.nav"]');
  nav.hidden = !shown;
  if (!shown) return;
  progressCount.textContent = `Step ${state.step} of 3: ${stepName(state.step).toLowerCase()}`;
  for (const li of progressSteps) {
    const n = Number(li.dataset.step);
    li.dataset.reached = String(n <= state.step);
    if (n === state.step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function renderPanels() {
  const active = activePanel();
  for (const [n, el] of panels) el.classList.toggle('is-active', n === active);
  heroEntry.hidden = active !== 1;
}

function renderErrors() {
  for (const [field, node] of Object.entries(errorNodes)) {
    const message = state.errors[field];
    const target = invalidTargets[field];
    node.classList.toggle('is-shown', Boolean(message));
    if (message) $('[data-msg-text]', node).textContent = message;
    target.field.classList.toggle('is-invalid', Boolean(message));
    if (target.focus) {
      if (message) target.focus.setAttribute('aria-invalid', 'true');
      else target.focus.removeAttribute('aria-invalid');
    }
  }
  // a radio group is invalid as a group, so every member carries the flag and
  // not just the one focus happens to land on
  for (const [selector, field] of [['#type-group input', 'type'], ['#slot-group input', 'slot']]) {
    for (const input of $$(selector)) {
      if (state.errors[field]) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }
}

function renderSummaries() {
  const rows = summary(state);
  for (const host of $$('[data-summary]')) {
    host.textContent = '';
    for (const row of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'summary__row';
      const label = document.createElement('span');
      label.className = 'summary__label';
      label.textContent = row.label;
      const value = document.createElement('span');
      value.className = 'summary__value';
      value.textContent = row.value || 'Not chosen';
      wrap.append(label, value);
      host.append(wrap);
    }
  }
}

function render() {
  renderProgress();
  renderPanels();
  renderErrors();
  renderSummaries();
}

/** Focus lands on the new step heading, per the ticket. */
function focusPanelHeading() {
  const panel = panels.get(activePanel());
  const heading = panel ? $('h2[tabindex="-1"]', panel) : null;
  if (heading) heading.focus();
}

/** After a failed Continue, focus lands on the first invalid field. */
function focusFirstError(errors) {
  const field = firstErrorField(errors);
  const target = field ? invalidTargets[field] : null;
  if (target && target.focus) target.focus.focus();
}

function settleConfirmation() {
  const block = $('[data-motion-id="m.confirm"]');
  if (!block) return;
  block.classList.remove('is-settled');
  void block.offsetWidth; // restart the animation
  block.classList.add('is-settled');
}

// ---------- events ----------------------------------------------------------

document.addEventListener('change', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.name === 'appointment-type') state = selectType(state, el.value);
  else if (el.name === 'time-slot') state = selectSlot(state, el.value);
  else if (el === dateInput) state = setDate(state, el.value);
  else return;
  render();
});

// a date typed key by key reports input, not change, until it is complete
dateInput.addEventListener('input', () => {
  state = setDate(state, dateInput.value);
  render();
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;

  if (action === 'next') {
    const result = next(state);
    state = result.state;
    render();
    if (result.moved) focusPanelHeading();
    else focusFirstError(result.errors);
  } else if (action === 'back') {
    const result = back(state);
    state = result.state;
    render();
    if (result.moved) focusPanelHeading();
  } else if (action === 'confirm') {
    const result = confirm(state);
    state = result.state;
    render();
    if (result.confirmed) {
      focusPanelHeading();
      settleConfirmation();
    } else {
      focusFirstError(result.errors);
    }
  } else if (action === 'reset') {
    state = reset();
    dateInput.value = '';
    for (const input of $$('input[type="radio"]')) input.checked = false;
    render();
    focusPanelHeading();
  }
});

// "Start booking" is an ordinary link to the step one heading; give it focus
// too so the keyboard lands where the eye does.
for (const link of $$('a[href="#step-1-heading"]')) {
  link.addEventListener('click', () => {
    const heading = $('#step-1-heading');
    if (heading) window.requestAnimationFrame(() => heading.focus());
  });
}

render();

// ---------- world layer -----------------------------------------------------
/**
 * Two generated legs, scrubbed by scroll rather than played. The mp4 is fetched
 * to a blob first, which is what makes seeking instant. Every step is guarded:
 * if the fetch fails the poster is what remains on screen, and no error escapes.
 */
async function startWorld() {
  const stage = $('[data-world]');
  if (!stage) return;
  const layers = $$('[data-world-leg]', stage);
  if (layers.length === 0) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  layers[0].style.opacity = '1';

  const ready = [];
  for (const video of layers) {
    const src = video.dataset.worldLeg === '1'
      ? 'assets/world/leg-1.mp4'
      : 'assets/world/leg-2.mp4';
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const blob = await res.blob();
      video.src = URL.createObjectURL(blob);
      video.load();
      ready.push(video);
    } catch {
      /* poster stands in; nothing to report */
    }
  }
  if (ready.length === 0) return;

  const clamp = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
  let queued = false;

  const paint = () => {
    queued = false;
    const doc = document.documentElement;
    const span = doc.scrollHeight - window.innerHeight;
    const progress = span > 0 ? clamp(window.scrollY / span) : 0;

    // first half of the page belongs to leg 1, second half to leg 2
    const onSecond = progress > 0.5;
    for (const video of ready) {
      const isSecond = video.dataset.worldLeg === '2';
      video.style.opacity = isSecond === onSecond ? '1' : '0';
      const local = clamp(isSecond ? (progress - 0.5) * 2 : progress * 2);
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        const t = local * duration;
        if (Math.abs(video.currentTime - t) > 0.01) {
          try { video.currentTime = t; } catch { /* seek not ready yet */ }
        }
      }
    }
  };

  const onScroll = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(paint);
  };

  if (!reduced.matches) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }
  paint();
}

startWorld().catch(() => { /* the poster is the fallback and it is already painted */ });
