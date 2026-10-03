// The structure view: the draft as a column of paragraph cards — first sentence
// in full, the rest faded — to drag into a new order, with a reverse outline
// (one line per paragraph from the model) beside them. The outline lines are
// shown here only; they never enter the draft.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { paragraphRanges, relocateParagraph, sentenceRanges } from "./sentences.js";
import { wordCount } from "./ghost.js";

const GHOST = /%%[\s\S]*?%%/g;
const $ = sel => document.querySelector(sel);
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function initStructure({ view, api, status }) {
  const root = $("#structure");
  const said = new Map(); // paragraph text -> {says, role}
  let busy = false, error = null, dragFrom = null;

  const isOpen = () => !root.hidden;

  function toggle(force) {
    const open = force ?? root.hidden;
    root.hidden = !open;
    document.body.classList.toggle("wo-structure-open", open);
    if (open) { view.contentDOM.blur(); render(); root.focus(); }
    else view.focus();
    return true;
  }

  function paragraphs() {
    return paragraphRanges(view.state.doc).map(r => ({ ...r, text: view.state.sliceDoc(r.from, r.to) }));
  }

  function render() {
    if (!isOpen()) return;
    const paras = paragraphs();
    const known = paras.filter(p => said.has(p.text)).length;
    const stale = said.size > 0 && known < paras.length;
    root.innerHTML = `
      <div class="st-bar">
        <span class="st-title">Structure</span>
        <span class="st-sub">${paras.length} paragraphs · drag to reorder · click to go there</span>
        <button class="st-ai" ${busy ? "disabled" : ""}>${busy ? "Outlining…" : said.size ? "◆ Redo the outline" : "◆ Reverse outline"}</button>
        <button class="st-close" title="Back to the draft (Esc or ⌥⌘O)">Back to the draft</button>
      </div>
      ${error ? `<p class="st-note bad">${esc(error)}</p>` : ""}
      ${stale && !busy ? `<p class="st-note">${paras.length - known} paragraph${paras.length - known === 1 ? " has" : "s have"} changed since the outline.</p>` : ""}
      <ol class="st-list"></ol>`;
    root.querySelector(".st-ai").onclick = runOutline;
    root.querySelector(".st-close").onclick = () => toggle(false);
    const list = root.querySelector(".st-list");
    paras.forEach((p, i) => list.appendChild(card(p, i)));
  }

  function card(p, i) {
    const li = document.createElement("li");
    const shown = p.text.replace(GHOST, "").trim();
    const head = /^#/.test(shown);
    li.className = "st-card" + (head ? " st-head" : "") + (!shown ? " st-ghost" : "");
    li.draggable = true;
    li.dataset.i = i;
    let body;
    if (head) body = `<span class="st-first">${esc(shown.replace(/^#+\s*/, ""))}</span>`;
    else {
      const t = shown || p.text.replace(/%%/g, "");
      const first = sentenceRanges(t.split("\n")[0])[0];
      const cut = first ? first.to : t.length;
      body = `<span class="st-first">${esc(t.slice(0, cut))}</span> <span class="st-rest">${esc(t.slice(cut).trim())}</span>`;
    }
    const s = said.get(p.text);
    li.innerHTML = `
      <div class="st-text">${body}</div>
      <div class="st-side">
        <div class="st-meta">${head ? "heading" : shown ? `¶${i + 1} · ${wordCount(p.text)} words` : "ghosted"}</div>
        ${s?.says ? `<div class="st-says">${s.role ? `<span class="st-role">${esc(s.role)}</span>` : ""}${esc(s.says)}</div>` : ""}
      </div>`;
    li.onclick = () => jump(i);
    li.ondragstart = e => { dragFrom = i; li.classList.add("st-dragging"); e.dataTransfer.effectAllowed = "move"; };
    li.ondragend = () => { dragFrom = null; li.classList.remove("st-dragging"); clearMarks(); };
    li.ondragover = e => {
      if (dragFrom == null) return;
      e.preventDefault();
      clearMarks();
      li.classList.add(below(e, li) ? "st-drop-after" : "st-drop-before");
    };
    li.ondrop = e => {
      e.preventDefault();
      if (dragFrom == null) return;
      let k = i + (below(e, li) ? 1 : 0);
      if (dragFrom < k) k--;
      const from = dragFrom;
      dragFrom = null;
      if (k === from) return render();
      const r = relocateParagraph(view, from, k);
      if (r !== true) status(`Can't: ${r}`);
      render();
    };
    return li;
  }

  const below = (e, el) => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  const clearMarks = () => root.querySelectorAll(".st-drop-before, .st-drop-after")
    .forEach(el => el.classList.remove("st-drop-before", "st-drop-after"));

  function jump(i) {
    const p = paragraphs()[i];
    if (!p) return;
    toggle(false);
    // A frame later, once the editor is measurable again.
    requestAnimationFrame(() => view.dispatch({
      selection: EditorSelection.cursor(p.from),
      effects: EditorView.scrollIntoView(p.from, { y: "start", yMargin: 80 }),
    }));
  }

  async function runOutline() {
    if (busy) return;
    const paras = paragraphs();
    busy = true; error = null;
    render();
    try {
      const r = await api("/api/outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs: paras.map(p => p.text) }),
      });
      if (r.status !== 200) throw new Error(r.body.error || `HTTP ${r.status}`);
      said.clear();
      r.body.outline.forEach((o, i) => { if (paras[i]) said.set(paras[i].text, o); });
    } catch (e) {
      error = `The outline failed: ${e.message}`;
    }
    busy = false;
    render();
  }

  addEventListener("keydown", e => {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); toggle(false); }
  });

  // A new file starts with no outline.
  const reset = () => { said.clear(); error = null; render(); };

  return { toggle, isOpen, render, reset };
}
