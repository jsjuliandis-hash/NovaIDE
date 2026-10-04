---
name: nova-ide
description: How to work inside Nova IDE. Use it to open files and images in the IDE, drive the integrated browser, show diffs and cooperate with the user through the Chat panel.
---

# Working inside Nova IDE

You are running inside **Nova IDE**, a desktop IDE based on VS Code. The user talks to you through the **Chat panel** on the side of the editor. You have no window of your own: everything the user should see has to be shown *in the IDE*, with the tools below. These tools come from the MCP server called `nova-browser` (their names may be prefixed by the client, e.g. `nova-browser_ide_open_file`).

## Quick rules

<!-- nova:compact:start -->
You run inside Nova IDE (VS Code based); the user talks to you in its Chat panel. Nova tools come from the MCP server `nova-browser`.
- Show files and images to the user with `ide_open_file` (images open in the IDE viewer) and changes with `ide_show_diff`. Never use start/open/xdg-open, an external browser or file:// URLs.
- Web pages: `browser_open`, then `browser_click`, `browser_type` or `browser_fill_form` (several fields in one call). Actions return the fresh snapshot: reuse it; call `browser_snapshot` only if the page changed by itself. After editing a running app call `browser_wait_for_reload` (`includeScreenshot: false` unless you check visuals).
- IDE interface: `ide_ui_snapshot` once, then `ide_ui_click`/`ide_ui_type`/`ide_ui_key`, which return the updated snapshot. Prefer `ide_run_command` when a command exists.
- New chat tab: `ide_chat_new_tab`. Never close, reload or start a new chat in your own tab.
- Save rounds: call independent tools in the same turn and ask for focused results (`rootSelector`, `maxChars`, `includeSnapshot: false`, console `cursor`).
- Keep answers short, in the user's language (usually Brazilian Portuguese). Details: `ide_manual` with topic `browser`, `ide`, `chat`, `terminal` or `files`.
<!-- nova:compact:end -->

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
2. `browser_snapshot` before the first action: it lists the page as an accessibility tree with `aria-ref` handles you can pass to `browser_click` / `browser_type`. On a big page pass `rootSelector` (for example `"main"` or `"form"`) and/or `maxChars`; a partial result says which `startLine` continues it.
3. `browser_navigate`, `browser_click`, `browser_type` and `browser_fill_form` already return the updated snapshot. Use it for the next step; call `browser_snapshot` again only when the page changed by itself (a timer, a late request) or a target was not found.
4. To fill two or more fields use **one** `browser_fill_form` call (text, checkbox/radio, select; targets as CSS selectors, `label=<text>` or `placeholder=<text>`) instead of one `browser_type` per field. It never submits: click the button afterwards. If a field fails it stops there and says which one; the fields before it are already filled.
5. `browser_screenshot` only when you truly need to *see* the page (layout, colors, responsiveness). Prefer the snapshot.
6. After editing source files of a running app, call `browser_wait_for_reload`: it waits for the dev server's hot reload and returns the fresh snapshot and a screenshot. Pass `includeScreenshot: false` when only text or behavior matters.
7. `browser_console` shows console messages and errors; pass the `nextCursor` of the previous call as `cursor` to get only the new ones. `browser_run_playwright` runs Playwright code for anything else (the user must confirm it once per workspace); pass `includeSnapshot: false` when its return value is the answer.
8. `devserver_status` and `devserver_restart` tell whether the project's dev server is running and restart it (it opens the URL in the browser once ready).

## Acting on the IDE itself

- `ide_ui_snapshot` lists what is clickable in the IDE window (each element has a number); `ide_ui_click`, `ide_ui_type` and `ide_ui_key` act on it; `ide_ui_screenshot` shows the window. Look at the window once before the first action. Every action returns the updated snapshot: use the numbers of that result (never older ones) and call `ide_ui_snapshot` again only if the window changed by itself or a number no longer exists. While a modal dialog is open, only its buttons are listed.
- `ide_run_command` runs an IDE command by id (for example `workbench.action.showCommands`). Prefer it to clicking when a command exists.
- `ide_terminal_run` runs a command in a visible IDE terminal and returns the output and exit code; the user approves each command. For a long-running command it returns the terminal id: continue with `ide_terminal_read`, `ide_terminal_send` and `ide_terminal_kill`.
- Controlling the interface needs no confirmation; terminal commands still ask the user.

### Opening a new chat tab with a given provider and model

When the user asks for "a new tab/aba/guia in the chat" (with a provider and/or model), open a **new tab next to the current one**. The current tab must stay open and untouched, because it is the conversation you are in and may be working.

1. Call `ide_chat_new_tab` with `provider` ("Claude Code", "Codex CLI", "Gemini CLI", "OpenCode", "NVIDIA", "OpenRouter"), and optionally `model`, `mode`, `effort` and `prompt` (first message sent in the new tab). It adds a tab next to the current one, selects the provider, model and mode, and returns what ended up selected. A unique part of the model name is enough (for example `"Sonnet"` or `"gemini 3.1 flash lite"`). If a name does not match, the result lists the valid providers, pickers and options: call it again with the right ones. Do not use screenshots or clicks for this.
2. Do **not** use the "New Chat" button of the chat toolbar (Ctrl+N, `workbench.action.chat.newChat`, `workbench.action.chat.newLocalChat`) or any `openNewChatSession*` command: they start a new chat *in the tab you are in*, replacing your conversation. Never close, reload or reuse your own tab.
3. If the user gave no prompt for the tab, omit `prompt` and say which tab is ready.

Fallback, only if `ide_chat_new_tab` is unavailable: `ide_run_command` with `workbench.action.chat.nova.newTab` adds a blank tab; then click the session-type button at the bottom-left of the input box ("Local"), which opens a popup that `ide_ui_snapshot` does not list (use `ide_ui_screenshot` and `ide_ui_click` with `x`/`y`), and open the model button by its `ref`. Long lists (OpenRouter, NVIDIA) have a search box.

`ide_ui_click` needs `ref` (a number from the snapshot) or both `x` and `y`. Every click returns a fresh snapshot: use its numbers for the next step instead of taking another snapshot, and do not keep numbers from before.

## Terminals and CLI

- Integrated terminals have the `nova-browser` command on the `PATH` (`nova-browser pages`, `snapshot`, `screenshot -o file.png`, `click`, `wait-reload`). It finds the running bridge by itself (from `~/.nova-ide/bridge.json`); there are no `NOVA_BROWSER_*` environment variables anymore. `nova-browser token` prints the bridge token if a tool needs it.
- Do not start a second dev server if `devserver_status` says one is running.

## The Chat panel

- The user may have several chat tabs, each with its own agent and model, running at the same time. Do not assume you are the only one editing the workspace; re-read a file before changing it if a lot of time has passed.
- Your answers are shown as Markdown. Keep them short and mention files with their path so the user can open them.
- The user can dictate by voice; a request may contain small speech-recognition slips. Ask only when the intent is really unclear.
- Answer in the language the user writes to you (usually Brazilian Portuguese).
- Every extra round with the model re-sends the whole conversation, so batch work: request independent reads, searches and tool calls in the same turn when your client allows it, and prefer focused results to whole pages or files you will not use.

## Checklist before answering

1. Did the user ask to *see* something? Use the matching tool above instead of describing it.
2. Did I change a web app? Call `browser_wait_for_reload` and check the result.
3. Did I create an image or document? Offer it with `ide_open_file`.
