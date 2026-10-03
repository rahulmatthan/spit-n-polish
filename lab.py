"""The Lab and AI versions — everything that talks to a model.

Every model answer is a list of QUOTES from the text, which are located here and
returned as character offsets. Nothing the model says is ever written into the
draft directly: marks are just marks, trims are proposed deletions the writer
accepts or rejects, and versions land in the versions list beside their own.

Two ways to reach Claude:

  claude   the Claude Code command (`claude -p`) on the writer's own Claude
           subscription — no API key. Tools, MCP servers and hooks are switched off.
  api      the Anthropic API with ANTHROPIC_API_KEY, through the `anthropic`
           package (pip install anthropic).

ENGINE "auto" uses Claude Code when it is installed, the API otherwise.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile

ENGINE = "auto"
DEEP = "opus"      # sentence / paragraph versions, marks, trims, outline
VOICE = ""         # the writer's notes on their own voice

# Claude Code takes aliases; the API takes model ids.
CLI_MODELS = {"sonnet": "sonnet", "opus": "opus"}
API_MODELS = {"sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}

SYSTEM = (
    "You are an editor working alongside a writer on their own prose. "
    "You follow the task literally. You never invent text that you claim to quote: "
    "every quote you return is copied verbatim, character for character, from the "
    "supplied text. Keep the writer's spelling conventions (British, American or other) "
    "exactly as they are. You output raw JSON only: no prose, no markdown fence."
)

GHOST = re.compile(r"%%[\s\S]*?%%")


class LabError(Exception):
    pass


def configure(deep: str, voice: str):
    global DEEP, VOICE
    DEEP = deep if deep in CLI_MODELS else "opus"
    VOICE = voice or ""


# ---------------------------------------------------------------- engines

def _has_sdk() -> bool:
    try:
        import anthropic  # noqa: F401
        return True
    except ImportError:
        return False


def engine() -> str | None:
    if ENGINE in ("auto", "claude") and shutil.which("claude"):
        return "claude"
    if ENGINE in ("auto", "api") and os.environ.get("ANTHROPIC_API_KEY") and _has_sdk():
        return "api"
    return None


def engine_status() -> tuple[str | None, str]:
    e = engine()
    if e == "claude":
        return e, "Claude Code (your Claude subscription)"
    if e == "api":
        return e, "the Anthropic API (ANTHROPIC_API_KEY)"
    if ENGINE == "claude":
        return None, "off — the claude command (Claude Code) was not found"
    if ENGINE == "api" and not os.environ.get("ANTHROPIC_API_KEY"):
        return None, "off — ANTHROPIC_API_KEY is not set"
    if ENGINE == "api":
        return None, "off — run: pip install anthropic"
    return None, "off — install Claude Code, or set ANTHROPIC_API_KEY and pip install anthropic"


def call(prompt: str, depth: str = "fast", timeout: int = 240):
    tier = "sonnet" if depth == "fast" else DEEP
    e = engine()
    if e == "claude":
        body = _call_cli(prompt, CLI_MODELS[tier], timeout)
    elif e == "api":
        body = _call_api(prompt, API_MODELS[tier], depth, timeout)
    else:
        raise LabError("AI is " + engine_status()[1] + " (see Settings ⚙)")
    body = re.sub(r"^```(?:json)?|```$", "", body.strip(), flags=re.M).strip()
    m = re.search(r"[\[{].*[\]}]", body, re.S)
    if not m:
        raise LabError(f"no JSON in reply: {body[:200]}")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as err:
        raise LabError(f"bad JSON in reply: {err}")


def _call_cli(prompt: str, model: str, timeout: int) -> str:
    cmd = [
        "claude", "-p", prompt,
        "--model", model,
        "--system-prompt", SYSTEM,
        "--tools", "",
        "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
        "--settings", '{"disableAllHooks":true}',
        "--no-session-persistence",
        "--output-format", "json",
    ]
    try:
        # Run outside any project so no CLAUDE.md is picked up.
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=tempfile.gettempdir())
    except FileNotFoundError:
        raise LabError("the claude command was not found on PATH")
    except subprocess.TimeoutExpired:
        raise LabError("the model took too long — try a smaller selection")
    if r.returncode != 0:
        out = (r.stderr or r.stdout)[:300]
        if "login" in out.lower() or "auth" in out.lower():
            raise LabError("Claude Code isn't signed in — run `claude` once in a terminal and log in")
        raise LabError(f"claude exited {r.returncode}: {out}")
    try:
        return json.loads(r.stdout).get("result") or ""
    except json.JSONDecodeError:
        raise LabError(f"unreadable reply: {r.stdout[:200]}")


def _call_api(prompt: str, model: str, depth: str, timeout: int) -> str:
    import anthropic

    client = anthropic.Anthropic(timeout=timeout)
    try:
        r = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            system=SYSTEM,
            # Short, literal tasks: keep thinking light so answers come back quickly.
            output_config={"effort": "low" if depth == "fast" else "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.AuthenticationError:
        raise LabError("ANTHROPIC_API_KEY was not accepted")
    except anthropic.RateLimitError:
        raise LabError("rate limited by the API — wait a moment and try again")
    except anthropic.APIStatusError as err:
        raise LabError(f"API error {err.status_code}: {err.message}")
    except anthropic.APIConnectionError:
        raise LabError("couldn't reach the Anthropic API")
    if r.stop_reason == "refusal":
        raise LabError("the model declined this text")
    return "".join(b.text for b in r.content if b.type == "text")


def voice_brief() -> str:
    v = VOICE.strip()
    return f"\n\nThe writer's notes on their own voice — follow them:\n{v}" if v else ""


# ---------------------------------------------------------------- locating quotes

_FOLD = {"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " "}


def _folded(s: str) -> tuple[str, list[int]]:
    """Normalise quotes/dashes/whitespace, keeping a map back to original indices."""
    out, idx, prev_space = [], [], False
    for i, ch in enumerate(s):
        ch = _FOLD.get(ch, ch)
        if ch.isspace():
            if prev_space:
                continue
            ch, prev_space = " ", True
        else:
            prev_space = False
        out.append(ch.lower())
        idx.append(i)
    return "".join(out), idx


def ghost_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in GHOST.finditer(text)]


def locate_all(text: str, quotes: list[str], lo: int = 0, hi: int | None = None) -> list[tuple[int, int] | None]:
    """Find each quote in text[lo:hi], in order, outside ghosted text."""
    hi = len(text) if hi is None else hi
    hay, idx = _folded(text)
    ghosts = ghost_spans(text)
    in_ghost = lambda a, b: any(g0 < b and a < g1 for g0, g1 in ghosts)
    out, cursor = [], lo
    for q in quotes:
        needle = _folded(q.strip())[0]
        if len(needle) < 2:
            out.append(None)
            continue
        found = None
        # Prefer the first match after the previous quote; fall back to anywhere.
        for start in (cursor, lo):
            j = 0
            while True:
                k = hay.find(needle, j)
                if k < 0:
                    break
                a, b = idx[k], idx[k + len(needle) - 1] + 1
                if a >= start and lo <= a and b <= hi and not in_ghost(a, b):
                    found = (a, b)
                    break
                j = k + 1
            if found:
                break
        out.append(found)
        if found:
            cursor = found[1]
    return out


def visible(text: str) -> str:
    """The text with ghosted passages removed, as the model should read it."""
    return re.sub(r"[ \t]{2,}", " ", GHOST.sub("", text))


def words(s: str) -> int:
    return len(re.findall(r"[\w’'-]+", visible(s)))


# ---------------------------------------------------------------- versions

VERSION_COUNTS = {"word": 6, "sentence": 3, "paragraph": 2}


def versions(level: str, target: str, context: str, existing: list[str]) -> list[str]:
    n = VERSION_COUNTS.get(level, 3)
    marked = context.replace(target, f"⟦{target}⟧", 1) if target in context else f"⟦{target}⟧"
    avoid = "\n".join(f"- {e}" for e in existing) or "(none)"
    if level == "word":
        prompt = f"""In the passage below, the text between ⟦ and ⟧ is a word or short phrase the writer is unsure of.

