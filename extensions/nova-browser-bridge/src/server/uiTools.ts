/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  ide_* MCP tools that act on the IDE itself: run IDE commands, inspect the interface, click,
 *  type and press keys in it (through the DevTools of the IDE window), and run terminal commands.
 *  Interface control needs no confirmation; every terminal command asks first.
 *-------------------------------------------------------------------------------------------*/

import { McpServer } from '@modelcontextprotocol/server';
import * as vscode from 'vscode';
import * as z from 'zod';
import { killTerminal, readTerminal, runInTerminal, sendToTerminal, TerminalReport } from './agentTerminal';

/** Internal command of the IDE core (workbench/contrib/novaUiControl) that relays DevTools commands. */
const CDP_COMMAND = 'nova.uiControl.cdp';

/** Longest text handed back to the agent in one result. */
const MAX_RESULT_CHARS = 30_000;

const MAX_SNAPSHOT_ELEMENTS = 400;

let terminalsAllowed = false;

async function ensureTerminalCommandAllowed(command: string): Promise<void> {
	if (terminalsAllowed) {
		return;
	}
	const run = vscode.l10n.t('Run');
	const always = vscode.l10n.t('Always Allow This Session');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('An agent wants to run this command in a terminal:'),
		{ modal: true, detail: command },
		run,
		always,
	);
	if (choice === always) {
		terminalsAllowed = true;
	} else if (choice !== run) {
		throw new Error('Denied: the user did not allow this terminal command.');
	}
}

async function cdp<T = unknown>(method: string, params?: object): Promise<T> {
	return await vscode.commands.executeCommand<T>(CDP_COMMAND, method, params);
}

/** Runs JavaScript inside the IDE window and returns its JSON-serializable result. */
async function evaluate<T>(expression: string): Promise<T> {
	const response = await cdp<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (response.exceptionDetails) {
		throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
	}
	return response.result.value as T;
}

/**
 * Lists what can be clicked in the window. Every element gets a `data-nova-ref` number that
 * ide_ui_click and ide_ui_type use. While a modal dialog is open only its elements are listed.
 */
const SNAPSHOT_SCRIPT = `(() => {
	document.querySelectorAll('[data-nova-ref]').forEach(e => e.removeAttribute('data-nova-ref'));
	const modal = document.querySelector('.monaco-dialog-box');
	const root = modal || document.body;
	const selector = 'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [role="tab"], [role="treeitem"], [role="option"], [role="checkbox"], [role="switch"], [role="link"], .monaco-list-row, .action-label, .monaco-button, [tabindex]:not([tabindex="-1"])';
	const lines = [];
	let ref = 0;
	for (const el of root.querySelectorAll(selector)) {
		const r = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		if (r.width < 1 || r.height < 1 || style.visibility === 'hidden' || style.display === 'none' || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) { continue; }
		if (ref >= ${MAX_SNAPSHOT_ELEMENTS}) { lines.push('... more elements omitted'); break; }
		const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.placeholder || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
		const role = el.getAttribute('role') || el.tagName.toLowerCase();
		ref += 1;
		el.setAttribute('data-nova-ref', String(ref));
		const state = [el.disabled ? 'disabled' : '', el.getAttribute('aria-checked') === 'true' || el.checked ? 'checked' : '', el.getAttribute('aria-expanded') ? 'expanded=' + el.getAttribute('aria-expanded') : '', el === document.activeElement ? 'focused' : ''].filter(Boolean).join(',');
		lines.push('[' + ref + '] ' + role + ' "' + name + '"' + (state ? ' (' + state + ')' : ''));
	}
	const dialogText = modal ? (modal.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600) : '';
	const quickInput = document.querySelector('.quick-input-widget');
	const quickInputOpen = !!quickInput && getComputedStyle(quickInput).display !== 'none';
	return { title: document.title, dialogText, quickInputOpen, lines };
})()`;

interface Snapshot {
	title: string;
	dialogText: string;
	quickInputOpen: boolean;
	lines: string[];
}

async function takeSnapshot(): Promise<string> {
	const snapshot = await evaluate<Snapshot>(SNAPSHOT_SCRIPT);
	const header = [`Window: ${snapshot.title}`];
	if (snapshot.dialogText) {
		header.push(`A modal dialog is open (only its elements are listed): ${snapshot.dialogText}`);
	}
	if (snapshot.quickInputOpen) {
		header.push('The quick input (command palette / picker) is open.');
	}
	return truncate([...header, '', ...snapshot.lines].join('\n'));
}

