import { EditorState, Prec, Transaction, Annotation } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import {
  altsField, uiField, setUi, loadSets, altDecorations, setAt,
  activate, cycle, addVariant, removeVariant, createSet, patchSet,
} from "./alts.js";
import { ghostDecorations, ghostSelection, ghostAt, revive, wordCount, charCount } from "./ghost.js";
import { makeAnchor, placeSets } from "./anchor.js";
import {
  labField, labDecorations, setLab, patchLab, dropItems, itemAt, placeItems,
  cut, ghostItems, applyFix, wordsAfterCuts,
} from "./lab.js";
import { moveSentence, moveParagraph, splitSentence } from "./sentences.js";
import { initStructure } from "./structure.js";
import { sentenceHistory } from "./history.js";

const $ = sel => document.querySelector(sel);
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const external = Annotation.define(); // marks changes that came from disk, not typing
const IS_MAC = /Mac/.test(navigator.platform); // web/keys.js relabels ⌘/⌥ shortcuts elsewhere

// ---- state shared with the save loop --------------------------------------

const doc = {
  path: null,
  mtime: null,
  overflowMtime: null,
  orphans: [], // alternative sets whose text could not be found; kept as-is
  dirty: { text: false, alts: false, overflow: false },
  saving: false,
  conflict: false,
};

// ---- editor ---------------------------------------------------------------

const prose = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], class: "wo-link" },
  { tag: [t.processingInstruction, t.meta], class: "wo-mark" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", background: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font)", fontSize: "19px", lineHeight: "1.75" },
  ".cm-content": {
    flexGrow: "0", width: "100%", maxWidth: "40rem", margin: "0 auto",
    padding: "3rem 2rem 40vh", caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  ".cm-line.wo-alt-paragraph": {
    marginLeft: "-1rem", paddingLeft: "calc(1rem - 2px)", borderLeft: "2px solid var(--faint)",
  },
  ".cm-line.wo-alt-paragraph.wo-moved": { borderLeftColor: "color-mix(in srgb, var(--accent) 55%, transparent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { background: "var(--accent-soft)" },
});

const altKeys = Prec.highest(
  keymap.of([
    { key: "ArrowUp", run: v => hoverCycle(v, -1) },
    { key: "ArrowDown", run: v => hoverCycle(v, 1) },
    { key: "Alt-ArrowUp", run: v => cursorCycle(v, -1) },
    { key: "Alt-ArrowDown", run: v => cursorCycle(v, 1) },
    { key: "Mod-;", run: v => !!startVersions(v) },
    { key: "Mod-'", run: v => ghostSelection(v) },
    { key: "Mod-.", run: () => togglePanel("overflow") },
    { key: "Mod-Shift-.", run: v => stash(v) },
    { key: "Mod-Alt-v", run: () => togglePanel("versions") },
    { key: "Shift-Alt-ArrowUp", run: v => sentenceEdit(moveSentence(v, -1)) },
    { key: "Shift-Alt-ArrowDown", run: v => sentenceEdit(moveSentence(v, 1)) },
    { key: "Ctrl-Alt-ArrowUp", run: v => sentenceEdit(moveParagraph(v, -1)) },
    { key: "Ctrl-Alt-ArrowDown", run: v => sentenceEdit(moveParagraph(v, 1)) },
    { key: "Alt-Enter", run: v => sentenceEdit(splitSentence(v)) },
    { key: "Mod-o", run: () => (openPicker(), true) },
    { key: "Mod-/", run: () => (openHelp(), true) },
    { key: "Mod-s", run: () => (save(), true) },
    { key: "Escape", run: () => closeMenu() || closeLabMenu() },
  ]),
);

// The move and split commands return true or a reason they couldn't act.
function sentenceEdit(r) {
  if (r !== true) status(`Can't: ${r}`);
  return true;
}

function hoverCycle(view, dir) {
  const ui = view.state.field(uiField);
  if (!ui.on || !ui.hover) return false;
  return cycle(view, ui.hover, dir);
}

function cursorCycle(view, dir) {
  const s = setAt(view.state, view.state.selection.main.head);
  return s ? cycle(view, s.id, dir) : false;
}

const view = new EditorView({
  parent: $("#editor"),
  state: EditorState.create({ doc: "", extensions: baseExtensions() }),
});

