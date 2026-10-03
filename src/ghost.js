// Ghost: dim text back without deleting it.
//
// Ghosted text is stored as an Obsidian comment, %%like this%%, so it stays in the
// file, is hidden in Obsidian's reading view, and is easy to strip before the
// voice eval. Here it is shown at ~12% with the %% markers hidden until the
// cursor touches it.

import { Decoration, EditorView } from "@codemirror/view";
import { uiField } from "./alts.js";

const GHOST = /%%([\s\S]*?)%%/g;

export function ghosts(text) {
  const out = [];
  for (const m of text.matchAll(GHOST)) out.push({ from: m.index, to: m.index + m[0].length });
  return out;
}

export function ghostAt(state, pos) {
  return ghosts(state.doc.toString()).find(g => g.from <= pos && pos <= g.to) || null;
}

const hide = Decoration.replace({});
const delim = Decoration.mark({ class: "wo-ghost-delim" });
const dim = Decoration.mark({ class: "wo-ghost" });

export const ghostDecorations = EditorView.decorations.compute(["doc", "selection", uiField], state => {
  if (!state.field(uiField).on) return Decoration.none;
  const sel = state.selection.main;
  const out = [];
  for (const g of ghosts(state.doc.toString())) {
    const touching = sel.from <= g.to && sel.to >= g.from;
    const edge = touching ? delim : hide;
    out.push(edge.range(g.from, g.from + 2));
    if (g.to - 2 > g.from + 2) out.push(dim.range(g.from + 2, g.to - 2));
    out.push(edge.range(g.to - 2, g.to));
  }
  return Decoration.set(out, true);
});

export function ghostSelection(view) {
  const { from, to } = view.state.selection.main;
  const inside = ghostAt(view.state, from);
  if (inside) return revive(view, from);
  if (from === to) return false;
  const text = view.state.sliceDoc(from, to);
  if (text.includes("%%")) return false;
  view.dispatch({
    changes: [{ from, insert: "%%" }, { from: to, insert: "%%" }],
    selection: { anchor: to + 4 },
    userEvent: "input.ghost",
  });
  return true;
}

export function revive(view, pos = view.state.selection.main.head) {
  const g = ghostAt(view.state, pos);
  if (!g) return false;
  view.dispatch({
    changes: [{ from: g.from, to: g.from + 2 }, { from: g.to - 2, to: g.to }],
    selection: { anchor: g.from, head: g.to - 4 },
    userEvent: "input.ghost",
  });
  return true;
}

// Words that would survive if every ghost were cut.
export function wordCount(text) {
  return (text.replace(GHOST, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

// Characters, spaces included, as Word counts them: ghosts and line breaks
// don't count, and the gap a cut ghost leaves is one space.
export function charCount(text) {
  return text.replace(GHOST, " ").split("\n")
    .reduce((n, line) => n + [...line.replace(/\s+/g, " ").trim()].length, 0);
}
