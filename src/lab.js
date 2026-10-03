// The Lab: editing passes that mark, propose fixes, or propose cuts — never rewrite.
//
// A result is {task, kind: "marks"|"fixes"|"trim", title, items: [{id, from, to,
// note?, replacement?}], cur, walking, ...}. Items are positions in the editor that
// follow edits; nothing touches the draft until the writer accepts a fix or a cut.

import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { uiField } from "./alts.js";
import { wordCount } from "./ghost.js";
import { locate, makeAnchor } from "./anchor.js";

export const setLab = StateEffect.define(); // result | null
export const patchLab = StateEffect.define(); // partial
export const dropItems = StateEffect.define(); // [ids]

export const labField = StateField.define({
  create: () => null,
  update(lab, tr) {
    if (lab && tr.docChanged) {
      const items = lab.items
        .map(it => {
          const from = tr.changes.mapPos(it.from, 1), to = tr.changes.mapPos(it.to, -1);
          return from === it.from && to === it.to ? it : { ...it, from, to };
        })
        .filter(it => it.to > it.from);
      lab = { ...lab, items };
    }
    for (const e of tr.effects) {
      if (e.is(setLab)) lab = e.value;
      else if (lab && e.is(patchLab)) lab = { ...lab, ...e.value };
      else if (lab && e.is(dropItems)) lab = { ...lab, items: lab.items.filter(it => !e.value.includes(it.id)) };
    }
    if (lab && lab.cur >= lab.items.length) lab = { ...lab, cur: lab.items.length - 1 };
    return lab;
  },
});

class Replacement extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "wo-lab-rep";
    el.textContent = this.text || "∅";
    return el;
  }
}

export const labDecorations = EditorView.decorations.compute([labField, uiField], state => {
  const lab = state.field(labField);
  if (!lab || !state.field(uiField).on) return Decoration.none;
  const cls = { marks: "wo-lab-mark", fixes: "wo-lab-fix", trim: "wo-lab-cut" }[lab.kind];
  const out = [];
  lab.items.forEach((it, i) => {
    const attrs = it.note ? { title: it.note } : {};
    out.push(Decoration.mark({ class: cls + (i === lab.cur ? " wo-cur" : ""), attributes: attrs }).range(it.from, it.to));
    if (lab.kind === "fixes") out.push(Decoration.widget({ widget: new Replacement(it.replacement), side: 1 }).range(it.to));
  });
  return Decoration.set(out, true);
});

export function itemAt(state, pos) {
  const lab = state.field(labField);
  return lab ? lab.items.find(it => it.from <= pos && pos <= it.to) || null : null;
}

// ---- turning a server reply into a result ---------------------------------

let seq = 0;

// The reply's offsets are into the text that was sent. If the draft changed while
// the model was thinking, find each quote again near where it was.
export function placeItems(view, sentText, items) {
  const now = view.state.doc.toString();
  return items
    .map(it => {
      if (now === sentText) return { ...it, id: ++seq };
      const r = locate(now, it.quote, makeAnchor(sentText, it.from, it.to));
      return r ? { ...it, from: r.from, to: r.to, id: ++seq } : null;
    })
    .filter(Boolean);
}

// ---- applying -------------------------------------------------------------

// Widen a deletion so it takes one neighbouring space with it.
function tidy(doc, from, to) {
  const before = from > 0 ? doc.sliceString(from - 1, from) : "\n";
  const after = doc.sliceString(to, to + 1);
  if (after === " " && /[\s(—–-]|^$/.test(before)) return [from, to + 1];
  if (before === " " && (/[.,;:!?)\]’”]/.test(after) || after === "\n" || after === "")) return [from - 1, to];
  return [from, to];
}

function merged(items) {
  const sorted = [...items].sort((a, b) => a.from - b.from);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.from <= last.to) last.to = Math.max(last.to, it.to);
    else out.push({ from: it.from, to: it.to });
  }
  return out;
}

export function cut(view, items) {
  const doc = view.state.doc;
  const changes = merged(items).map(({ from, to }) => {
    const [a, b] = tidy(doc, from, to);
    return { from: a, to: b };
  });
  view.dispatch({ changes, effects: dropItems.of(items.map(i => i.id)), userEvent: "delete.lab" });
}

export function ghostItems(view, items) {
  const doc = view.state.doc;
  const changes = [];
  for (const { from, to } of merged(items)) {
    if (doc.sliceString(from, to).includes("%%")) continue;
    changes.push({ from, insert: "%%" }, { from: to, insert: "%%" });
  }
  view.dispatch({ changes, effects: dropItems.of(items.map(i => i.id)), userEvent: "input.ghost" });
}

export function applyFix(view, it) {
  view.dispatch({
    changes: { from: it.from, to: it.to, insert: it.replacement ?? "" },
    effects: dropItems.of([it.id]),
    userEvent: "input.lab",
  });
}

export function wordsAfterCuts(state) {
  const lab = state.field(labField);
  const all = wordCount(state.doc.toString());
  if (!lab || lab.kind !== "trim") return all;
  return all - lab.items.reduce((n, it) => n + wordCount(state.doc.sliceString(it.from, it.to)), 0);
}