function baseExtensions() {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdown(),
    syntaxHighlighting(prose),
    theme,
    altsField,
    uiField,
    labField,
    altDecorations,
    ghostDecorations,
    labDecorations,
    altKeys,
    sentenceHistory,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.domEventHandlers({
      mousemove(e, v) {
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        const s = pos == null ? null : setAt(v.state, pos);
        const id = s && s.variants.length > 1 ? s.id : null;
        if (id !== v.state.field(uiField).hover) v.dispatch({ effects: setUi.of({ hover: id }) });
      },
      mouseleave(e, v) {
        if (v.state.field(uiField).hover) v.dispatch({ effects: setUi.of({ hover: null }) });
      },
      contextmenu(e, v) {
        e.preventDefault();
        openMenu(e, v);
        return true;
      },
      click(e, v) {
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        const lab = v.state.field(labField);
        const it = pos == null ? null : itemAt(v.state, pos);
        if (!lab || !it) return false;
        // In a trim, clicking a faded passage keeps it. Elsewhere it selects the item.
        if (lab.kind === "trim" && !lab.walking) v.dispatch({ effects: dropItems.of([it.id]) });
        else v.dispatch({ effects: patchLab.of({ cur: lab.items.indexOf(it) }) });
        return false;
      },
    }),
    EditorView.updateListener.of(u => {
      const fromDisk = u.transactions.some(tr => tr.annotation(external));
      const altsChanged = u.startState.field(altsField) !== u.state.field(altsField);
      if (u.docChanged && !fromDisk) markDirty("text");
      if (altsChanged && !fromDisk) markDirty("alts");
      if (u.docChanged) renderCount();
      if (u.docChanged || u.selectionSet || altsChanged) renderVersions();
      if (u.startState.field(labField) !== u.state.field(labField)) renderLabBar();
      if (u.docChanged && structure?.isOpen()) structure.render();
    }),
  ];
}

// ---- word count / on-off --------------------------------------------------

function renderCount() {
  const text = view.state.doc.toString();
  $("#count").textContent =
    `${wordCount(text).toLocaleString()} words · ${charCount(text).toLocaleString()} characters`;
}

$("#count").addEventListener("click", () => {
  const on = !view.state.field(uiField).on;
  view.dispatch({ effects: setUi.of({ on }) });
  document.body.classList.toggle("wo-off", !on);
  try { localStorage.setItem("wo-on", on ? "1" : "0"); } catch {}
  view.focus();
});

// ---- versions panel (left) ------------------------------------------------

function togglePanel(which, force) {
  const el = $(`#${which}`);
  const open = force ?? el.hidden;
  el.hidden = !open;
  document.body.classList.toggle(`wo-${which}-open`, open);
  if (which === "versions") { lastPanelKey = ""; renderVersions(); }
  return true;
}

// Start (or reopen) the versions of the selection. Returns the set id.
function startVersions(v) {
  const id = createSet(v);
  if (!id) return null;
  togglePanel("versions", true);
  setTimeout(focusAddBox, 0);
  return id;
}

