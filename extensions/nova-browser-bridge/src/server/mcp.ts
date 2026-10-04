/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Builds the MCP server exposed at /mcp. Every browser_* tool is a thin
 *  pass-through to NovaBrowser; the interesting bridging work (Playwright over
 *  the tab's own CDP session) lives in novaBrowser.ts, not here.
 *  devserver_* tools are a thin pass-through to DevServerManager (Fase 5).
 *-------------------------------------------------------------------------------------------*/

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DevServerManager } from '../devServer/devServerManager';
import { MAX_FORM_FIELDS } from '../formFill';
import { NovaBrowser } from '../novaBrowser';
import { ensureEvaluateAllowed } from './security';
import { registerIdeTools } from './ideTools';
import { measureToolResult, type ToolResultVolume } from './textLimit';
import { isToolInProfile, mcpInstructions, type ToolProfile } from './toolProfiles';

const pageIdSchema = z.string().describe('Page id returned by browser_list_pages or browser_open.');

const formFieldSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('text'),
		target: z.string(),
		value: z.string(),
		slowly: z.boolean().optional().describe('Type key by key, for masked inputs (phone, CPF, dates).'),
	}),
	z.object({ kind: z.literal('checkbox'), target: z.string(), checked: z.boolean().describe('Also works for radio buttons (true).') }),
	z.object({ kind: z.literal('select'), target: z.string(), value: z.string().optional(), label: z.string().optional() }),
]);

/** One MCP tool call as measured for the usage log: sizes, never the content. */
export interface McpToolCallRecord extends ToolResultVolume {
	readonly tool: string;
	readonly profile: ToolProfile;
	readonly durationMs: number;
	/** The handler threw (the client gets a protocol error instead of a result). */
	readonly threw: boolean;
}

