#!/usr/bin/env python3
"""Spit n Polish — a drafting editor that never rewrites you.

A small local server: it serves the editor to your browser and keeps your
documents as plain markdown files in one folder (default ~/Documents/Spit n Polish,
subfolders included). Each document is up to three files:

    X.md              the prose — any markdown editor (Obsidian included) reads it;
                      ghosted text sits inside Obsidian-style %%comments%%
    X.alts.json       alternative versions of words / sentences / paragraphs
    X.overflow.md     stashed offcuts

It never reads or writes outside that folder. Settings and your voice notes live
in its hidden .spitnpolish/ subfolder; deleted documents go to .trash/.

    python3 server.py                   # opens http://127.0.0.1:4848/
    python3 server.py --folder DIR      # keep documents somewhere else
    python3 server.py --port N --no-open
    python3 server.py --engine api      # AI via ANTHROPIC_API_KEY instead of Claude Code
                                        # (env var, or a line in ~/.config/spitnpolish/env)
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import lab

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
DEFAULT_ROOT = Path.home() / "Documents" / "Spit n Polish"

ROOT: Path = DEFAULT_ROOT


# ---------------------------------------------------------------- the folder

def editable(rel: Path) -> bool:
    name = rel.name
    return (
        name.endswith(".md")
        and not name.endswith(".overflow.md")
        and not any(part.startswith((".", "_")) for part in rel.parts)
    )


def siblings(path: str) -> dict:
    """The three files that make up one document. Raises ValueError on a bad path."""
    p = (ROOT / path).resolve()
    if not p.is_relative_to(ROOT) or not editable(p.relative_to(ROOT)):
        raise ValueError(f"not an editable document: {path}")
    stem = p.name[: -len(".md")]
    return {
        "draft": p,
        "alts": p.with_name(f"{stem}.alts.json"),
        "overflow": p.with_name(f"{stem}.overflow.md"),
    }


def mtime(p: Path):
    # A string: nanosecond timestamps are too big for a JavaScript number.
    return str(p.stat().st_mtime_ns) if p.exists() else None


def atomic_write(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=f".{p.name}.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, p.stat().st_mode & 0o777 if p.exists() else 0o644)  # mkstemp makes 0600
    os.replace(tmp, p)


def list_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith((".", "_"))]
        for fn in filenames:
            p = Path(dirpath) / fn
            rel = p.relative_to(ROOT)
            if editable(rel):
                out.append({"path": rel.as_posix(), "mtime": p.stat().st_mtime})
    out.sort(key=lambda f: -f["mtime"])
    return out


BAD_CHARS = str.maketrans({c: " " for c in '\\/:*?"<>|'} | {chr(i): " " for i in range(32)})


def clean_name(name: str) -> str:
    n = " ".join(str(name or "").translate(BAD_CHARS).split())
    if n.lower().endswith(".md"):
        n = n[:-3].strip()
    return n[:120].strip(" .")


def free_path(folder: Path, name: str) -> Path:
    """folder/name.md, or name 2.md, name 3.md… — never an existing file."""
    base = clean_name(name) or "Untitled"
    for i in range(1, 10_000):
        p = folder / f"{base}{f' {i}' if i > 1 else ''}.md"
        if not p.exists():
            return p
    raise ValueError("too many documents with that name")


def create(name: str, text: str = "", alts=None, overflow: str = "") -> str:
    p = free_path(ROOT, name)
    atomic_write(p, text)
    f = siblings(p.relative_to(ROOT).as_posix())
    if alts and alts.get("sets"):
        atomic_write(f["alts"], json.dumps(alts, indent=2, ensure_ascii=False) + "\n")
    if overflow and overflow.strip():
        atomic_write(f["overflow"], overflow)
    return p.relative_to(ROOT).as_posix()


def rename(path: str, name: str) -> str:
    f = siblings(path)
    new = clean_name(name)
    if not new:
        raise ValueError("a document needs a name")
    target = f["draft"].with_name(f"{new}.md")
    if target == f["draft"]:
        return path
    # Case-only renames are allowed on case-insensitive disks.
    if target.exists() and target.resolve() != f["draft"].resolve():
        raise ValueError(f"there is already a document called “{new}”")
    g = siblings(target.relative_to(ROOT).as_posix())
    for k in ("draft", "alts", "overflow"):
        if f[k].exists():
            os.replace(f[k], g[k])
    return target.relative_to(ROOT).as_posix()


def trash(path: str):
    """Move a document and its side files to .trash/<time>/ — nothing is destroyed."""
    f = siblings(path)
    dest = ROOT / ".trash" / time.strftime("%Y-%m-%d %H.%M.%S")
    dest.mkdir(parents=True, exist_ok=True)
    for k in ("draft", "alts", "overflow"):
        if f[k].exists():
            shutil.move(str(f[k]), str(dest / f[k].name))


# ---------------------------------------------------------------- settings

def settings_dir() -> Path:
    return ROOT / ".spitnpolish"


def read_settings() -> dict:
    try:
        s = json.loads((settings_dir() / "settings.json").read_text())
    except (OSError, json.JSONDecodeError):
        s = {}
    try:
        voice = (settings_dir() / "voice.md").read_text(encoding="utf-8")
    except OSError:
        voice = ""
    return {"deepModel": s.get("deepModel", "opus"), "voice": voice}


def write_settings(body: dict):
    cur = read_settings()
    if body.get("deepModel") in ("opus", "sonnet"):
        cur["deepModel"] = body["deepModel"]
    atomic_write(settings_dir() / "settings.json", json.dumps({"deepModel": cur["deepModel"]}, indent=2) + "\n")
    if "voice" in body:
        atomic_write(settings_dir() / "voice.md", str(body["voice"]))
    apply_settings()


def apply_settings():
    s = read_settings()
    lab.configure(deep=s["deepModel"], voice=s["voice"])


def settings_reply() -> dict:
    s = read_settings()
    engine, note = lab.engine_status()
    return {**s, "folder": str(ROOT), "engine": engine, "engineNote": note}


# ---------------------------------------------------------------- http

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        if "/api/stat" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def local_only(self) -> bool:
        # Refuse requests from other web pages (DNS rebinding, cross-site posts):
        # only the editor itself, on this machine, may talk to the API.
        host = (self.headers.get("Host") or "").split(":")[0]
        origin = self.headers.get("Origin")
        if host not in ("127.0.0.1", "localhost"):
            return False
        return origin is None or urlparse(origin).hostname in ("127.0.0.1", "localhost")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/") and not self.local_only():
            return self.send_json({"error": "forbidden"}, 403)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/files":
                return self.send_json({"root": str(ROOT), "files": list_files()})
            if url.path == "/api/settings":
                return self.send_json(settings_reply())
            if url.path == "/api/stat":
                f = siblings(q.get("path", ""))
                return self.send_json({"mtime": mtime(f["draft"]), "overflowMtime": mtime(f["overflow"])})
            if url.path == "/api/doc":
                f = siblings(q.get("path", ""))
                if not f["draft"].exists():
                    return self.send_json({"error": "not found"}, 404)
                alts = json.loads(f["alts"].read_text()) if f["alts"].exists() else {"version": 1, "sets": []}
                return self.send_json({
                    "path": f["draft"].relative_to(ROOT).as_posix(),
                    "text": f["draft"].read_text(encoding="utf-8"),
                    "mtime": mtime(f["draft"]),
                    "alts": alts,
                    "overflow": f["overflow"].read_text(encoding="utf-8") if f["overflow"].exists() else "",
                    "overflowMtime": mtime(f["overflow"]),
                })
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if not self.local_only():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            body = self.read_json()
            if path == "/api/new":
                return self.send_json({"path": create(body.get("name", ""), body.get("text", ""),
                                                      body.get("alts"), body.get("overflow", ""))})
            if path == "/api/rename":
                return self.send_json({"path": rename(body["path"], body["name"])})
            if path == "/api/delete":
                trash(body["path"])
                return self.send_json({"ok": True})
            if path == "/api/ai/versions":
                got = lab.versions(body["level"], body["target"], body.get("context", ""), body.get("existing", []))
                return self.send_json({"versions": got})
            if path == "/api/outline":
                return self.send_json({"outline": lab.outline(body["paragraphs"])})
            if path == "/api/lab":
                text = body["text"]
                lo, hi = body.get("from", 0), body.get("to", len(text))
                return self.send_json(lab.run(body["task"], text, lo, hi))
        except lab.LabError as e:
            return self.send_json({"error": str(e)}, 502)
        except (KeyError, ValueError, OSError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, 400)
        return self.send_json({"error": "no such endpoint"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path
        if not self.local_only():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            body = self.read_json()
            if path == "/api/settings":
                write_settings(body)
                return self.send_json(settings_reply())
            if path != "/api/doc":
                return self.send_json({"error": "no such endpoint"}, 404)
            f = siblings(body.get("path", ""))
        except (ValueError, OSError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, 400)

        force = bool(body.get("force"))
        # Refuse to clobber an edit made elsewhere (another editor) since we loaded.
        if not force:
            if "text" in body and mtime(f["draft"]) != body.get("baseMtime"):
                return self.send_json({"conflict": "draft", "mtime": mtime(f["draft"])}, 409)
            if "overflow" in body and mtime(f["overflow"]) != body.get("overflowBaseMtime"):
                return self.send_json({"conflict": "overflow", "mtime": mtime(f["overflow"])}, 409)

        if "text" in body:
            atomic_write(f["draft"], body["text"])
        if "alts" in body:
            sets = body["alts"].get("sets", [])
            if sets:
                atomic_write(f["alts"], json.dumps(body["alts"], indent=2, ensure_ascii=False) + "\n")
            elif f["alts"].exists():
                f["alts"].unlink()
        if "overflow" in body:
            if body["overflow"].strip() or f["overflow"].exists():
                atomic_write(f["overflow"], body["overflow"])
        return self.send_json({"mtime": mtime(f["draft"]), "overflowMtime": mtime(f["overflow"])})


def welcome_if_empty():
    if list_files():
        return
    text = (HERE / "welcome.md").read_text(encoding="utf-8")
    if sys.platform != "darwin":
        # The guide's keys are written Mac-style; spell them out elsewhere.
        for mac, other in (("⌥⌘", "Ctrl+Alt+"), ("⌘⇧", "Ctrl+Shift+"), ("⌘", "Ctrl+"), ("⌥", "Alt+")):
            text = text.replace(mac, other)
    create("Welcome to Spit n Polish", text)


def load_env_file():
    """KEY=value lines from ~/.config/spitnpolish/env (e.g. ANTHROPIC_API_KEY) — kept
    out of the documents folder, which people sync."""
    p = Path.home() / ".config" / "spitnpolish" / "env"
    try:
        lines = p.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        k, sep, v = line.strip().partition("=")
        if sep and k and not k.startswith("#"):
            os.environ.setdefault(k.strip().removeprefix("export "), v.strip().strip('"').strip("'"))


def main():
    global ROOT
    load_env_file()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--folder", "--root", type=Path, default=Path(os.environ.get("SPITNPOLISH_FOLDER", DEFAULT_ROOT)),
                    help="where your documents live (default: %(default)s)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("SPITNPOLISH_PORT", 4848)))
    ap.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    ap.add_argument("--engine", choices=["auto", "claude", "api"], default=os.environ.get("SPITNPOLISH_ENGINE", "auto"),
                    help="AI through Claude Code (claude) or ANTHROPIC_API_KEY (api); auto prefers Claude Code")
    a = ap.parse_args()
    ROOT = a.folder.expanduser().resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    lab.ENGINE = a.engine
    apply_settings()
    welcome_if_empty()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/"
    engine, note = lab.engine_status()
    print(f"Spit n Polish · {ROOT}\n{url}\nAI: {note}", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