function focusAddBox() {
  const box = $("#vp-add");
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// What's typed in the add box for a set, kept across re-renders until submitted.
let addDraft = { id: null, text: "" };
let aiBusy = null; // id of the set waiting on AI versions
let lastPanelKey = "";

function renderVersions() {
  const panel = $("#versions");
  if (panel.hidden) return;
  const s = setAt(view.state, view.state.selection.main.head);
  const key = s ? JSON.stringify([s.id, s.level, s.active, s.variants, s.history, aiBusy === s.id]) : "none";
  if (key === lastPanelKey) return;
  lastPanelKey = key;
  const hadFocus = document.activeElement?.id === "vp-add";

  if (!s) {
    panel.innerHTML = `
      <div class="vp-levels"><span>Word</span><span>Sentence</span><span>Paragraph</span></div>
      <p class="vp-hint">Select a word, sentence or paragraph and choose <b>Versions…</b>
      from the right-click menu (or press <kbd>⌘;</kbd>) to write alternatives for it.</p>
      <dl class="vp-keys">
        <dt>hover + ↑ ↓</dt><dd>cycle versions in place</dd>
        <dt>⌥↑ ⌥↓</dt><dd>cycle the versions at the cursor</dd>
        <dt>⌘;</dt><dd>versions for the selection</dd>
        <dt>⌥⌘V</dt><dd>this panel</dd>
        <dt>⌘'</dt><dd>ghost / revive</dd>
        <dt>⌘.</dt><dd>overflow panel</dd>
        <dt>⌘⇧.</dt><dd>stash selection in overflow</dd>
        <dt>⌥⇧↑ ⌥⇧↓</dt><dd>move the sentence up / down</dd>
        <dt>⌃⌥↑ ⌃⌥↓</dt><dd>move the paragraph up / down</dd>
        <dt>⌥↩</dt><dd>split the sentence at the cursor</dd>
        <dt>⌥⌘O</dt><dd>structure view</dd>
        <dt>⌘O</dt><dd>open another file</dd>
        <dt>⌘/</dt><dd>the guide to everything</dd>
      </dl>`;
    return;
  }

  panel.innerHTML = "";
  const levels = document.createElement("div");
  levels.className = "vp-levels";
  for (const lvl of ["word", "sentence", "paragraph"]) {
    const b = document.createElement("button");
    b.textContent = lvl[0].toUpperCase() + lvl.slice(1);
    b.className = lvl === s.level ? "on" : "";
    b.onclick = () => view.dispatch({ effects: patchSet.of({ id: s.id, level: lvl }) });
    levels.appendChild(b);
  }
  panel.appendChild(levels);

  const list = document.createElement("ol");
  list.className = `vp-list vp-${s.level}`;
  s.variants.forEach((v, i) => {
    const li = document.createElement("li");
    li.className = (i === s.active ? "on " : "") + (v.by === "ai" ? "ai" : "me");
    li.title = (v.by === "ai" ? "Suggested by AI" : "Written by you") + (v.original ? " · original" : "");
    const txt = document.createElement("span");
    txt.className = "vp-text";
    txt.textContent = v.text;
    txt.onclick = () => { activate(view, s.id, i); view.focus(); };
    const x = document.createElement("button");
    x.className = "vp-x";
    x.textContent = "×";
    x.title = "Remove this version";
    x.onclick = () => removeVariant(view, s.id, i);
    li.append(txt, x);
    list.appendChild(li);
  });
  panel.appendChild(list);

  // The add box starts from the current version, so a new one can be an amendment.
  const add = document.createElement("textarea");
  add.id = "vp-add";
  add.rows = s.level === "paragraph" ? 7 : s.level === "sentence" ? 3 : 1;
  add.placeholder = "Another version…  ⏎";
  add.value = addDraft.id === s.id ? addDraft.text : s.variants[s.active].text;
  add.oninput = () => { addDraft = { id: s.id, text: add.value }; };
  add.onkeydown = e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addDraft = { id: null, text: "" };
      if (addVariant(view, s.id, add.value)) setTimeout(focusAddBox, 0);
    } else if (e.key === "Escape") {
      e.preventDefault();
      addDraft = { id: null, text: "" };
      view.focus();
    }
  };
  panel.appendChild(add);
  if (hadFocus) focusAddBox();

  const tools = document.createElement("div");
  tools.className = "vp-tools";
  const ai = document.createElement("button");
  ai.className = "vp-ai";
  ai.disabled = aiBusy === s.id;
  ai.textContent = aiBusy === s.id ? "◆ thinking…" : "◆ AI versions";
  ai.title = "Ask the model for alternatives (added beside yours, marked ◆)";
  ai.onclick = () => aiVersions(s.id);
  tools.appendChild(ai);
  if (s.variants.some((v, i) => v.by === "ai" && i !== s.active)) {
    const clear = document.createElement("button");
    clear.textContent = "clear AI versions";
    clear.onclick = () => clearAi(s.id);
    tools.appendChild(clear);
  }
  panel.appendChild(tools);

  // Earlier wordings, newest first. "use" brings one back as a version (the
  // current wording stays as a version too); × forgets it.
  if (s.history?.length) {
    const h = document.createElement("div");
    h.className = "vp-history";
    h.innerHTML = `<div class="vp-h-head">Earlier wordings</div>`;
    [...s.history].reverse().forEach(e => {
      const row = document.createElement("div");
      row.className = "vp-h-row";
      row.title = new Date(e.at).toLocaleString();
      const txt = document.createElement("span");
      txt.className = "vp-h-text";
      txt.textContent = e.text;
      const use = document.createElement("button");
      use.textContent = "use";
      use.title = "Bring this wording back as a version";
      use.onclick = () => {
        view.dispatch({ effects: patchSet.of({ id: s.id, history: s.history.filter(x => x !== e) }) });
        addVariant(view, s.id, e.text);
        view.focus();
      };
      const x = document.createElement("button");
      x.className = "vp-x";
      x.textContent = "×";
      x.title = "Forget this wording";
      x.onclick = () => view.dispatch({ effects: patchSet.of({ id: s.id, history: s.history.filter(y => y !== e) }) });
      row.append(txt, use, x);
      h.appendChild(row);
    });
    panel.appendChild(h);
  }

  const foot = document.createElement("p");
  foot.className = "vp-foot";
  foot.innerHTML = `<span class="me">•</span> yours &nbsp; <span class="ai">◆</span> AI`;
  panel.appendChild(foot);
}

// The paragraph(s) a set sits in, as context for the model.
function contextFor(s) {
  const d = view.state.doc;
  let a = d.lineAt(s.from), b = d.lineAt(s.to);
  if (s.level === "paragraph") {
    // Take in the neighbouring paragraphs too, so a new version still joins up.
    for (let n = 0; n < 2 && a.number > 1; n++) a = d.line(a.number - 1);
    for (let n = 0; n < 2 && b.number < d.lines; n++) b = d.line(b.number + 1);
  }
  return d.sliceString(a.from, b.to);
}

async function aiVersions(id) {
  const s = view.state.field(altsField).find(x => x.id === id);
  if (!s || aiBusy) return;
  aiBusy = id;
  lastPanelKey = "";
  renderVersions();
  status(s.level === "word" ? "AI · thinking…" : "AI · thinking (sentences and paragraphs take a little longer)…");
  try {
    const r = await api("/api/ai/versions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: s.level, target: s.variants[s.active].text, context: contextFor(s),
        existing: s.variants.map(v => v.text),
      }),
    });
    if (r.status !== 200) throw new Error(r.body.error || r.status);
    const now = view.state.field(altsField).find(x => x.id === id);
    if (!now) return;
    const have = new Set(now.variants.map(v => v.text.toLowerCase()));
    const extra = r.body.versions.filter(t => !have.has(t.toLowerCase())).map(text => ({ text, by: "ai" }));
    if (extra.length) {
      view.dispatch({ effects: patchSet.of({ id, variants: [...now.variants, ...extra] }) });
      status(`${extra.length} AI version${extra.length > 1 ? "s" : ""} added`);
    } else status("no new versions", "bad");
  } catch (err) {
    status("AI versions failed — " + err.message, "bad");
    if (aiOff) openSettings();
  } finally {
    aiBusy = null;
    lastPanelKey = "";
    renderVersions();
  }
}