Suggest {n} alternatives that could replace it exactly where it stands: they must fit the grammar of the sentence as written (same part of speech, number and tense) and keep its meaning, while offering different shades — plainer, more precise, more vivid. Single words where the original is a single word.

Do not repeat any of these, which the writer already has:
{avoid}

Passage:
{visible(marked)}

Return a JSON array of {n} strings."""
        depth = "fast"
    else:
        unit = "sentence" if level == "sentence" else "paragraph"
        prompt = f"""A writer is polishing a piece. In the passage below, the {unit} between ⟦ and ⟧ is one they want alternative versions of.

Write {n} alternative versions of that {unit}, each a complete drop-in replacement for it. Each must:
- do the same job in the argument and connect to what comes before and after it;
- keep every fact, figure, name and claim exactly as given — add nothing new;
- read as the writer's own prose, in the voice of the surrounding text;
- differ from the others in approach (e.g. tighter; more concrete; a different emphasis or order), not just in a word or two.

Do not repeat any of these, which the writer already has:
{avoid}

Passage:
{visible(marked)}{voice_brief()}

Return a JSON array of {n} strings — the replacement {unit}s only, without the ⟦ ⟧ markers."""
        depth = "deep"
    got = call(prompt, depth)
    if not isinstance(got, list):
        raise LabError("expected a list of versions")
    seen = {e.strip().lower() for e in existing}
    out = []
    for v in got:
        v = str(v).strip().strip("⟦⟧").strip()
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


# ---------------------------------------------------------------- reverse outline

ROLES = ["opening", "claim", "context", "evidence", "example", "counterpoint", "turn", "implication", "close"]


def outline(paragraphs: list[str]) -> list[dict]:
    """One line per paragraph on what it does in the argument — a reverse outline.

    Returns [{says, role}] aligned with paragraphs; a ghosted or heading-only
    paragraph gets {"says": "", "role": ""}."""
    shown = [visible(p).strip() for p in paragraphs]
    numbered = [(i, t) for i, t in enumerate(shown) if t and not t.startswith("#")]
    if not numbered:
        raise LabError("nothing to outline")
    body = "\n\n".join(f"[{k + 1}] {t}" for k, (_, t) in enumerate(numbered))
    prompt = f"""Below are the numbered paragraphs of a draft, in their current order.

