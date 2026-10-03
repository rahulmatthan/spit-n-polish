// Shortcut labels are written Mac-style (⌘;  ⌥⌘V  ⌃⌥↑). Everywhere else the
// keys are Ctrl/Alt/Shift (CodeMirror's Mod- is Ctrl there), so relabel them. Loaded by index.html and
// help.html; does nothing on a Mac. Never touches the draft itself.
(() => {
  if (/Mac/.test(navigator.platform)) return;
  const NAMES = [["⌃", "Ctrl"], ["⌘", "Ctrl"], ["⌥", "Alt"], ["⇧", "Shift"]];
  const relabel = s => s
    .replace(/([⌃⌥⇧⌘]+)([⏎↩]?)/g, (_, mods, enter) => {
      const names = [...new Set(NAMES.filter(([sym]) => mods.includes(sym)).map(([, n]) => n))];
      return names.join("+") + "+" + (enter ? "Enter" : "");
    });
  const SYM = /[⌃⌥⇧⌘]/;

  function walk(root) {
    if (root.nodeType === 3) {
      if (SYM.test(root.data) && !root.parentElement?.closest(".cm-content")) root.data = relabel(root.data);
      return;
    }
    if (root.nodeType !== 1 || root.closest?.(".cm-content")) return;
    for (const el of [root, ...root.querySelectorAll("[title]")]) {
      const t = el.getAttribute?.("title");
      if (t && SYM.test(t)) el.setAttribute("title", relabel(t));
    }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement?.closest(".cm-content") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n; (n = it.nextNode());) if (SYM.test(n.data)) n.data = relabel(n.data);
  }

  const start = () => {
    walk(document.body);
    new MutationObserver(ms => {
      for (const m of ms) {
        if (m.type === "attributes") walk(m.target);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  };
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", start) : start();
})();