function clearAi(id) {
  const s = view.state.field(altsField).find(x => x.id === id);
  if (!s) return;
  const keep = s.variants.map((v, i) => i).filter(i => s.variants[i].by !== "ai" || i === s.active);
  view.dispatch({
    effects: patchSet.of({ id, variants: keep.map(i => s.variants[i]), active: keep.indexOf(s.active) }),
  });
}

// ---- overflow panel (right) ----------------------------------------------

const overflow = $("#overflow-text");
overflow.addEventListener("input", () => markDirty("overflow"));

function stash(v) {
  const { from, to } = v.state.selection.main;
  if (from === to) return false;
  const text = v.state.sliceDoc(from, to).trim();
  const cur = overflow.value.replace(/\s+$/, "");
  overflow.value = (cur ? cur + "\n\n" : "") + text + "\n";
  markDirty("overflow");
  v.dispatch({ changes: { from, to }, userEvent: "delete.stash" });
  togglePanel("overflow", true);
  overflow.scrollTop = overflow.scrollHeight;
  return true;
}

$("#toggle-versions").onclick = () => togglePanel("versions");
$("#toggle-overflow").onclick = () => togglePanel("overflow");
$("#toggle-structure").onclick = () => structure.toggle();
$("#help").onclick = () => openHelp();

// The guide to every feature (web/help.html), in one reused tab.
function openHelp() {
  window.open("help.html", "writeon-help");
}

// ---- right-click menu -----------------------------------------------------

const menu = $("#menu");

function openMenu(e, v) {
  const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
  const sel = v.state.selection.main;
  if (pos != null && (sel.empty || pos < sel.from || pos > sel.to)) v.dispatch({ selection: { anchor: pos } });
  const s = v.state.selection.main;
  const g = ghostAt(v.state, s.from);
  const items = [
    ["Versions…", () => startVersions(v), true],
    ["AI versions", () => { const id = startVersions(v); if (id) aiVersions(id); }, true],
    g ? ["Revive", () => revive(v, s.from), true] : ["Ghost it", () => ghostSelection(v), !s.empty],
    ["Stash in overflow", () => stash(v), !s.empty],
    ["Move sentence up", () => sentenceEdit(moveSentence(v, -1)), s.empty],
    ["Move sentence down", () => sentenceEdit(moveSentence(v, 1)), s.empty],
    ["Split sentence here", () => sentenceEdit(splitSentence(v)), s.empty],
    ["Move paragraph up", () => sentenceEdit(moveParagraph(v, -1)), s.empty],
    ["Move paragraph down", () => sentenceEdit(moveParagraph(v, 1)), s.empty],
  ];
  menu.innerHTML = "";
  for (const [label, fn, enabled] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = !enabled;
    b.onclick = () => { closeMenu(); v.focus(); fn(); };
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + "px";
}

function closeMenu() {
  if (menu.hidden) return false;
  menu.hidden = true;
  return true;
}
addEventListener("mousedown", e => {
  if (!menu.contains(e.target)) closeMenu();
  if (!labMenu.contains(e.target) && e.target !== $("#toggle-lab")) closeLabMenu();
});
addEventListener("blur", closeMenu);

// ---- the Lab ---------------------------------------------------------------

const labMenu = $("#labmenu");
const labBar = $("#labbar");
let labRun = null; // {controller, title} while a pass is running
let labError = null;

const LAB_PASSES = [
  ["typos", "Fix punctuation and typos"],
  ["weak", "Mark the weakest sentences"],
  ["long", "Mark sentences that run long", "over 35 words"],
  ["convoluted", "Mark convoluted sentences"],
  ["tone", "Mark words that don't fit the tone"],
  ["hedges", "Mark hedges and filler"],
  ["voice", "Voice check", "against your voice notes"],
];
const LAB_TRIMS = [
  [null, "Original"],
  ["trim-slight", "Slight trim", "−10%"],
  ["trim-tighter", "Tighten more", "−20%"],
  ["trim-sharper", "Even sharper", "−35%"],
  ["trim-half", "Cut in half", "−50%"],
];

function labScope() {
  const s = view.state.selection.main;
  if (s.empty || wordCount(view.state.sliceDoc(s.from, s.to)) < 3) return null;
  return { from: s.from, to: s.to };
}

function openLabMenu() {
  if (!labMenu.hidden) return closeLabMenu();
  const scope = labScope();
  const where = scope ? `the selection (${wordCount(view.state.sliceDoc(scope.from, scope.to))} words)` : "the whole draft";
  const current = view.state.field(labField)?.task;
  labMenu.innerHTML = `<div class="lab-head">The Lab <span>on ${where}</span></div>`;
  for (const [task, label, hint] of LAB_PASSES) {
    const b = document.createElement("button");
    b.className = "lab-pass" + (current === task ? " on" : "");
    b.innerHTML = esc(label) + (hint ? ` <span>${esc(hint)}</span>` : "");
    b.onclick = () => runLab(task, label, scope);
    labMenu.appendChild(b);
  }
  const row = document.createElement("div");
  row.className = "lab-trims";
  for (const [task, label, hint] of LAB_TRIMS) {
    const b = document.createElement("button");
    b.className = (task ? current === task : !String(current).startsWith("trim")) ? "on" : "";
    b.innerHTML = `${esc(label)}${hint ? `<span>${hint}</span>` : ""}`;
    b.onclick = () => (task ? runLab(task, label, scope) : endLab());
    row.appendChild(b);
  }
  labMenu.appendChild(row);
  labMenu.hidden = false;
}

function closeLabMenu() {
  if (labMenu.hidden) return false;
  labMenu.hidden = true;
  return true;
}

$("#toggle-lab").onclick = openLabMenu;

async function runLab(task, title, scope) {
  closeLabMenu();
  labRun?.controller.abort();
  const controller = new AbortController();
  labRun = { controller, title };
  labError = null;
  const text = view.state.doc.toString();
  view.dispatch({ effects: setLab.of(null) });
  renderLabBar();
  try {
    const r = await api("/api/lab", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ task, text, from: scope?.from ?? 0, to: scope?.to ?? text.length }),
    });
    if (labRun?.controller !== controller) return;
    labRun = null;
    if (r.status !== 200) throw new Error(r.body.error || r.status);
    const items = placeItems(view, text, r.body.items);
    view.dispatch({ effects: setLab.of({ ...r.body, items, cur: items.length ? 0 : -1, walking: false }) });
    if (r.body.kind !== "trim" && items.length) reveal(items[0]);
  } catch (err) {
    if (err.name === "AbortError") return;
    labRun = null;
    labError = `${title} failed — ${err.message}`;
    renderLabBar();
    if (aiOff && task !== "long") openSettings();
  }
}

