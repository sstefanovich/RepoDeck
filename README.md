# RepoDeck

A friendly desktop Git GUI for people who juggle several repos at once.

## Run it

```
npm install
npm start
```

Requires Node.js and Git on your PATH.

## What it does

- **Workspaces** group repos you work on together (e.g. the 3 repos of one project).
  The sidebar shows each repo's branch, uncommitted changes (●), commits to send (↑) and to get (↓).
- **Workspace actions** run on every repo at once: check for updates, get latest, send,
  create the same branch everywhere, switch everything to one branch, open all in your editor.
- **Changes**: tick files, write a summary, Commit (or Commit & Send). No "staging" to think about.
  "Discard" puts changes on the Shelf first, so it's undoable.
- **Branches**: create, switch, merge, rename, delete — including branches that only exist on the server.
  Switching with uncommitted changes asks whether to bring them along or leave them behind
  (and offers to restore them when you come back).
- **History**: commits with "not sent" markers, incoming commits from the server, and "Undo this commit"
  for commits that haven't been sent yet.
- **Shelf** (git `stash`): set uncommitted changes aside and restore them later.
- **Conflicts**: each clash shown side by side with one-click "use mine / theirs / both / edit by hand",
  plus Abort to put everything back.
- **Behind the scenes** drawer: every git command the app runs, with its output — a gentle way to learn git.

The app watches your folders, so you can keep editing in VS Code / Cursor and it updates automatically.

## Layout

- `main.js` – Electron main process: window, settings file, launching editor/terminal.
- `src/git.js` – every git operation (shells out to the real `git` CLI).
- `preload.js` – the bridge between the UI and the main process.
- `renderer/` – the UI (plain HTML/CSS/JS, no build step).

Settings and workspaces are stored in `%APPDATA%\repodeck\config.json`.
