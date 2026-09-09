/**
 * Booking wizard state.
 *
 * Pure data in, pure data out. No DOM, no timers, no globals, nothing that
 * touches the network. The browser imports this and so does `node --test`,
 * which is the only way the rules below get executed anywhere they can be
 * checked. Every function returns a NEW state; nothing is mutated in place.
 */

export const APPOINTMENT_TYPES = [
  { id: 'general-consultation', name: 'General consultation', note: 'A first look at something new.' },
  { id: 'follow-up-visit', name: 'Follow up visit', note: 'A review of something already seen.' },
  { id: 'vaccination', name: 'Vaccination', note: 'A single scheduled dose.' },
];

export const TIME_SLOTS = [
  { id: 'morning', name: 'Morning', range: '08:00 to 11:00' },
  { id: 'midday', name: 'Midday', range: '11:00 to 13:00' },
  { id: 'afternoon', name: 'Afternoon', range: '13:00 to 16:00' },
  { id: 'evening', name: 'Evening', range: '16:00 to 19:00' },
];

export const STEPS = [
  { index: 1, name: 'Appointment type' },
  { index: 2, name: 'Date and time' },
  { index: 3, name: 'Review' },
];

export const MESSAGES = {
  type: 'Choose an appointment type before continuing.',
  date: 'Choose a date before continuing.',
  slot: 'Choose a time slot before continuing.',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function initialState() {
  return { step: 1, type: null, date: '', slot: null, confirmed: false, errors: {}, submitted: {} };
}

export function findType(id) {
  return APPOINTMENT_TYPES.find((t) => t.id === id) || null;
}

export function findSlot(id) {
  return TIME_SLOTS.find((s) => s.id === id) || null;
}

/**
 * "2027-03-05" -> "Friday 5 March 2027".
 *
 * Built from UTC parts and fixed name tables rather than toLocaleDateString,
 * so the same input renders the same string on every machine and in every
 * timezone. The day is not zero padded.
 */
export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(dt.getTime())) return '';
  // Rejects the 31st of a 30 day month, which Date would roll forward.
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return '';
  return `${WEEKDAYS[dt.getUTCDay()]} ${day} ${MONTHS[month - 1]} ${year}`;
}

export function isValidDate(iso) {
  return formatDate(iso) !== '';
}

export function slotLabel(slot) {
  if (!slot) return '';
  return `${slot.name}, ${slot.range}`;
}

export function selectType(state, id) {
  if (!findType(id)) return state;
  const errors = { ...state.errors };
  delete errors.type;
  return { ...state, type: id, errors };
}

export function setDate(state, iso) {
  const errors = { ...state.errors };
  if (isValidDate(iso)) delete errors.date;
  return { ...state, date: String(iso || ''), errors };
}

export function selectSlot(state, id) {
  if (!findSlot(id)) return state;
  const errors = { ...state.errors };
  delete errors.slot;
  return { ...state, slot: id, errors };
}

/** Which fields on a given step are not yet acceptable, in tab order. */
export function validate(state, step = state.step) {
  const errors = {};
  if (step === 1) {
    if (!state.type) errors.type = MESSAGES.type;
  } else if (step === 2) {
    if (!isValidDate(state.date)) errors.date = MESSAGES.date;
    if (!state.slot) errors.slot = MESSAGES.slot;
  }
  return errors;
}

export function firstErrorField(errors) {
  for (const field of ['type', 'date', 'slot']) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * Continue. On failure the step does not move and the errors come back so the
 * caller can move focus to the first one.
 */
export function next(state) {
  const errors = validate(state, state.step);
  const submitted = { ...state.submitted, [state.step]: true };
  if (Object.keys(errors).length > 0) {
    return { state: { ...state, errors, submitted }, moved: false, errors };
  }
  if (state.step >= 3) return { state: { ...state, submitted }, moved: false, errors: {} };
  return { state: { ...state, step: state.step + 1, errors: {}, submitted }, moved: true, errors: {} };
}

/**
 * Back. Never validates and never clears a selection: the whole point is that
 * what you already chose survives the trip.
 */
export function back(state) {
  if (state.step <= 1) return { state, moved: false };
  return { state: { ...state, step: state.step - 1, errors: {} }, moved: true };
}

export function confirm(state) {
  const blocking = { ...validate(state, 1), ...validate(state, 2) };
  if (Object.keys(blocking).length > 0) {
    return { state: { ...state, errors: blocking }, confirmed: false, errors: blocking };
  }
  return { state: { ...state, confirmed: true, errors: {} }, confirmed: true, errors: {} };
}

/** Book another appointment: step 1, nothing selected, no messages, no confirmation. */
export function reset() {
  return initialState();
}

/** What the review and the confirmation both read from. */
export function summary(state) {
  const type = findType(state.type);
  const slot = findSlot(state.slot);
  return [
    { key: 'type', label: 'Type', value: type ? type.name : '' },
    { key: 'date', label: 'Date', value: formatDate(state.date) },
    { key: 'time', label: 'Time', value: slotLabel(slot) },
  ];
}

export function stepName(index) {
  const found = STEPS.find((s) => s.index === index);
  return found ? found.name : '';
}