function endLab() {
  labRun?.controller.abort();
  labRun = null;
  labError = null;
  view.dispatch({ effects: setLab.of(null) });
  renderLabBar();
  view.focus();
}

function reveal(it) {
  if (it) view.dispatch({ effects: EditorView.scrollIntoView(it.from, { y: "center" }) });
}

const curItem = () => {
  const lab = view.state.field(labField);
  return lab?.items[lab.cur];
};

function step(dir) {
  const lab = view.state.field(labField);
  if (!lab || !lab.items.length) return;
  const cur = (lab.cur + dir + lab.items.length) % lab.items.length;
  view.dispatch({ effects: patchLab.of({ cur }) });
  reveal(lab.items[cur]);
}

function button(label, fn, cls = "") {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = fn;
  return b;
}

const span = (cls, text) => Object.assign(document.createElement("span"), { className: cls, textContent: text });

function renderLabBar() {
  const lab = view.state.field(labField);
  labBar.innerHTML = "";
  if (labRun) {
    labBar.hidden = false;
    labBar.append(span("lab-title", labRun.title), span("lab-note busy", "reading…"), button("Cancel", endLab));
    return;
  }
  if (labError) {
    labBar.hidden = false;
    labBar.append(span("lab-note bad", labError), button("Close", () => { labError = null; renderLabBar(); }));
    return;
  }
  if (!lab) { labBar.hidden = true; return; }
  labBar.hidden = false;
  const it = lab.items[lab.cur];

  if (lab.kind === "trim") {
    if (lab.walking && it) {
      labBar.append(span("lab-title", lab.title),
        span("lab-note", `${lab.cur + 1} of ${lab.items.length}${it.note ? " — " + it.note : ""}`),
        button("Cut", () => { cut(view, [it]); reveal(curItem()); }, "primary"),
        button("Keep", () => { view.dispatch({ effects: dropItems.of([it.id]) }); reveal(curItem()); }),
        button("Stop", () => view.dispatch({ effects: patchLab.of({ walking: false }) })));
      return;
    }
    const before = wordCount(view.state.doc.toString());
    const after = wordsAfterCuts(view.state);
    const pct = before ? Math.round((100 * (before - after)) / before) : 0;
    labBar.append(span("lab-title", lab.title), span("lab-note", lab.items.length
      ? `${before.toLocaleString()} → ${after.toLocaleString()} words (−${pct}%). Faded passages would go — click one to keep it.`
      : "Nothing left to cut."));
    if (lab.items.length) {
      labBar.append(
        button("Make the cuts", () => cut(view, view.state.field(labField).items), "primary"),
        button("Ghost them", () => ghostItems(view, view.state.field(labField).items)),
        button("Walk through", () => { view.dispatch({ effects: patchLab.of({ walking: true, cur: 0 }) }); reveal(curItem()); }),
      );
    }
    labBar.append(button("Done", endLab));
    return;
  }

  if (!lab.items.length) {
    labBar.append(span("lab-title", lab.title), span("lab-note", lab.summary || "Nothing found."), button("Done", endLab));
    return;
  }
  labBar.append(span("lab-title", lab.title), button("‹", () => step(-1)),
    span("lab-count", `${lab.cur + 1} / ${lab.items.length}`), button("›", () => step(1)),
    span("lab-note", it?.note || ""));
  if (lab.kind === "fixes" && it) {
    labBar.append(
      button("Accept", () => { applyFix(view, it); reveal(curItem()); }, "primary"),
      button("Skip", () => { view.dispatch({ effects: dropItems.of([it.id]) }); reveal(curItem()); }),
      button("Accept all", () => { for (const x of [...view.state.field(labField).items].reverse()) applyFix(view, x); }),
    );
  }
  labBar.append(button("Done", endLab));
  if (lab.summary) labBar.append(span("lab-sum", lab.summary));
}