async function centerOf(ref: number): Promise<{ x: number; y: number }> {
	const point = await evaluate<{ x: number; y: number } | null>(`(() => {
		const el = document.querySelector('[data-nova-ref="${ref}"]');
		if (!el) { return null; }
		el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (!point) {
		throw new Error(`Element [${ref}] no longer exists. Call ide_ui_snapshot again to get fresh references.`);
	}
	return point;
}

async function click(x: number, y: number, button: 'left' | 'right', clickCount: number): Promise<void> {
	await evaluate('window.focus()');
	await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
	await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
	await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
}

const NAMED_KEYS: Record<string, { code: string; keyCode: number }> = {
	Enter: { code: 'Enter', keyCode: 13 },
	Escape: { code: 'Escape', keyCode: 27 },
	Tab: { code: 'Tab', keyCode: 9 },
	Backspace: { code: 'Backspace', keyCode: 8 },
	Delete: { code: 'Delete', keyCode: 46 },
	ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
	ArrowUp: { code: 'ArrowUp', keyCode: 38 },
	ArrowRight: { code: 'ArrowRight', keyCode: 39 },
	ArrowDown: { code: 'ArrowDown', keyCode: 40 },
	Home: { code: 'Home', keyCode: 36 },
	End: { code: 'End', keyCode: 35 },
	PageUp: { code: 'PageUp', keyCode: 33 },
	PageDown: { code: 'PageDown', keyCode: 34 },
	Space: { code: 'Space', keyCode: 32 },
};
for (let n = 1; n <= 12; n++) {
	NAMED_KEYS[`F${n}`] = { code: `F${n}`, keyCode: 111 + n };
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

function describeKey(key: string): { key: string; code: string; keyCode: number; text: string | undefined } {
	const named = NAMED_KEYS[key];
	if (named) {
		return { key: key === 'Space' ? ' ' : key, code: named.code, keyCode: named.keyCode, text: key === 'Space' ? ' ' : key === 'Enter' ? '\r' : undefined };
	}
	if (key.length !== 1) {
		throw new Error(`Unknown key "${key}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(', ')}.`);
	}
	const upper = key.toUpperCase();
	const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : '';
	return { key, code, keyCode: upper.charCodeAt(0), text: key };
}

async function pressKey(key: string, modifiers: readonly (keyof typeof MODIFIER_BITS)[]): Promise<void> {
	const described = describeKey(key);
	const bits = modifiers.reduce((sum, name) => sum | MODIFIER_BITS[name], 0);
	// With ctrl/alt/meta held, a key is a shortcut, not text.
	const text = bits & (MODIFIER_BITS.ctrl | MODIFIER_BITS.alt | MODIFIER_BITS.meta) ? undefined : described.text;
	const base = { key: described.key, code: described.code, windowsVirtualKeyCode: described.keyCode, modifiers: bits };
	await evaluate('window.focus()');
	await cdp('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', text, ...base });
	await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

function truncate(text: string): string {
	return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : text;
}

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

function describeReport(report: TerminalReport): string {
	const status = report.running ? 'still running' : `exited with code ${report.exitCode ?? 'unknown'}`;
	const output = report.output.length > MAX_RESULT_CHARS ? `… (earlier output omitted)\n${report.output.slice(-MAX_RESULT_CHARS)}` : report.output;
	return `Terminal ${report.terminalId} ${status}.\n${output}`;
}

/** Gives the interface a moment to react (menus opening, dialogs appearing) before it is inspected. */
function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 250));
}