export function buildMcpServer(novaBrowser: NovaBrowser, devServerManager: DevServerManager, profile: ToolProfile = 'full', onToolCall?: (record: McpToolCallRecord) => void): McpServer {
	const server = new McpServer({ name: 'nova-browser-bridge', version: '0.1.0' }, { instructions: mcpInstructions(profile) });
	shapeCatalog(server, profile, onToolCall);
	registerIdeTools(server);

	server.registerTool(
		'browser_list_pages',
		{ description: 'List every page currently open in the Nova IDE Integrated Browser.', inputSchema: {} },
		async () => textResult(JSON.stringify(novaBrowser.listPages(), null, 2)),
	);

	server.registerTool(
		'browser_open',
		{
			description: 'Open a URL in the Integrated Browser. Returns the page id to use with other browser_* tools.',
			inputSchema: {
				url: z.string().describe('Absolute URL to open.'),
				reuse: z.boolean().optional().describe('Reuse an already-open page on the same host instead of opening a new one.'),
				background: z.boolean().optional().describe('Open without switching focus to the new tab.'),
			},
		},
		async ({ url, reuse, background }) => textResult(await novaBrowser.open(url, { reuse, background })),
	);

	server.registerTool(
		'browser_navigate',
		{
			description: 'Navigate an existing page to a new URL. Returns the updated snapshot.',
			inputSchema: { pageId: pageIdSchema, url: z.string() },
		},
		async ({ pageId, url }) => {
			await novaBrowser.navigate(pageId, url);
			return textResult(await novaBrowser.snapshot(pageId));
		},
	);

	server.registerTool(
		'browser_reload',
		{ description: 'Reload a page. Returns the updated snapshot.', inputSchema: { pageId: pageIdSchema } },
		async ({ pageId }) => {
			await novaBrowser.reload(pageId);
			return textResult(await novaBrowser.snapshot(pageId));
		},
	);

	server.registerTool(
		'browser_close',
		{ description: 'Close a page.', inputSchema: { pageId: pageIdSchema } },
		async ({ pageId }) => {
			await novaBrowser.close(pageId);
			return textResult(`Closed ${pageId}`);
		},
	);

	server.registerTool(
		'browser_snapshot',
		{
			description: 'Get an accessibility (ARIA) snapshot of a page: title, URL, and structured content. Prefer this over browser_screenshot for deciding what to do next. Actions (navigate, click, type, fill_form) already return it, so call this only when the page changed by itself. On big pages pass rootSelector (one region) and/or maxChars; a partial result says how to get the rest.',
			inputSchema: {
				pageId: pageIdSchema,
				rootSelector: z.string().optional().describe('Snapshot only this element, e.g. "main", "form#signup" or "label=Cart".'),
				maxChars: z.number().int().positive().optional().describe('Return at most this many characters (whole lines).'),
				startLine: z.number().int().positive().optional().describe('First line to return, to continue a partial snapshot.'),
			},
		},
		async ({ pageId, rootSelector, maxChars, startLine }) => textResult(await novaBrowser.snapshot(pageId, { rootSelector, maxChars, startLine })),
	);

	server.registerTool(
		'browser_screenshot',
		{
			description: 'Capture a PNG screenshot of a page. Use it only to check layout or visuals; the snapshot is cheaper for everything else.',
			inputSchema: { pageId: pageIdSchema, fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport.') },
		},
		async ({ pageId, fullPage }) => {
			const png = await novaBrowser.screenshot(pageId, { fullPage });
			return { content: [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }] };
		},
	);

	server.registerTool(
		'browser_click',
		{
			description: 'Click an element, identified by a Playwright selector (e.g. "text=Sign in", "#submit"), label=<text>, placeholder=<text> or an `aria-ref=<ref>` from a browser_snapshot. Returns the updated snapshot.',
			inputSchema: { pageId: pageIdSchema, target: z.string() },
		},
		async ({ pageId, target }) => textResult(await novaBrowser.click(pageId, target)),
	);

	server.registerTool(
		'browser_type',
		{
			description: 'Fill ONE form field, identified the same way as browser_click. Returns the updated snapshot. To fill two or more fields use browser_fill_form instead (one call, one snapshot).',
			inputSchema: { pageId: pageIdSchema, target: z.string(), text: z.string() },
		},
		async ({ pageId, target, text }) => textResult(await novaBrowser.type(pageId, target, text)),
	);

	server.registerTool(
		'browser_fill_form',
		{
			description: `Fill up to ${MAX_FORM_FIELDS} form fields in one call (text, checkbox/radio, select), in order, then return one snapshot. Targets: CSS/Playwright selectors, label=<text> or placeholder=<text> (not aria-ref). It never clicks buttons or submits: do that afterwards with browser_click. It stops at the first field that fails and reports which one; fields before it stay filled, so do not resend them.`,
			inputSchema: {
				pageId: pageIdSchema,
				fields: z.array(formFieldSchema).describe('Fields in the order to fill them.'),
				includeSnapshot: z.boolean().optional().describe('Default true. false returns only the outcome.'),
			},
		},
		async ({ pageId, fields, includeSnapshot }) => {
			const outcome = await novaBrowser.fillForm(pageId, fields, { includeSnapshot });
			const failed = outcome.failedIndex !== undefined || outcome.errorCategory !== undefined;
			const lines = [`Filled ${outcome.filled} of ${outcome.total} fields.`];
			if (failed) {
				const which = outcome.failedIndex !== undefined ? `Field ${outcome.failedIndex + 1} (${outcome.failedTarget})` : 'The request';
				lines.push(`${which} failed [${outcome.errorCategory}]: ${outcome.error}`);
				if (outcome.filled > 0) {
					lines.push('The fields before it are filled; fields after it were not touched.');
				}
			}
			if (outcome.summary) {
				lines.push('', outcome.summary);
			}
			return { content: [{ type: 'text' as const, text: lines.join('\n') }], ...(failed ? { isError: true } : {}) };
		},
	);

	server.registerTool(
		'browser_wait_for_reload',
		{
			description: 'Call right after editing source files: waits until the page picks up the change (HMR update or full reload from the dev server), then returns the updated snapshot and a screenshot. An update applied within the last lookbackMs (default 3000) also counts. reason is "timeout" if nothing happened. Pass includeScreenshot: false when checking text or behavior (the image is the costly part) and includeSnapshot: false when only the reload itself matters.',
			inputSchema: {
				pageId: pageIdSchema,
				timeoutMs: z.number().optional().describe('How long to wait for an update. Default 30000.'),
				lookbackMs: z.number().optional().describe('Accept an update that already happened this many ms ago. Default 3000; use 0 to only wait for a new one.'),
				includeScreenshot: z.boolean().optional().describe('Default true. Keep it for layout or visual checks.'),
				includeSnapshot: z.boolean().optional().describe('Default true. false returns only the reason, title and URL.'),
			},
		},
		async ({ pageId, timeoutMs, lookbackMs, includeScreenshot, includeSnapshot }) => {
			const outcome = await novaBrowser.waitForReload(pageId, { timeoutMs, lookbackMs, includeSnapshot });
			const header = `Reload reason: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`;
			const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: `${header}\n${outcome.summary}` }];
			if (includeScreenshot !== false) {
				const png = await novaBrowser.screenshot(pageId);
				content.push({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
			}
			return { content };
		},
	);

	server.registerTool(
		'browser_console',
		{
			description: 'Get console messages and page errors captured since the page was connected to. Pass cursor (the nextCursor of the previous call) to get only new entries instead of the whole history again, and limit to cap how many come back.',
			inputSchema: {
				pageId: pageIdSchema,
				sinceMs: z.number().optional().describe('Only return entries at or after this Date.now() timestamp.'),
				cursor: z.number().int().nonnegative().optional().describe('nextCursor from the previous call; 0 for the start.'),
				limit: z.number().int().positive().optional().describe('Most entries to return (oldest first).'),
			},
		},
		async ({ pageId, sinceMs, cursor, limit }) => {
			if (cursor === undefined && limit === undefined) {
				return textResult(JSON.stringify(novaBrowser.consoleLogs(pageId, sinceMs), null, 2));
			}
			return textResult(JSON.stringify(novaBrowser.consoleLogsPage(pageId, { cursor, limit, sinceMs }), null, 2));
		},
	);

	server.registerTool(
		'browser_run_playwright',
		{
			description: 'Run arbitrary Playwright code against a page, e.g. "async (page) => { await page.hover(\'.menu\'); return page.url(); }". Requires one-time user confirmation per workspace. Pass includeSnapshot: false when the returned value answers the question (it then returns only title and URL besides the result).',
			inputSchema: {
				pageId: pageIdSchema,
				code: z.string().describe('An async (page) => ... function body/expression, as a string.'),
				includeSnapshot: z.boolean().optional().describe('Default true.'),
			},
		},
		async ({ pageId, code, includeSnapshot }) => {
			await ensureEvaluateAllowed();
			const outcome = await novaBrowser.runPlaywright(pageId, code, { includeSnapshot });
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome, null, 2) }],
				...(outcome.error ? { isError: true } : {}),
			};
		},
	);

	server.registerTool(
		'devserver_status',
		{ description: 'Get the workspace\'s detected dev server status: phase (idle/not-detected/starting/running/error/stopped), URL if running, and command/cwd.', inputSchema: {} },
		async () => textResult(JSON.stringify(devServerManager.status, null, 2)),
	);

	server.registerTool(
		'devserver_restart',
		{ description: 'Restart the detected dev server (starts it if it is not already running) and open its URL in the Integrated Browser once detected.', inputSchema: {} },
		async () => {
			await devServerManager.restart();
			return textResult(JSON.stringify(devServerManager.status, null, 2));
		},
	);

	return server;
}

type AnyToolHandler = (...args: never[]) => unknown;

/**
 * Makes every tool registered on `server` from now on (here and in ideTools/uiTools) follow the
 * profile — tools outside it are removed again, so tools/list and tools/call agree — and report
 * its duration and result size to `onToolCall`.
 */
function shapeCatalog(server: McpServer, profile: ToolProfile, onToolCall: ((record: McpToolCallRecord) => void) | undefined): void {
	const register = server.registerTool;
	server.registerTool = ((name: string, config: object, handler: AnyToolHandler) => {
		const measured = async (...args: never[]) => {
			const started = Date.now();
			try {
				const result = await handler(...args);
				onToolCall?.({ tool: name, profile, durationMs: Date.now() - started, threw: false, ...measureToolResult(result) });
				return result;
			} catch (error) {
				onToolCall?.({ tool: name, profile, durationMs: Date.now() - started, threw: true, textChars: 0, images: 0, imageBytes: 0, isError: true, truncated: false });
				throw error;
			}
		};
		// `call` is needed: the original method is detached from the instance it was replaced on.
		const tool = register.call(server, name, config as never, measured as never);
		if (!isToolInProfile(name, profile)) {
			tool.remove();
		}
		return tool;
	}) as typeof server.registerTool;
}

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}