// ---- file picker -------------------------------------------------------------

const picker = $("#picker");
let files = [];
let pickIndex = 0;

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 60) return `${Math.round(d / 86400)}d`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

async function openPicker() {
  const r = await api("/api/files");
  files = r.body.files;
  picker.hidden = false;
  const box = $("#pick-q");
  box.value = "";
  pickIndex = 0;
  renderPicker();
  box.focus();
}

function closePicker() {
  picker.hidden = true;
  view.focus();
}

function matches() {
  const words = $("#pick-q").value.toLowerCase().split(/\s+/).filter(Boolean);
  return files.filter(f => words.every(w => f.path.toLowerCase().includes(w))).slice(0, 200);
}

function renderPicker() {
  const list = $("#pick-list");
  const m = matches();
  pickIndex = Math.min(pickIndex, Math.max(0, m.length - 1));
  const typed = $("#pick-q").value.trim();
  list.innerHTML = m.length ? "" : typed
    ? `<li class="none">⏎ to create “${esc(typed)}”</li>`
    : `<li class="none">No documents yet.</li>`;
  m.forEach((f, i) => {
    const li = document.createElement("li");
    const slash = f.path.lastIndexOf("/");
    li.className = (i === pickIndex ? "on " : "") + (f.path === doc.path ? "current" : "");
    li.innerHTML = `<span class="pk-dir">${esc(slash >= 0 ? f.path.slice(0, slash + 1) : "")}</span><span class="pk-name">${esc(f.path.slice(slash + 1).replace(/\.md$/, ""))}</span><span class="pk-age">${ago(f.mtime)}</span>`;
    li.onmousedown = e => { e.preventDefault(); choose(f.path); };
    list.appendChild(li);
  });
  list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

async function choose(path) {
  closePicker();
  if (path === doc.path) return;
  await save();
  open(path);
}

$("#pick-q").addEventListener("input", () => { pickIndex = 0; renderPicker(); });
$("#pick-q").addEventListener("keydown", e => {
  const m = matches();
  if (e.key === "ArrowDown") { pickIndex = Math.min(pickIndex + 1, m.length - 1); renderPicker(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { pickIndex = Math.max(pickIndex - 1, 0); renderPicker(); e.preventDefault(); }
  else if (e.key === "Enter" && m[pickIndex]) { choose(m[pickIndex].path); e.preventDefault(); }
  else if (e.key === "Enter" && e.target.value.trim()) { newDoc(e.target.value); e.preventDefault(); }
  else if (e.key === "Escape") { closePicker(); e.preventDefault(); }
});
picker.addEventListener("mousedown", e => { if (e.target === picker) closePicker(); });
$("#title").onclick = openPicker;
addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "o" && !view.hasFocus) { e.preventDefault(); openPicker(); }
});

// ---- documents: new, import, rename, download, delete -----------------------

async function newDoc(name = "Untitled", text = "") {
  closePicker();
  await save();
  const r = await post("/api/new", { name, text });
  if (r.status !== 200) return status(r.body.error || "could not create", "bad");
  open(r.body.path);
}

async function renameDoc() {
  if (!doc.path) return;
  const name = prompt("Rename this document", doc.path.replace(/\.md$/, ""));
  if (name == null) return;
  await save();
  const r = await post("/api/rename", { path: doc.path, name });
  if (r.status !== 200) return alert(r.body.error || "could not rename");
  closePicker();
  if (r.body.path !== doc.path) open(r.body.path);
}

async function deleteDoc() {
  if (!doc.path || !confirm(`Delete “${doc.path.replace(/\.md$/, "")}”? It goes to the .trash folder inside your Spit n Polish folder.`)) return;
  clearTimeout(saveTimer);
  doc.dirty = { text: false, alts: false, overflow: false };
  const r = await post("/api/delete", { path: doc.path });
  if (r.status !== 200) return alert(r.body.error || "could not delete");
  doc.path = null;
  closePicker();
  const left = (await api("/api/files")).body.files;
  if (left.length) open(left[0].path);
  else newDoc();
}

function download(name, text, type = "text/markdown") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// The .md as it stands, ghosted text included as %%…%% (Obsidian hides it in
// reading view); "clean" leaves the ghosts out.
async function downloadDoc(clean = false) {
  await save();
  let text = view.state.doc.toString();
  if (clean) text = text.replace(/%%[\s\S]*?%%/g, "").replace(/[ \t]{2,}/g, " ");
  download(doc.path.replace(/\.md$/, clean ? " (clean).md" : ".md"), text);
}

