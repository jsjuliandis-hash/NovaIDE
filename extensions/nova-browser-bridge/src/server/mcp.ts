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
import { NovaBrowser } from '../novaBrowser';
import { ensureEvaluateAllowed } from './security';

const pageIdSchema = z.string().describe('Page id returned by browser_list_pages or browser_open.');

export function buildMcpServer(novaBrowser: NovaBrowser, devServerManager: DevServerManager): McpServer {
	const server = new McpServer({ name: 'nova-browser-bridge', version: '0.1.0' });

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
			description: 'Navigate an existing page to a new URL.',
			inputSchema: { pageId: pageIdSchema, url: z.string() },
		},
		async ({ pageId, url }) => {
			await novaBrowser.navigate(pageId, url);
			return textResult(await novaBrowser.snapshot(pageId));
		},
	);

	server.registerTool(
		'browser_reload',
		{ description: 'Reload a page.', inputSchema: { pageId: pageIdSchema } },
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
			description: 'Get an accessibility (ARIA) snapshot of a page: title, URL, and structured content. Prefer this over browser_screenshot for deciding what to do next.',
			inputSchema: { pageId: pageIdSchema },
		},
		async ({ pageId }) => textResult(await novaBrowser.snapshot(pageId)),
	);

	server.registerTool(
		'browser_screenshot',
		{
			description: 'Capture a PNG screenshot of a page.',
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
			description: 'Click an element, identified by a Playwright selector (e.g. "text=Sign in", "#submit") or an `aria-ref=<ref>` from a browser_snapshot. Returns the updated snapshot.',
			inputSchema: { pageId: pageIdSchema, target: z.string() },
		},
		async ({ pageId, target }) => textResult(await novaBrowser.click(pageId, target)),
	);

	server.registerTool(
		'browser_type',
		{
			description: 'Fill a form field, identified the same way as browser_click. Returns the updated snapshot.',
			inputSchema: { pageId: pageIdSchema, target: z.string(), text: z.string() },
		},
		async ({ pageId, target, text }) => textResult(await novaBrowser.type(pageId, target, text)),
	);

	server.registerTool(
		'browser_console',
		{
			description: 'Get recent console messages and page errors captured since the page was connected to.',
			inputSchema: { pageId: pageIdSchema, sinceMs: z.number().optional().describe('Only return entries at or after this Date.now() timestamp.') },
		},
		async ({ pageId, sinceMs }) => textResult(JSON.stringify(novaBrowser.consoleLogs(pageId, sinceMs), null, 2)),
	);

	server.registerTool(
		'browser_run_playwright',
		{
			description: 'Run arbitrary Playwright code against a page, e.g. "async (page) => { await page.hover(\'.menu\'); return page.url(); }". Requires one-time user confirmation per workspace.',
			inputSchema: { pageId: pageIdSchema, code: z.string().describe('An async (page) => ... function body/expression, as a string.') },
		},
		async ({ pageId, code }) => {
			await ensureEvaluateAllowed();
			const outcome = await novaBrowser.runPlaywright(pageId, code);
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome, null, 2) }],
				...(outcome.error ? { isError: true } : {}),
			};
		},
	);

	server.registerTool(
		'devserver_status',
		{ description: "Get the workspace's detected dev server status: phase (idle/not-detected/starting/running/error/stopped), URL if running, and command/cwd.", inputSchema: {} },
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

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}
