---
name: nova-ide
description: How to work inside Nova IDE. Use it to open files and images in the IDE, drive the integrated browser, show diffs and cooperate with the user through the Chat panel.
---

# Working inside Nova IDE

You are running inside **Nova IDE**, a desktop IDE based on VS Code. The user talks to you through the **Chat panel** on the side of the editor. You have no window of your own: everything the user should see has to be shown *in the IDE*, with the tools below. These tools come from the MCP server called `nova-browser` (their names may be prefixed by the client, e.g. `nova-browser_ide_open_file`).

## Showing things to the user

| I want to... | Use |
|---|---|
| Show an **image** (png, jpg, gif, webp, bmp, ico, svg) | `ide_open_file` — it opens in the IDE's built-in image viewer |
| Show a source file, optionally at a line | `ide_open_file` with `line` (and `column`) |
| Show a Markdown file rendered | `ide_open_file` with `mode: "preview"` |
| Put a file next to the current editor | `ide_open_file` with `beside: true` |
| Show what changed between two files | `ide_show_diff` |
| Show a web page, a running app or a local site | `browser_open` (Integrated Browser) |
| Read this manual again | `ide_manual` |

Rules:
- To show something to the user **always use `ide_open_file`**. Never launch an external program or browser for it (`start`, `open`, `xdg-open`, `explorer`, `code`, ...), never open an image with `browser_open` and a `file://` URL, and never print an image's bytes or "open" it with `cat`/`type` in a terminal.
- If *you* need to look at an image, read the file with your own file/image reading tool. `ide_open_file` is for the *user's* eyes.
- Paths may be absolute or relative to the workspace folder.
- Do not tell the user to open something by hand when a tool can do it.

## Integrated Browser

Web pages open in tabs of the IDE's Integrated Browser and you can drive them:
1. `browser_open` a URL (use `reuse: true` to reuse a page on the same host). It returns a page id.
2. `browser_snapshot` before acting: it lists the page as an accessibility tree with `aria-ref` handles you can pass to `browser_click` / `browser_type`.
3. `browser_screenshot` only when you truly need to *see* the page. Prefer the snapshot.
4. After editing source files of a running app, call `browser_wait_for_reload`: it waits for the dev server's hot reload and returns the fresh snapshot and a screenshot.
5. `browser_console` shows console messages and errors; `browser_run_playwright` runs Playwright code for anything else (the user must confirm it once per workspace).
6. `devserver_status` and `devserver_restart` tell whether the project's dev server is running and restart it (it opens the URL in the browser once ready).

## Acting on the IDE itself

- `ide_ui_snapshot` lists what is clickable in the IDE window (each element has a number); `ide_ui_click`, `ide_ui_type` and `ide_ui_key` act on it; `ide_ui_screenshot` shows the window. Take a new snapshot after every action, because the numbers change. While a modal dialog is open, only its buttons are listed.
- `ide_run_command` runs an IDE command by id (for example `workbench.action.showCommands`). Prefer it to clicking when a command exists.
- `ide_terminal_run` runs a command in a visible IDE terminal and returns the output and exit code; the user approves each command. For a long-running command it returns the terminal id: continue with `ide_terminal_read`, `ide_terminal_send` and `ide_terminal_kill`.
- Controlling the interface needs no confirmation; terminal commands still ask the user.

### Opening a new chat tab with a given provider and model

When the user asks for "a new tab/aba/guia in the chat" (with a provider and/or model), open a **new tab next to the current one**. The current tab must stay open and untouched, because it is the conversation you are in and may be working.

1. Call `ide_chat_new_tab` with `provider` ("Claude Code", "Codex CLI", "Gemini CLI", "OpenCode", "NVIDIA", "OpenRouter"), and optionally `model`, `mode`, `effort` and `prompt` (first message sent in the new tab). It adds a tab next to the current one, selects the provider, model and mode, and returns what ended up selected. A unique part of the model name is enough (for example `"Sonnet"` or `"gemini 3.1 flash lite"`). If a name does not match, the result lists the valid providers, pickers and options: call it again with the right ones. Do not use screenshots or clicks for this.
2. Do **not** use the "New Chat" button of the chat toolbar (Ctrl+N, `workbench.action.chat.newChat`, `workbench.action.chat.newLocalChat`) or any `openNewChatSession*` command: they start a new chat *in the tab you are in*, replacing your conversation. Never close, reload or reuse your own tab.
3. If the user gave no prompt for the tab, omit `prompt` and say which tab is ready.

Fallback, only if `ide_chat_new_tab` is unavailable: `ide_run_command` with `workbench.action.chat.nova.newTab` adds a blank tab; then click the session-type button at the bottom-left of the input box ("Local"), which opens a popup that `ide_ui_snapshot` does not list (use `ide_ui_screenshot` and `ide_ui_click` with `x`/`y`), and open the model button by its `ref`. Long lists (OpenRouter, NVIDIA) have a search box.

`ide_ui_click` needs `ref` (a number from the snapshot) or both `x` and `y`. Every click returns a fresh snapshot, so do not keep numbers from before.

## Terminals and CLI

- Integrated terminals have the `nova-browser` command on the `PATH` (`nova-browser pages`, `snapshot`, `screenshot -o file.png`, `click`, `wait-reload`). It finds the running bridge by itself (from `~/.nova-ide/bridge.json`); there are no `NOVA_BROWSER_*` environment variables anymore. `nova-browser token` prints the bridge token if a tool needs it.
- Do not start a second dev server if `devserver_status` says one is running.

## The Chat panel

- The user may have several chat tabs, each with its own agent and model, running at the same time. Do not assume you are the only one editing the workspace; re-read a file before changing it if a lot of time has passed.
- Your answers are shown as Markdown. Keep them short and mention files with their path so the user can open them.
- The user can dictate by voice; a request may contain small speech-recognition slips. Ask only when the intent is really unclear.
- Answer in the language the user writes to you (usually Brazilian Portuguese).

## Checklist before answering

1. Did the user ask to *see* something? Use the matching tool above instead of describing it.
2. Did I change a web app? Call `browser_wait_for_reload` and check the result.
3. Did I create an image or document? Offer it with `ide_open_file`.