export function registerUiTools(server: McpServer): void {
	server.registerTool(
		'ide_run_command',
		{
			description: 'Run an IDE (VS Code) command by id, for example "workbench.action.showCommands" to open the command palette, "workbench.action.files.saveAll" or "workbench.action.terminal.new". Returns the command result as JSON, if any.',
			inputSchema: {
				command: z.string().describe('Command id.'),
				args: z.array(z.unknown()).optional().describe('JSON arguments passed to the command.'),
			},
		},
		async ({ command, args }) => {
			const result = await vscode.commands.executeCommand(command, ...(args ?? []));
			return textResult(result === undefined ? `Ran ${command}.` : truncate(JSON.stringify(result, null, 2) ?? `Ran ${command}.`));
		},
	);

	server.registerTool(
		'ide_chat_new_tab',
		{
			description: 'Open a NEW chat tab in the IDE (the current tab and its conversation stay open) for a provider, with model, mode and effort already selected, optionally sending the first message. Prefer this over clicking through the pickers. Returns what was selected; if a name does not match, the result lists the valid providers, pickers and options, so call it again with the right ones.',
			inputSchema: {
				provider: z.string().optional().describe('Provider: "Claude Code", "Codex CLI", "Gemini CLI", "OpenCode", "NVIDIA", "OpenRouter" (or the session type, for example "nova-openrouter"). Default: Local, with no provider.'),
				model: z.string().optional().describe('Model id or name, for example "Sonnet 5" or "openrouter/free". A unique partial name works.'),
				mode: z.string().optional().describe('Mode / permission mode, for example "Accept edits".'),
				effort: z.string().optional().describe('Thinking / reasoning effort, when the provider has one.'),
				options: z.record(z.string(), z.string()).optional().describe('Any other picker, keyed by its id or name.'),
				prompt: z.string().optional().describe('First message to send in the new tab.'),
			},
		},
		async args => {
			const result = await vscode.commands.executeCommand('workbench.action.chat.nova.openTab', args);
			return textResult(truncate(JSON.stringify(result, null, 2) ?? 'Done.'));
		},
	);

	server.registerTool(
		'ide_ui_snapshot',
		{
			description: 'List the visible interactive elements of the Nova IDE window (buttons, menus, tabs, tree rows, inputs, dialog buttons) with a numeric reference each. Use the references with ide_ui_click and ide_ui_type. While a modal dialog is open, only its elements are listed. Call it again after every action, because references change.',
			inputSchema: {},
		},
		async () => {
			return textResult(await takeSnapshot());
		},
	);

	server.registerTool(
		'ide_ui_click',
		{
			description: 'Click an element of the IDE window, by reference from ide_ui_snapshot or by x/y in window pixels. Returns the updated snapshot.',
			inputSchema: {
				ref: z.number().int().positive().optional().describe('Reference from the latest ide_ui_snapshot.'),
				x: z.number().optional().describe('Window x in CSS pixels, when there is no reference.'),
				y: z.number().optional().describe('Window y in CSS pixels, when there is no reference.'),
				button: z.enum(['left', 'right']).optional().describe('Default left. Right opens the context menu.'),
				double: z.boolean().optional().describe('Double click.'),
			},
		},
		async ({ ref, x, y, button, double }) => {
			const point = ref !== undefined ? await centerOf(ref) : x !== undefined && y !== undefined ? { x, y } : undefined;
			if (!point) {
				throw new Error('Pass either ref or both x and y.');
			}
			await click(point.x, point.y, button ?? 'left', double ? 2 : 1);
			await settle();
			return textResult(await takeSnapshot());
		},
	);

	server.registerTool(
		'ide_ui_type',
		{
			description: 'Type text into the focused element of the IDE window (input box, editor, chat box, quick input). With ref, that element is clicked first to focus it. Returns the updated snapshot. Use ide_ui_key for Enter, Escape, arrows and shortcuts.',
			inputSchema: {
				text: z.string().describe('Text to insert.'),
				ref: z.number().int().positive().optional().describe('Reference of the element to focus first.'),
			},
		},
		async ({ text, ref }) => {
			if (ref !== undefined) {
				const point = await centerOf(ref);
				await click(point.x, point.y, 'left', 1);
			}
			await cdp('Input.insertText', { text });
			await settle();
			return textResult(await takeSnapshot());
		},
	);

	server.registerTool(
		'ide_ui_key',
		{
			description: 'Press a key in the IDE window, optionally with modifiers, for example key "p" with ["ctrl","shift"] for the command palette, or "Enter" to confirm a dialog. Keys: a single character, Enter, Escape, Tab, Backspace, Delete, Arrow*, Home, End, PageUp, PageDown, Space, F1 to F12. Returns the updated snapshot.',
			inputSchema: {
				key: z.string(),
				modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional(),
			},
		},
		async ({ key, modifiers }) => {
			await pressKey(key, modifiers ?? []);
			await settle();
			return textResult(await takeSnapshot());
		},
	);

	server.registerTool(
		'ide_ui_screenshot',
		{ description: 'Capture a PNG screenshot of the IDE window, to see what the user sees.', inputSchema: {} },
		async () => {
			const { data } = await cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' });
			return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] };
		},
	);

	server.registerTool(
		'ide_terminal_run',
		{
			description: 'Run a command in a visible terminal of the IDE (cmd.exe on Windows, the default shell elsewhere) and return its output and exit code. The user is asked to approve every command. If the command is still running after timeoutMs (a server, a watcher), the output so far is returned with the terminal id; use ide_terminal_read, ide_terminal_send and ide_terminal_kill with it.',
			inputSchema: {
				command: z.string().describe('The command line.'),
				cwd: z.string().optional().describe('Working directory. Default: the workspace folder.'),
				timeoutMs: z.number().int().positive().optional().describe('How long to wait for it to finish. Default 120000.'),
			},
		},
		async ({ command, cwd, timeoutMs }) => {
			await ensureTerminalCommandAllowed(command);
			return textResult(describeReport(await runInTerminal(command, cwd, timeoutMs ?? 120_000)));
		},
	);

	server.registerTool(
		'ide_terminal_read',
		{
			description: 'Get the output a terminal started by ide_terminal_run produced since the last time it was reported. Optionally wait for it to finish first.',
			inputSchema: {
				terminalId: z.string(),
				waitMs: z.number().int().nonnegative().optional().describe('Wait up to this long for the command to end. Default 0.'),
			},
		},
		async ({ terminalId, waitMs }) => textResult(describeReport(await readTerminal(terminalId, waitMs ?? 0))),
	);

	server.registerTool(
		'ide_terminal_send',
		{
			description: 'Write text to the standard input of a terminal started by ide_terminal_run, for example the answer to a prompt. Include a newline to press Enter.',
			inputSchema: { terminalId: z.string(), text: z.string() },
		},
		async ({ terminalId, text }) => {
			sendToTerminal(terminalId, text);
			return textResult(`Sent ${text.length} characters to ${terminalId}.`);
		},
	);

	server.registerTool(
		'ide_terminal_kill',
		{ description: 'Stop the process of a terminal started by ide_terminal_run.', inputSchema: { terminalId: z.string() } },
		async ({ terminalId }) => {
			killTerminal(terminalId);
			return textResult(`Stopped ${terminalId}.`);
		},
	);
}
