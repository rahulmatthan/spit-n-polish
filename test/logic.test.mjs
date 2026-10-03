// Headless checks of the editor logic: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { altsField, uiField, loadSets, activate, cycle, addVariant, removeVariant, createSet, articleFix } from "../src/alts.js";
import { ghosts, wordCount, charCount } from "../src/ghost.js";
import { makeAnchor, placeSets } from "../src/anchor.js";

// A stand-in for EditorView: just enough for the commands.
function fakeView(doc) {
  const v = { state: EditorState.create({ doc, extensions: [altsField, uiField] }) };
  v.dispatch = (...specs) => { v.state = v.state.update(...specs).state; };
  return v;
}
const sets = v => v.state.field(altsField);
const text = v => v.state.doc.toString();

test("cycling swaps text in place and fixes a/an", () => {
  const v = fakeView("Like a paperclip, for example.");
  v.dispatch({ selection: { anchor: 7, head: 16 } });
  const id = createSet(v);
  addVariant(v, id, "eraser");
  assert.equal(text(v), "Like an eraser, for example.");
  addVariant(v, id, "thumbtack");
  assert.equal(text(v), "Like a thumbtack, for example.");
  cycle(v, id, 1); // wraps to the original
  assert.equal(text(v), "Like a paperclip, for example.");
  assert.equal(sets(v)[0].variants.length, 3);
});

test("a/an edge cases", () => {
  const fix = (s, w) => { const st = EditorState.create({ doc: s }); return articleFix(st.doc, s.length, w); };
  assert.equal(fix("It was a ", "hour")?.insert, "an");
  assert.equal(fix("It was an ", "university")?.insert, "a");
  assert.equal(fix("An ", "dog")?.insert, "A");
  assert.equal(fix("banana ", "egg"), null); // not an article
});

test("typing inside a set updates the active version; edits elsewhere move it", () => {
  const v = fakeView("Much of the tension in design.");
  v.dispatch({ selection: { anchor: 12, head: 19 } });
  const id = createSet(v);
  addVariant(v, id, "pressure");
  v.dispatch({ changes: { from: 0, insert: "So. " } });
  const s = sets(v)[0];
  assert.equal(text(v).slice(s.from, s.to), "pressure");
  v.dispatch({ changes: { from: s.from + 1, to: s.from + 2, insert: "l" } }); // pressure -> plessure
  assert.equal(sets(v)[0].variants[1].text, "plessure");
  assert.equal(sets(v)[0].variants[0].text, "tension");
});

test("removing the active version switches to another", () => {
  const v = fakeView("the tension here");
  v.dispatch({ selection: { anchor: 4, head: 11 } });
  const id = createSet(v);
  addVariant(v, id, "strain");
  removeVariant(v, id, 1);
  assert.equal(text(v), "the tension here");
  assert.equal(sets(v)[0].variants.length, 1);
});

test("anchors survive edits made elsewhere (Obsidian)", () => {
  const doc = "The cat sat. The cat ran. The cat slept.";
  const from = doc.indexOf("cat", 14), to = from + 3; // the second "cat"
  const stored = [{ id: "x", level: "word", active: 0, variants: [{ text: "cat", by: "me", original: true }, { text: "dog", by: "me" }], anchor: makeAnchor(doc, from, to) }];
  const edited = "Prologue added.\n\n" + doc.replace("sat", "sat down");
  const { placed, orphans } = placeSets(edited, stored);
  assert.equal(orphans.length, 0);
  assert.equal(edited.slice(placed[0].from - 4, placed[0].to + 4), "The cat ran");
});

test("a set whose text was rewritten becomes an orphan, not lost", () => {
  const stored = [{ id: "x", level: "word", active: 0, variants: [{ text: "tension" }, { text: "strain" }], anchor: {} }];
  const { placed, orphans } = placeSets("Nothing matches here.", stored);
  assert.equal(placed.length, 0);
  assert.equal(orphans.length, 1);
});

test("ghosts and word count", () => {
  const t = "Keep this. %%Maybe cut this bit.%% And this.";
  assert.deepEqual(ghosts(t), [{ from: 11, to: 34 }]);
  assert.equal(wordCount(t), 4);
  assert.equal(charCount(t), "Keep this. And this.".length);
  assert.equal(charCount("One — two.\n\nThree  four.\n"), 10 + 11);
});

import { sentenceRanges, moveSentence, splitSentence, paragraphRanges, moveParagraph, relocateParagraph } from "../src/sentences.js";

test("sentence ranges skip abbreviations and ghosts", () => {
  const t = "Dr. Rao spoke at 9 a.m. today. %%It rained. Hard.%% Then “Why?” he asked. The end";
  const parts = sentenceRanges(t).map(r => t.slice(r.from, r.to));
  assert.deepEqual(parts, [
    "Dr. Rao spoke at 9 a.m. today.",
    "%%It rained. Hard.%%",
    "Then “Why?” he asked.",
    "The end",
  ]);
});

test("moving a sentence up and down within its paragraph", () => {
  const v = fakeView("Title\n\nOne is first. Two is second! Three is third.\n\nNext para.");
  const at = s => text(v).indexOf(s);
  v.dispatch({ selection: { anchor: at("Three") + 2 } });
  assert.equal(moveSentence(v, -1), true);
  assert.equal(text(v), "Title\n\nOne is first. Three is third. Two is second!\n\nNext para.");
  assert.equal(moveSentence(v, -1), true);
  assert.equal(text(v), "Title\n\nThree is third. One is first. Two is second!\n\nNext para.");
  assert.equal(v.state.selection.main.head, at("Three") + 2); // cursor rides along
  assert.equal(moveSentence(v, -1), "already the first sentence");
  assert.equal(moveSentence(v, 1), true);
  assert.equal(text(v), "Title\n\nOne is first. Three is third. Two is second!\n\nNext para.");
  v.dispatch({ selection: { anchor: 0 } });
  assert.equal(moveSentence(v, 1), "already the last sentence");
});

