// Alternatives: several versions of a word, sentence or paragraph, cycled in place.
//
// A set is {id, level, variants: [{text, by: "me"|"ai", original?}], active, from, to,
// history?: [{text, at}], auto?}. History is earlier wordings (see history.js).
// The document always holds the active version; from/to track it through edits,
// and the active variant's text follows whatever is typed inside the range.

import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

export const loadSets = StateEffect.define();
export const addSet = StateEffect.define();
export const patchSet = StateEffect.define(); // {id, ...fields}
export const dropSet = StateEffect.define(); // id

export const setUi = StateEffect.define(); // {on?, hover?}

export const uiField = StateField.define({
  create: () => ({ on: true, hover: null }),
  update(ui, tr) {
    for (const e of tr.effects) if (e.is(setUi)) ui = { ...ui, ...e.value };
    return ui;
  },
});

export const altsField = StateField.define({
  create: () => [],
  update(sets, tr) {
    const before = sets;
    if (tr.docChanged && sets.some(s => tr.changes.touchesRange(0, s.to) !== false)) {
      sets = sets.map(s => {
        const from = tr.changes.mapPos(s.from, 1);
        const to = Math.max(from, tr.changes.mapPos(s.to, -1));
        return from === s.from && to === s.to ? s : { ...s, from, to };
      });
    }
    for (const e of tr.effects) {
      if (e.is(loadSets)) sets = e.value;
      else if (e.is(addSet)) sets = [...sets, e.value];
      else if (e.is(patchSet)) sets = sets.map(s => (s.id === e.value.id ? { ...s, ...e.value } : s));
      else if (e.is(dropSet)) sets = sets.filter(s => s.id !== e.value);
    }
    if (sets === before) return sets; // nothing touched us (e.g. a hover effect)
    // Keep the active variant in step with the text actually in the document.
    return sets
      .map(s => {
        const cur = tr.newDoc.sliceString(s.from, s.to);
        if (s.variants[s.active]?.text === cur) return s;
        const variants = s.variants.slice();
        variants[s.active] = { ...variants[s.active], text: cur };
        return { ...s, variants };
      })
      .filter(s => s.to > s.from);
  },
});

let seq = 0;
export const newId = () => `v${Date.now().toString(36)}${(seq++).toString(36)}`;

export function setAt(state, pos) {
  // Innermost set containing pos (a word set inside a paragraph set wins).
  let hit = null;
  for (const s of state.field(altsField))
    if (s.from <= pos && pos <= s.to && (!hit || s.to - s.from < hit.to - hit.from)) hit = s;
  return hit;
}

export function guessLevel(state, from, to) {
  const text = state.doc.sliceString(from, to);
  if (!/\s/.test(text.trim())) return "word";
  const a = state.doc.lineAt(from), b = state.doc.lineAt(to);
  if (from <= a.from + (a.text.length - a.text.trimStart().length) && to >= b.to - (b.text.length - b.text.trimEnd().length))
    return "paragraph";
  return "sentence";
}

// ---- a / an ---------------------------------------------------------------

const TAKES_AN = /^(hour|honest|honou?r|heir|herb\b)/i;
const TAKES_A = /^(uni|use|usu|uti|ura|eu|ew|one\b|once)/i;

function wantsAn(text) {
  const w = text.replace(/^[^\p{L}\p{N}]+/u, "");
  if (!w) return null;
  if (TAKES_AN.test(w)) return true;
  if (TAKES_A.test(w)) return false;
  if (/^\d/.test(w)) return /^(8|11|18)(\D|$)/.test(w);
  return /^[aeiou]/i.test(w);
}

// If the word before `from` is a/an and `text` needs the other one, the change to fix it.
export function articleFix(doc, from, text) {
  const before = doc.sliceString(Math.max(0, from - 4), from);
  const m = before.match(/(?:^|[^\p{L}])(an|a)(\s)$/iu);
  if (!m) return null;
  const art = m[1], at = from - m[2].length - art.length;
  const an = wantsAn(text);
  if (an === null) return null;
  let want = an ? "an" : "a";
  if (art === art.toUpperCase() && art.length > 1) want = want.toUpperCase();
  else if (art[0] === art[0].toUpperCase()) want = want[0].toUpperCase() + want.slice(1);
  return want === art ? null : { from: at, to: at + art.length, insert: want };
}

