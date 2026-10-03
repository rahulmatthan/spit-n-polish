# Spit n Polish

A drafting editor that runs on the writer's own machine: a local stdlib-Python server, documents as
markdown files in a folder, AI through the user's own Claude Code (`claude -p`) or,
failing that, `ANTHROPIC_API_KEY` + the `anthropic` package. Not hosted anywhere —
README.md is the user-facing install guide; `install.sh` sets up launchd / systemd.

- Documents: `--folder` (default `~/Documents/Spit n Polish`); new / rename / import /
  delete (to `.trash/`) endpoints in `server.py`.
- Voice: the user's notes (`.spitnpolish/voice.md`, edited in Settings); Voice check is
  a model pass against them; Long sentences is a Python port of `src/sentences.js`.
- AI: engine `auto` → Claude Code, else the API (`lab.engine()`), key from env or
  `~/.config/spitnpolish/env`.

Rules: model output is only quotes to mark / fixes / cuts / versions
beside the writer's own; every quote is located before it's shown; nothing enters the
draft without a click; saves keep the mtime conflict check. The API refuses non-local
Host/Origin (DNS rebinding, cross-site posts) — keep that.

This repo is public: nothing personal goes in it — no one's voice notes, drafts,
paths or keys.

Run against a scratch folder when testing (`python3 server.py --folder DIR --port N
--no-open`), never a real one. `npm run build` after editing `src/` (the bundle is
committed); `npm test` for the editor logic; `web/help.html` is the in-app guide —
update it with any feature change.