test("versions travel with a moved sentence; straddling ones block the move", () => {
  const v = fakeView("Cats purr loudly. Dogs bark.");
  v.dispatch({ selection: { anchor: 5, head: 9 } }); // "purr"
  const id = createSet(v);
  addVariant(v, id, "hum");
  v.dispatch({ selection: { anchor: 0 } });
  assert.equal(moveSentence(v, 1), true);
  assert.equal(text(v), "Dogs bark. Cats hum loudly.");
  const s = sets(v)[0];
  assert.equal(text(v).slice(s.from, s.to), "hum");
  cycle(v, id, 1);
  assert.equal(text(v), "Dogs bark. Cats purr loudly.");
  v.dispatch({ selection: { anchor: 13 } });
  assert.equal(moveSentence(v, -1), true); // and back up
  assert.equal(text(v), "Cats purr loudly. Dogs bark.");
  assert.equal(text(v).slice(sets(v)[0].from, sets(v)[0].to), "purr");

  const w = fakeView("Cats purr loudly. Dogs bark.");
  w.dispatch({ selection: { anchor: 10, head: 22 } }); // "loudly. Dogs"
  createSet(w);
  w.dispatch({ selection: { anchor: 0 } });
  assert.equal(moveSentence(w, 1), "versions span the sentence edge");
});

test("splitting a sentence at the cursor", () => {
  const split = (t, at) => {
    const v = fakeView(t);
    v.dispatch({ selection: { anchor: t.indexOf(at) } });
    const r = splitSentence(v);
    return r === true ? text(v) : r;
  };
  assert.equal(split("It rained all day, and the river rose.", "and"), "It rained all day. And the river rose.");
  assert.equal(split("It rained all day — the river rose.", "the river"), "It rained all day. The river rose.");
  assert.equal(split("It rained all day; “the river” rose.", "“the"), "It rained all day. “The river” rose.");
  assert.equal(split("It rained all day so the river rose.", "ver"), "It rained all day so the. River rose."); // mid-word: before the word
  assert.equal(split("It rained. The river rose.", "The"), "already a sentence end");
});

test("paragraph ranges hold ghosted paragraphs together and skip front matter", () => {
  const t = "---\ntitle: x\n---\nOne.\n\n%%Two.\n\nThree.%%\n\n# Four";
  const st = EditorState.create({ doc: t });
  assert.deepEqual(paragraphRanges(st.doc).map(r => t.slice(r.from, r.to)), ["One.", "%%Two.\n\nThree.%%", "# Four"]);
});

test("moving paragraphs carries versions; relocating is a run of swaps", () => {
  const v = fakeView("Alpha one.\n\nBeta two.\n\nGamma three.");
  v.dispatch({ selection: { anchor: 12, head: 16 } }); // "Beta"
  const id = createSet(v);
  addVariant(v, id, "Delta");
  v.dispatch({ selection: { anchor: 14 } });
  assert.equal(moveParagraph(v, -1), true);
  assert.equal(text(v), "Delta two.\n\nAlpha one.\n\nGamma three.");
  assert.equal(v.state.selection.main.head, 2); // the cursor rides along
  assert.equal(moveParagraph(v, -1), "already the first paragraph");
  cycle(v, id, 1);
  assert.equal(text(v), "Beta two.\n\nAlpha one.\n\nGamma three.");
  assert.equal(relocateParagraph(v, 0, 2), true);
  assert.equal(text(v), "Alpha one.\n\nGamma three.\n\nBeta two.");
  const s = sets(v)[0];
  assert.equal(text(v).slice(s.from, s.to), "Beta");
});

import { significant, keepWording } from "../src/history.js";

test("only real rewording counts as history", () => {
  assert.equal(significant("The river rose fast.", "The river rose fast!"), false);
  assert.equal(significant("The river rose fast.", "The rivver rose fast."), false); // one word
  assert.equal(significant("The river rose fast.", "The water climbed fast."), true);
  assert.equal(significant("", "Brand new sentence here."), false);
});

test("earlier wordings are kept on the sentence, hidden, and saved", () => {
  const v = fakeView("It rained. The water climbed fast. Then it stopped.");
  const at = { from: 11, to: 34 };
  assert.equal(v.state.sliceDoc(at.from, at.to), "The water climbed fast.");
  v.dispatch(keepWording(v.state, at, "The river rose fast.", "2026-10-01T00:00:00Z"));
  let s = sets(v)[0];
  assert.equal(s.auto, true);
  assert.equal(s.variants.length, 1);
  assert.deepEqual(s.history, [{ text: "The river rose fast.", at: "2026-10-01T00:00:00Z" }]);
  // A second rewording adds to the same set; a repeat is ignored.
  v.dispatch({ changes: { from: 11, to: 34, insert: "Water climbed quickly." } });
  const now = { from: 11, to: 33 };
  v.dispatch(keepWording(v.state, now, "The water climbed fast."));
  assert.equal(keepWording(v.state, now, "The river rose fast."), null);
  s = sets(v)[0];
  assert.equal(sets(v).length, 1);
  assert.deepEqual(s.history.map(h => h.text), ["The river rose fast.", "The water climbed fast."]);
  assert.equal(s.variants[0].text, "Water climbed quickly.");
});
