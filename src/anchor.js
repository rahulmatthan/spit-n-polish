// Anchors tie an alternatives set in NNN-draft.alts.json to a spot in the prose.
// The draft is edited in Obsidian too, so character offsets would rot; instead we
// store the active text plus a little context either side (like a W3C
// TextQuoteSelector) and find the best match again on load.

const CTX = 32;

export function makeAnchor(doc, from, to) {
  return {
    prefix: doc.slice(Math.max(0, from - CTX), from),
    suffix: doc.slice(to, to + CTX),
  };
}

function sharedTail(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedHead(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Find `text` in `doc`, preferring the occurrence whose surroundings best match
// the anchor. Returns {from, to, score} or null.
export function locate(doc, text, anchor = {}) {
  if (!text) return null;
  const prefix = anchor.prefix || "", suffix = anchor.suffix || "";
  let best = null;
  for (let i = doc.indexOf(text); i !== -1; i = doc.indexOf(text, i + 1)) {
    const end = i + text.length;
    const score =
      sharedTail(doc.slice(Math.max(0, i - prefix.length), i), prefix) +
      sharedHead(doc.slice(end, end + suffix.length), suffix);
    if (!best || score > best.score) best = { from: i, to: end, score };
  }
  return best;
}

// Place every stored set back into the document. A set whose active text is gone
// (rewritten in Obsidian) is tried against its other versions; if none is found it
// is returned as an orphan and preserved untouched in the file.
export function placeSets(doc, stored) {
  const placed = [], orphans = [];
  for (const s of stored) {
    const order = [s.active, ...s.variants.map((_, i) => i).filter(i => i !== s.active)];
    let hit = null;
    for (const i of order) {
      const r = locate(doc, s.variants[i]?.text, s.anchor);
      if (r && (!hit || r.score > hit.r.score)) hit = { r, i };
      if (hit && i === s.active) break; // active text found: trust it
    }
    if (hit) {
      const { anchor, ...rest } = s;
      placed.push({ ...rest, active: hit.i, from: hit.r.from, to: hit.r.to });
    } else orphans.push(s);
  }
  return { placed, orphans };
}