// .md files become documents (an X.alts.json or X.overflow.md picked alongside
// X.md comes with it), under a free name, so nothing is ever overwritten.
async function importFiles(fileList) {
  const files = [...fileList];
  const read = f => f.text();
  const byName = new Map(files.map(f => [f.name, f]));
  let last = null, n = 0;
  for (const f of files) {
    try {
      if (!/\.(md|markdown|txt)$/i.test(f.name) || /\.overflow\.md$/i.test(f.name)) continue;
      const stem = f.name.replace(/\.(md|markdown|txt)$/i, "");
      const altsFile = byName.get(`${stem}.alts.json`);
      const ovFile = byName.get(`${stem}.overflow.md`);
      const r = await post("/api/new", {
        name: stem, text: await read(f),
        alts: altsFile ? JSON.parse(await read(altsFile)) : null,
        overflow: ovFile ? await read(ovFile) : "",
      });
      if (r.status !== 200) throw new Error(r.body.error);
      last = r.body.path;
      n++;
    } catch (e) {
      alert(`Couldn't import ${f.name}: ${e.message}`);
    }
  }
  if (last) {
    closePicker();
    await save();
    open(last);
    status(`imported ${n} document${n === 1 ? "" : "s"}`, "ok");
  }
}

$("#pk-new").onclick = () => newDoc($("#pick-q").value.trim() || "Untitled");
$("#pk-import").onclick = () => $("#pk-file").click();
$("#pk-file").onchange = e => { importFiles(e.target.files); e.target.value = ""; };
$("#pk-rename").onclick = renameDoc;
$("#pk-download").onclick = () => downloadDoc(false);
$("#pk-clean").onclick = () => downloadDoc(true);
$("#pk-delete").onclick = deleteDoc;

// Drop .md files anywhere on the page to import them.
addEventListener("dragover", e => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
addEventListener("drop", e => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  importFiles(e.dataTransfer.files);
});

// ---- settings ---------------------------------------------------------------

const settingsBox = $("#settings");

let aiOff = false; // no way to reach Claude: AI failures open Settings

async function openSettings() {
  const { body: s } = await api("/api/settings");
  aiOff = !s.engine;
  $("#set-model").value = s.deepModel;
  $("#set-voice").value = s.voice;
  $("#set-folder").textContent = s.folder;
  $("#set-engine").textContent = s.engineNote;
  $("#set-engine").className = s.engine ? "" : "bad";
  settingsBox.hidden = false;
  $("#set-voice").focus();
}

async function closeSettings() {
  settingsBox.hidden = true;
  view.focus();
  const r = await api("/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deepModel: $("#set-model").value, voice: $("#set-voice").value }),
  });
  if (r.status !== 200) status("settings not saved — " + (r.body.error || r.status), "bad");
}

$("#open-settings").onclick = openSettings;
$("#set-done").onclick = closeSettings;
settingsBox.addEventListener("mousedown", e => { if (e.target === settingsBox) closeSettings(); });
settingsBox.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); closeSettings(); } });

// ---- loading & saving -----------------------------------------------------

const api = (path, opts) => fetch(path, opts).then(async r => ({ status: r.status, body: await r.json() }));
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

// The structure view (paragraph cards and the reverse outline). ⌥⌘O opens and
// closes it from anywhere; the editor is blurred while it's up so typing can't
// land in a hidden draft.
const structure = initStructure({ view, api, status });
addEventListener("keydown", e => {
  // ⌘ on the Mac; Ctrl elsewhere.
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod && !e.altKey && e.key === "/" && !view.hasFocus) { e.preventDefault(); openHelp(); }
  if (mod && e.altKey && e.code === "KeyO") {
    e.preventDefault();
    e.stopPropagation();
    structure.toggle();
  }
}, true);

function status(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = cls;
}

