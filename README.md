# Spit n Polish

You've written the piece. Spit n Polish is where you give it the spit and polish —
without anyone rewriting it for you.

- **Versions** — for any word, sentence or paragraph, write other ways of saying it,
  then flip between them in place with the arrow keys and read each in context.
- **Ghosting** — fade a sentence out of the piece without deleting it.
- **Overflow** — a side panel for offcuts you can't bear to lose.
- **Move and split** — sentences and paragraphs up and down with a key; a structure
  view of paragraph cards to drag into a new order, with an AI reverse outline.
- **The Lab** — editing passes that *mark* rather than rewrite: typos, the weakest
  sentences, convoluted ones, off-tone words, hedges and filler, a check against notes
  on your own voice, and trims of 10–50% that propose cuts for you to accept one by one.

Nothing an AI writes enters your text without a click from you. Your documents are
plain markdown files in a folder on your own computer — open them in Obsidian or any
editor at the same time.

## What you need

- **Python 3.9 or newer** (already on most Macs and Linux machines).
- For the AI features, either:
  - **[Claude Code](https://claude.com/claude-code)**, installed and signed in — the AI
    then runs on your Claude subscription, no API key; or
  - an **Anthropic API key**: `pip install anthropic`, then put
    `ANTHROPIC_API_KEY=sk-ant-…` in `~/.config/spitnpolish/env`.

  Without either, everything except the AI works.

## Install

Download this folder (Code → Download ZIP, or `git clone`), put it somewhere it can
stay, and in a terminal inside it:

    ./install.sh

That runs Spit n Polish in the background, starting at every login (launchd on macOS,
a systemd user service on Linux), and opens <http://127.0.0.1:4848/>. Bookmark it, or
give it a keyboard shortcut in your system settings. Your documents go in
`~/Documents/Spit n Polish`; choose another folder or port with

    ./install.sh --folder ~/Writing --port 5050

Re-run `install.sh` after moving this folder. `./install.sh --uninstall` removes the
service and leaves your documents alone.

**Just trying it, or on Windows:** `python3 server.py` (Windows: `python server.py`)
runs it until you close the terminal. `python3 server.py --help` lists the options.

## Using it

Press ⌘/ (Ctrl+/ on Windows and Linux) or the **?** in the corner for the full guide.
⌘O opens, creates, imports, renames, downloads or deletes documents; ⚙ holds your
voice notes and the model choice.

## Your files

Each document is `Name.md`, plus `Name.alts.json` (versions) and `Name.overflow.md`
(offcuts) once you use those. Ghosted text is stored as `%%…%%` — an Obsidian comment —
so it disappears in Obsidian's reading view. Deleted documents go to the folder's
`.trash`. Settings and voice notes live in its `.spitnpolish` folder.

The server listens only on your own machine (127.0.0.1) and refuses requests from
other websites. Your text goes to Anthropic only when you run an AI feature.

## Changing the code

The editor is in `src/` (CodeMirror 6). `npm install && npm run build` rebuilds
`web/dist/bundle.js`, which is committed so running needs no Node. `npm test` runs the
editor-logic tests. The server (`server.py`) and AI prompts (`lab.py`) use only the
Python standard library.