// ---- commands -------------------------------------------------------------

export function activate(view, id, idx) {
  const s = view.state.field(altsField).find(x => x.id === id);
  if (!s || !s.variants[idx]) return false;
  const text = s.variants[idx].text;
  const changes = [{ from: s.from, to: s.to, insert: text }];
  let shift = 0;
  const fix = articleFix(view.state.doc, s.from, text);
  if (fix) {
    changes.push(fix);
    shift = fix.insert.length - (fix.to - fix.from);
  }
  const from = s.from + shift;
  view.dispatch({
    changes,
    effects: patchSet.of({ id, active: idx, from, to: from + text.length }),
    userEvent: "input.alternative",
  });
  return true;
}

export function cycle(view, id, dir) {
  const s = view.state.field(altsField).find(x => x.id === id);
  if (!s || s.variants.length < 2) return false;
  const n = s.variants.length;
  return activate(view, id, (s.active + dir + n) % n);
}

export function addVariant(view, id, text, by = "me") {
  const s = view.state.field(altsField).find(x => x.id === id);
  text = text.trim();
  if (!s || !text) return false;
  const existing = s.variants.findIndex(v => v.text === text);
  if (existing >= 0) return activate(view, id, existing);
  view.dispatch({ effects: patchSet.of({ id, variants: [...s.variants, { text, by }] }) });
  return activate(view, id, s.variants.length);
}

export function removeVariant(view, id, idx) {
  let s = view.state.field(altsField).find(x => x.id === id);
  if (!s) return false;
  if (s.variants.length <= 1) {
    view.dispatch({ effects: dropSet.of(id) });
    return true;
  }
  if (idx === s.active) {
    activate(view, id, idx === 0 ? 1 : 0);
    s = view.state.field(altsField).find(x => x.id === id);
  }
  const variants = s.variants.filter((_, i) => i !== idx);
  if (!variants.some(v => v.original)) variants[0] = { ...variants[0], original: true };
  const active = s.active > idx ? s.active - 1 : s.active;
  view.dispatch({ effects: patchSet.of({ id, variants, active }) });
  return true;
}

// Start a set on the selection (or the word at the cursor). Returns its id.
export function createSet(view) {
  const state = view.state;
  let { from, to } = state.selection.main;
  if (from === to) {
    const w = state.wordAt(from);
    if (!w) return null;
    ({ from, to } = w);
  }
  // Trim surrounding whitespace so the range is the words themselves.
  const raw = state.doc.sliceString(from, to);
  from += raw.length - raw.trimStart().length;
  to -= raw.length - raw.trimEnd().length;
  if (to <= from) return null;
  const existing = state.field(altsField).find(s => s.from === from && s.to === to);
  if (existing) return existing.id;
  const id = newId();
  view.dispatch({
    effects: addSet.of({
      id,
      level: guessLevel(state, from, to),
      variants: [{ text: state.doc.sliceString(from, to), by: "me", original: true }],
      active: 0,
      from,
      to,
    }),
    selection: { anchor: from, head: to },
  });
  return id;
}

// ---- decorations ----------------------------------------------------------

export const altDecorations = EditorView.decorations.compute([altsField, uiField, "selection"], state => {
  const ui = state.field(uiField);
  if (!ui.on) return Decoration.none;
  const head = state.selection.main.head;
  const here = setAt(state, head);
  const out = [];
  for (const s of state.field(altsField)) {
    const current = here && here.id === s.id;
    // A set with one version shows only while the cursor is in it — unless it
    // exists just to hold sentence history, when it never shows.
    if (s.variants.length < 2 && (!current || s.auto)) continue;
    const original = Math.max(0, s.variants.findIndex(v => v.original));
    const cls =
      `wo-alt wo-alt-${s.level}` +
      (current || s.id === ui.hover ? " wo-hot" : "") +
      (s.active !== original ? " wo-moved" : "");
    if (s.level === "paragraph") {
      for (let pos = s.from; pos <= s.to; ) {
        const line = state.doc.lineAt(pos);
        out.push(Decoration.line({ class: cls }).range(line.from));
        pos = line.to + 1;
      }
    } else {
      out.push(Decoration.mark({ class: cls }).range(s.from, s.to));
    }
  }
  return Decoration.set(out, true);
});