let saveTimer = null;
function markDirty(part) {
  doc.dirty[part] = true;
  status("editing");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

function serializeAlts() {
  const text = view.state.doc.toString();
  const sets = view.state.field(altsField)
    .filter(s => s.variants.length > 1 || s.history?.length)
    .map(({ from, to, ...s }) => ({ ...s, anchor: makeAnchor(text, from, to) }));
  return { version: 1, sets: [...sets, ...doc.orphans] };
}

async function save(force = false) {
  clearTimeout(saveTimer);
  const d = doc.dirty;
  if (!doc.path || doc.saving || (!d.text && !d.alts && !d.overflow)) return;
  if (doc.conflict && !force) return;
  const body = { path: doc.path, force };
  if (d.text) Object.assign(body, { text: view.state.doc.toString(), baseMtime: doc.mtime });
  if (d.text || d.alts) body.alts = serializeAlts();
  if (d.overflow) Object.assign(body, { overflow: overflow.value, overflowBaseMtime: doc.overflowMtime });
  doc.saving = true;
  doc.dirty = { text: false, alts: false, overflow: false };
  status("saving…");
  const restore = () => {
    doc.dirty = { text: d.text || doc.dirty.text, alts: d.alts || doc.dirty.alts, overflow: d.overflow || doc.dirty.overflow };
  };
  try {
    const r = await api("/api/doc", {
      method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (r.status === 409) {
      restore();
      showConflict(r.body.conflict);
      return;
    }
    if (r.status !== 200) throw new Error(r.body.error || r.status);
    doc.mtime = r.body.mtime;
    doc.overflowMtime = r.body.overflowMtime;
    doc.conflict = false;
    $("#banner").hidden = true;
    status("saved", "ok");
  } catch (err) {
    restore();
    status("not saved — " + err.message, "bad");
  } finally {
    doc.saving = false;
    if (Object.values(doc.dirty).some(Boolean) && !doc.conflict) saveTimer = setTimeout(save, 1200);
  }
}

function showConflict(which) {
  doc.conflict = true;
  status("conflict", "bad");
  const b = $("#banner");
  b.innerHTML = `This ${which === "overflow" ? "overflow file" : "draft"} was changed outside Spit n Polish (another editor or tab) while you were editing.
    <button id="take-theirs">Load that version</button> <button id="keep-mine">Keep mine and overwrite</button>`;
  b.hidden = false;
  $("#take-theirs").onclick = () => open(doc.path, { keepView: true });
  $("#keep-mine").onclick = () => { doc.conflict = false; b.hidden = true; save(true); };
}

// Replace the editor text with `next` as one minimal change, so the cursor and
// the alternatives' positions survive a reload from disk.
function applyExternal(next) {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let a = 0;
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  view.dispatch({
    changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) },
    annotations: [external.of(true), Transaction.addToHistory.of(false)],
  });
}

const q = p => `?path=${encodeURIComponent(p)}`;

async function open(path, { keepView = false } = {}) {
  const r = await api(`/api/doc${q(path)}`);
  if (r.status !== 200) { status(r.body.error || "could not open", "bad"); return; }
  const d = r.body;
  clearTimeout(saveTimer);
  Object.assign(doc, {
    path, mtime: d.mtime, overflowMtime: d.overflowMtime,
    dirty: { text: false, alts: false, overflow: false }, conflict: false,
  });
  $("#banner").hidden = true;
  overflow.value = d.overflow;

  if (keepView) {
    applyExternal(d.text);
  } else {
    labRun?.controller.abort();
    labRun = null;
    labError = null;
    addDraft = { id: null, text: "" };
    structure.reset();
    const { placed, orphans } = placeSets(d.text, d.alts.sets || []);
    doc.orphans = orphans;
    view.setState(EditorState.create({ doc: d.text, extensions: baseExtensions() }));
    view.dispatch({
      effects: [loadSets.of(placed), setUi.of({ on: readOn() })],
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
    lastPanelKey = "";
    renderVersions();
    renderLabBar();
    if (orphans.length) status(`${orphans.length} set(s) of versions no longer match the text — kept in the file`, "bad");
    else status("saved", "ok");
  }
  renderCount();
  const slash = path.lastIndexOf("/");
  $("#title").innerHTML = `<span class="pk-dir">${esc(slash >= 0 ? path.slice(0, slash + 1) : "")}</span>${esc(path.slice(slash + 1).replace(/\.md$/, ""))} <span class="pk-caret">▾</span>`;
  $("#title").title = `${path} — ⌘O to open, create or import a document`;
  document.title = `${path.slice(slash + 1).replace(/\.md$/, "")} · Spit n Polish`;
  window.history.replaceState(null, "", `?d=${encodeURIComponent(path)}`);
  try { localStorage.setItem("wo-last", path); } catch {}
  view.focus();
}

function readOn() {
  try { return localStorage.getItem("wo-on") !== "0"; } catch { return true; }
}

// Pick up edits made in another editor (or tab) while this is open.
setInterval(async () => {
  if (!doc.path || doc.saving || doc.conflict) return;
  const r = await api(`/api/stat${q(doc.path)}`).catch(() => null);
  if (!r || r.status !== 200 || doc.saving) return;
  if (r.body.mtime !== doc.mtime) {
    if (doc.dirty.text) return showConflict("draft");
    const d = (await api(`/api/doc${q(doc.path)}`)).body;
    if (doc.saving || doc.dirty.text) return;
    doc.mtime = d.mtime;
    applyExternal(d.text);
  }
  if (r.body.overflowMtime !== doc.overflowMtime) {
    if (doc.dirty.overflow) return showConflict("overflow");
    const d = (await api(`/api/doc${q(doc.path)}`)).body;
    if (doc.saving || doc.dirty.overflow) return;
    doc.overflowMtime = d.overflowMtime;
    overflow.value = d.overflow;
  }
}, 2500);

// Closing the tab saves on the way out (keepalive lets the request outlive the
// page); only an unresolved conflict asks before leaving.
addEventListener("beforeunload", e => {
  if (doc.conflict) e.preventDefault();
  else if (Object.values(doc.dirty).some(Boolean)) save();
});

// ---- boot -----------------------------------------------------------------

(async () => {
  document.body.classList.toggle("wo-off", !readOn());
  api("/api/settings").then(r => { aiOff = !r.body.engine; });
  let { body } = await api("/api/files");
  if (!body.files.length) {
    await post("/api/new", { name: "Untitled" });
    ({ body } = await api("/api/files"));
  }
  const paths = body.files.map(f => f.path);
  const want = new URLSearchParams(location.search).get("d");
  let last = null;
  try { last = localStorage.getItem("wo-last"); } catch {}
  const first = [want, last].find(p => p && paths.includes(p)) || paths.find(p => /-draft\.md$/.test(p)) || paths[0];
  if (!first) { status("no documents", "bad"); return; }
  open(first);
})();