Write a reverse outline: for each paragraph, one line (at most 15 words) saying what the paragraph DOES in the argument — the point it makes or the job it does — not just its topic. Write it as a plain statement, e.g. "Data centres' water use is overstated: most is evaporative cooling, recoverable". Then label its role with one of: {", ".join(ROLES)}.

Paragraphs:
{body}

Return a JSON array with one object per paragraph, in order: {{"n": <number>, "says": "<one line>", "role": "<role>"}}."""
    got = call(prompt, "deep")
    if not isinstance(got, list):
        raise LabError("expected a list")
    by_n = {}
    for o in got:
        if isinstance(o, dict) and str(o.get("n", "")).isdigit():
            role = str(o.get("role", "")).strip().lower()
            by_n[int(o["n"])] = {"says": str(o.get("says", "")).strip(), "role": role if role in ROLES else ""}
    out = [{"says": "", "role": ""} for _ in paragraphs]
    for k, (i, _) in enumerate(numbered):
        out[i] = by_n.get(k + 1, out[i])
    return out


# ---------------------------------------------------------------- lab passes

TRIMS = {"trim-slight": (10, "Slight trim"), "trim-tighter": (20, "Tighten more"),
         "trim-sharper": (35, "Even sharper"), "trim-half": (50, "Cut in half")}

MARKS = {
    "weak": ("Weakest sentences",
             "Find the weakest sentences — the ones that add least to the argument, "
             "state the obvious, repeat a neighbour, or are vague where they should be "
             "specific. At most 6, worst first. Quote each whole sentence."),
    "convoluted": ("Convoluted sentences",
                   "Find sentences that are hard to follow on first reading — tangled "
                   "syntax, stacked clauses, a subject far from its verb, ambiguous "
                   "reference. At most 6. Quote each whole sentence."),
    "tone": ("Off-tone words",
             "Find words or short phrases that do not fit the tone of the piece — "
             "jargon, needlessly fancy or formal words in plain prose, slang, or "
             "anything that jars with the rest of the text. At most 10. Quote "
             "just the word or phrase (with a neighbouring word if needed to make it "
             "unique)."),
    "hedges": ("Hedges and filler",
               "Find hedges (qualifiers that weaken a claim without adding accuracy) and "
               "filler (words that can go without loss: intensifiers, throat-clearing, "
               "redundant connectives). At most 12. Quote just the hedge or filler words."),
    "voice": ("Voice check",
              "Find sentences that break the writer's notes on their own voice (below). "
              "At most 8. Quote each whole sentence, and in the note name the principle it breaks."),
}


def run(task: str, text: str, lo: int, hi: int) -> dict:
    """Run a Lab pass over text[lo:hi]. Returns {title, kind, items, ...}."""
    if not visible(text[lo:hi]).strip():
        raise LabError("nothing to work on")
    if task == "long":
        return _long_sentences(text, lo, hi)
    if task == "typos":
        return _typos(text, lo, hi)
    if task == "voice" and not VOICE.strip():
        raise LabError("write a few notes on your voice in Settings (⚙) first — the check measures against them")
    if task in MARKS:
        return _marks(task, text, lo, hi)
    if task in TRIMS:
        return _trim(task, text, lo, hi)
    raise LabError(f"unknown Lab task: {task}")


def _items(text, lo, hi, raw):
    raw = [r for r in (raw if isinstance(raw, list) else []) if isinstance(r, dict)]
    spans = locate_all(text, [str(r.get("quote", "")) for r in raw], lo, hi)
    items = []
    for r, sp in zip(raw, spans):
        if sp:
            item = {"from": sp[0], "to": sp[1], "quote": text[sp[0]:sp[1]]}
            if r.get("note"):
                item["note"] = str(r["note"])
            if "replacement" in r:
                item["replacement"] = str(r["replacement"])
            items.append(item)
    return items, len(raw) - len(items)


def _marks(task, text, lo, hi):
    title, instruction = MARKS[task]
    brief = voice_brief() if task in ("tone", "voice") else ""
    prompt = f"""{instruction}

