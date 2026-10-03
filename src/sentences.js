// Moving text around: a sentence up or down within its paragraph, a paragraph up
// or down the draft, and splitting a sentence in two at the cursor.
//
// For sentences a paragraph is one line of the markdown. Alternative sets and Lab
// marks inside a moved sentence or paragraph travel with it; a move that would cut
// through a set is refused.

import { altsField, patchSet } from "./alts.js";
import { labField, patchLab } from "./lab.js";
import { ghosts } from "./ghost.js";

// Words a full stop doesn't end a sentence after.
const ABBREV = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e|cf|al|No|Vol|pp?|Fig|Inc|Ltd|Co|Corp|Rs|U\.S|U\.K|a\.m|p\.m|[A-Z])\.$/;

// Sentences in a paragraph's text, as [{from, to}] offsets: each runs from its
// first character to its closing punctuation (and any closing quote or bracket).
export function sentenceRanges(text) {
  const hidden = ghosts(text);
  const inGhost = i => hidden.some(g => g.from < i && i < g.to);
  const out = [];
  const lead = text.length - text.trimStart().length;
  let start = lead;
  const re = /[.!?…]+["'”’)\]*_%]*(?=\s+["'“‘(\[*_%]*[\p{Lu}\p{N}])/gu;
  for (let m; (m = re.exec(text)); ) {
    const end = m.index + m[0].length;
    if (inGhost(end)) continue;
    if (m[0][0] === "." && ABBREV.test(text.slice(start, m.index + 1))) continue;
    out.push({ from: start, to: end });
    start = end + (text.slice(end).match(/^\s+/)?.[0].length ?? 0);
  }
  const tail = text.trimEnd().length;
  if (tail > start) out.push({ from: start, to: tail });
  return out;
}

// The paragraph line at pos and its sentences in document positions, or null for
// blank lines, headings and other markdown furniture.
function paragraphAt(state, pos) {
  const line = state.doc.lineAt(pos);
  if (!line.text.trim() || /^\s*(#|>|[-*+] |\d+\. |```|---|%%\s*$)/.test(line.text)) return null;
  const sents = sentenceRanges(line.text).map(s => ({ from: line.from + s.from, to: line.from + s.to }));
  return { line, sents };
}

// The sentence containing pos, as {from, to} in the document, or null.
export function sentenceAt(state, pos) {
  const para = paragraphAt(state, pos);
  return para?.sents.find(s => s.from <= pos && pos <= s.to) || null;
}

function indexAt(sents, pos) {
  // The sentence the cursor is in; in the gap after a sentence counts as in it.
  for (let i = sents.length - 1; i >= 0; i--) if (pos >= sents[i].from) return i;
  return 0;
}

// Swap sentence i with its neighbour in direction dir. Returns a reason string
// when it can't, or true.
export function moveSentence(view, dir) {
  const { state } = view;
  const para = paragraphAt(state, state.selection.main.head);
  if (!para) return "not in a paragraph";
  const { sents } = para;
  const i = indexAt(sents, state.selection.main.head);
  const j = i + dir;
  if (j < 0 || j >= sents.length) return dir < 0 ? "already the first sentence" : "already the last sentence";
  return swap(view, sents[Math.min(i, j)], sents[Math.max(i, j)], dir > 0, "sentence");
}

// Paragraphs (any run of non-blank lines — headings and lists too) as
// [{from, to}]. A ghost spanning a blank line holds its paragraphs together;
// front matter is left out so it never moves.
export function paragraphRanges(doc) {
  const text = doc.toString();
  let start = 0;
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) start = fm[0].length;
  const out = [];
  const re = /[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g;
  re.lastIndex = start;
  for (let m; (m = re.exec(text)); ) out.push({ from: m.index, to: m.index + m[0].length });
  for (const g of ghosts(text))
    for (let k = 0; k < out.length - 1; k++)
      if (g.from < out[k].to && g.to > out[k + 1].from) {
        out.splice(k, 2, { from: out[k].from, to: out[k + 1].to });
        k--;
      }
  return out;
}

// The index of the paragraph at pos (or the one just before a blank gap).
export function paragraphIndex(paras, pos) {
  for (let i = paras.length - 1; i >= 0; i--) if (pos >= paras[i].from) return i;
  return 0;
}

export function moveParagraph(view, dir) {
  const paras = paragraphRanges(view.state.doc);
  if (!paras.length) return "nothing to move";
  const i = paragraphIndex(paras, view.state.selection.main.head);
  const j = i + dir;
  if (j < 0 || j >= paras.length) return dir < 0 ? "already the first paragraph" : "already the last paragraph";
  return swap(view, paras[Math.min(i, j)], paras[Math.max(i, j)], dir > 0, "paragraph");
}

// Move paragraph i to position k (as in a drag), one swap at a time so that
// sets and Lab marks ride along. Returns true or a reason.
export function relocateParagraph(view, i, k) {
  const dir = k > i ? 1 : -1;
  for (let at = i; at !== k; at += dir) {
    const paras = paragraphRanges(view.state.doc);
    const r = swap(view, paras[Math.min(at, at + dir)], paras[Math.max(at, at + dir)], dir > 0, "paragraph", false);
    if (r !== true) return r;
  }
  return true;
}

// Swap two adjacent ranges A (before) and B, keeping whatever is between them.
// The selection follows A if movingA, else B; alternative sets and Lab marks
// inside either range travel with it, and one that straddles an edge blocks it.
function swap(view, A, B, movingA, what, follow = true) {
  const { state } = view;
  const sel = state.selection.main;
  const lenA = A.to - A.from, lenB = B.to - B.from, lenG = B.from - A.to;

  const place = (from, to) => {
    if (to <= A.from || from >= B.to || (from <= A.from && to >= B.to)) return { from, to };
    if (from >= A.from && to <= A.to) return { from: from + lenB + lenG, to: to + lenB + lenG };
    if (from >= B.from && to <= B.to) return { from: from - lenA - lenG, to: to - lenA - lenG };
    return null;
  };

  const effects = [];
  for (const s of state.field(altsField, false) || []) {
    const p = place(s.from, s.to);
    if (!p) return `versions span the ${what} edge`;
    if (p.from !== s.from || p.to !== s.to) effects.push(patchSet.of({ id: s.id, ...p }));
  }
  const lab = state.field(labField, false);
  if (lab) {
    const items = lab.items.map(it => ({ ...it, ...(place(it.from, it.to) || { from: it.to, to: it.to }) }));
    effects.push(patchLab.of({ items: items.filter(it => it.to > it.from) }));
  }

  const moved = movingA ? A : B;
  const shift = movingA ? lenB + lenG : -(lenA + lenG);
  const ride = p => Math.min(Math.max(p, moved.from), moved.to) + shift;
  const at = p => place(p, p)?.from ?? p;
  view.dispatch({
    changes: { from: A.from, to: B.to, insert: state.sliceDoc(B.from, B.to) + state.sliceDoc(A.to, B.from) + state.sliceDoc(A.from, A.to) },
    selection: follow ? { anchor: ride(sel.anchor), head: ride(sel.head) } : { anchor: at(sel.anchor), head: at(sel.head) },
    effects,
    scrollIntoView: follow,
    userEvent: `move.${what}`,
  });
  return true;
}

const CONNECTORS = /[\s,;:—–-]+$/;

// Split the sentence at the cursor: end the first half with a full stop and
// capitalise the second. Returns a reason string when it can't, or true.
export function splitSentence(view) {
  const { state } = view;
  let pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  // Mid-word, split before the word.
  while (pos > line.from && /[\p{L}\p{N}'’]/u.test(state.sliceDoc(pos - 1, pos))) pos--;
  const before = state.sliceDoc(line.from, pos);
  const after = state.sliceDoc(pos, line.to);
  const left = before.replace(CONNECTORS, "");
  const lead = after.match(/^[\s,;:—–-]*/)[0].length;
  const first = after.slice(lead).match(/^["'“‘(]*(.)/u);
  if (!left.trim() || !first) return "nothing on one side of the cursor";
  if (/[.!?…]["'”’)]*$/.test(left)) return "already a sentence end";

  const from = line.from + left.length;
  const capAt = pos + lead + first[0].length - 1;
  const insert = ". " + state.sliceDoc(pos + lead, capAt) + first[1].toUpperCase();
  const effects = [];
  for (const s of state.field(altsField, false) || [])
    if (s.from === capAt) effects.push(patchSet.of({ id: s.id, from: from + insert.length - 1 }));
  view.dispatch({
    changes: { from, to: capAt + 1, insert },
    selection: { anchor: from + 2 },
    effects,
    scrollIntoView: true,
    userEvent: "input.split",
  });
  return true;
}
