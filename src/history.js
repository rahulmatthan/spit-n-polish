// Sentence history: when the cursor leaves a sentence that was reworded by
// typing, its earlier wording is kept on the sentence — a quiet list in the
// versions panel, never cycled and never shown in the draft.
//
// The wordings live on an alternative set as `history: [{text, at}]` (oldest
// first). If the sentence has no set yet, one is made with `auto: true`, which
// stays invisible until it gets a second version.

import { ViewPlugin } from "@codemirror/view";
import { altsField, addSet, patchSet, newId } from "./alts.js";
import { sentenceAt } from "./sentences.js";

const KEEP = 20; // earlier wordings per sentence

// Typing and deleting by hand — not cycling, Lab edits, moves, splits or undo.
const TYPING = ["input.type", "input.paste", "input.drop", "delete.backward", "delete.forward", "delete.selection", "delete.cut"];
const typed = tr => TYPING.some(e => tr.isUserEvent(e));

const wordsOf = s => s.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) || [];

// Word-level edit distance, so a typo fix or a changed comma doesn't count.
export function wordChanges(a, b) {
  const x = wordsOf(a), y = wordsOf(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

export const significant = (before, now) =>
  wordsOf(before).length > 0 && before.trim() !== now.trim() && wordChanges(before, now) >= 2;

// The transaction spec that keeps `before` as an earlier wording of the
// sentence now at {from, to}, or null if there's nothing worth keeping.
export function keepWording(state, { from, to }, before, at = new Date().toISOString()) {
  const now = state.sliceDoc(from, to);
  if (!significant(before, now)) return null;
  const entry = { text: before.trim(), at };
  const s = state.field(altsField).find(x => x.from === from && x.to === to);
  if (s) {
    if (s.variants.some(v => v.text === entry.text) || s.history?.some(h => h.text === entry.text)) return null;
    return { effects: patchSet.of({ id: s.id, history: [...(s.history || []), entry].slice(-KEEP) }) };
  }
  return {
    effects: addSet.of({
      id: newId(), level: "sentence", auto: true, active: 0, from, to,
      variants: [{ text: now, by: "me", original: true }], history: [entry],
    }),
  };
}

// Watches the sentence under the cursor: remembers its wording on the way in,
// and on the way out keeps that wording if typing has changed it enough.
export const sentenceHistory = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.watch = null; // {from, to, before, typed}
    this.look(view.state);
  }
  look(state) {
    const cur = sentenceAt(state, state.selection.main.head);
    this.watch = cur ? { ...cur, before: state.sliceDoc(cur.from, cur.to), typed: false } : null;
  }
  update(u) {
    let w = this.watch;
    if (w && u.docChanged) {
      const from = u.changes.mapPos(w.from, -1), to = u.changes.mapPos(w.to, 1);
      const touched = u.changes.touchesRange(w.from, w.to);
      if (touched && !u.transactions.every(typed)) {
        // Something other than typing changed it: start again from here.
        return this.look(u.state);
      }
      w = this.watch = { ...w, from, to, typed: w.typed || !!touched };
    }
    if (!u.docChanged && !u.selectionSet) return;
    const head = u.state.selection.main.head;
    if (w && head >= w.from && head <= w.to) return; // still in it
    if (w?.typed) {
      const cur = sentenceAt(u.state, Math.min(w.to, Math.max(w.from, w.to - 1)));
      // Only when it's still one sentence (not split, not merged into another).
      if (cur && cur.from >= w.from && cur.to <= w.to && u.state.sliceDoc(w.from, w.to).trim() === u.state.sliceDoc(cur.from, cur.to)) {
        const spec = keepWording(u.state, cur, w.before);
        if (spec) queueMicrotask(() => this.view.dispatch(spec));
      }
    }
    this.look(u.state);
  }
});