For each, give a one-line note saying what is wrong (not a rewrite).{brief}

Text:
{visible(text[lo:hi])}

Return a JSON array of objects: {{"quote": "...", "note": "..."}}. An empty array if there is nothing worth marking."""
    items, dropped = _items(text, lo, hi, call(prompt, "deep"))
    return {"task": task, "kind": "marks", "title": title, "items": items, "dropped": dropped}


def _typos(text, lo, hi):
    prompt = f"""Find clear mistakes only: misspellings, typos, doubled or missing words, wrong or missing punctuation, mismatched quotation marks or brackets, agreement slips. Not style, not word choice, not regional spelling variants (keep the writer's). Not anything that is a matter of taste.

For each, quote the smallest stretch of text that contains the mistake and is unique in the text (include a neighbouring word or two if needed), and give the corrected version of exactly that stretch.

Text:
{visible(text[lo:hi])}

Return a JSON array of objects: {{"quote": "...", "replacement": "...", "note": "what was wrong"}}. An empty array if it is clean."""
    raw = call(prompt, "fast")
    raw = [r for r in (raw if isinstance(raw, list) else []) if isinstance(r, dict) and r.get("replacement") != r.get("quote")]
    items, dropped = _items(text, lo, hi, raw)
    return {"task": "typos", "kind": "fixes", "title": "Punctuation and typos", "items": items, "dropped": dropped}


def _trim(task, text, lo, hi):
    pct, title = TRIMS[task]
    total = words(text[lo:hi])
    target = max(1, round(total * pct / 100))
    prompt = f"""The writer wants this text about {pct}% shorter — roughly {target} of its {total} words cut — by DELETION ONLY. You may not rewrite, reword, merge or add anything.

Choose passages to delete: whole sentences that the argument does not need, redundant examples, asides, throat-clearing, restatements, intensifiers and filler. Each cut must be a contiguous stretch copied verbatim. After every cut is deleted, the remaining text must still be grammatical and read naturally with no other change — so cut whole sentences, whole clauses with their commas, or whole parenthetical phrases; never leave a dangling connective.

Protect the argument: keep the thesis, the key evidence and the ending. Cut the least valuable material first.

Text:
{visible(text[lo:hi])}

Return a JSON array of objects: {{"quote": "exact text to delete", "note": "why it can go (a few words)"}}, in the order they appear."""
    items, dropped = _items(text, lo, hi, call(prompt, "deep", timeout=420))
    return {"task": task, "kind": "trim", "title": title, "pct": pct, "items": items,
            "dropped": dropped, "words": total}


# ---------------------------------------------------------------- no-model pass

LONG = 35
# Words a full stop doesn't end a sentence after (as src/sentences.js).
ABBREV = re.compile(r"(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e|cf|al|No|Vol|pp?|Fig|Inc|Ltd|Co|Corp|U\.S|U\.K|a\.m|p\.m|[A-Z])\.$")
END = re.compile(r"[.!?…]+[\"'”’)\]*_%]*(?=\s+[\"'“‘(\[*_%]*[^\W_a-z])")


def sentence_ranges(line: str) -> list[tuple[int, int]]:
    ghosts = ghost_spans(line)
    out, start = [], len(line) - len(line.lstrip())
    for m in END.finditer(line):
        end = m.end()
        if any(a < end < b for a, b in ghosts):
            continue
        if m.group(0)[0] == "." and ABBREV.search(line[start:m.start() + 1]):
            continue
        out.append((start, end))
        start = end + (len(line[end:]) - len(line[end:].lstrip()))
    tail = len(line.rstrip())
    if tail > start:
        out.append((start, tail))
    return out


def _long_sentences(text, lo, hi):
    items, at = [], 0
    for line in text.split("\n"):
        a, at = at, at + len(line) + 1
        if a + len(line) < lo or a > hi or not line.strip() or re.match(r"\s*(#|>|```|---)", line):
            continue
        for s, e in sentence_ranges(line):
            f, t = a + s, a + e
            if t <= lo or f >= hi:
                continue
            n = words(text[f:t])
            if n > LONG:
                items.append({"from": f, "to": t, "quote": text[f:t], "note": f"{n} words — over {LONG}"})
    return {"task": "long", "kind": "marks", "title": "Sentences that run long", "items": items, "dropped": 0}
