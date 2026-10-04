/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  The MCP endpoint per tool profile, through the real MCP SDK handler: tools/list and
 *  tools/call agree, /mcp stays the full catalog, and how big each catalog is. The vscode API is
 *  replaced by a tiny stub (only ide_manual is called). Run: node --test out/test
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import Module = require('node:module');
import { test } from 'node:test';
import type { McpToolCallRecord } from '../server/mcp';

// The tools import 'vscode' at load time; point it to a stub before loading them.
const moduleInternals = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = (request: string, ...rest: unknown[]) => request === 'vscode' ? 'vscode-stub' : resolveFilename(request, ...rest);
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: { extensions: { getExtension: () => undefined } } } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createMcpHandler } = require('@modelcontextprotocol/server') as typeof import('@modelcontextprotocol/server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildMcpServer } = require('../server/mcp') as typeof import('../server/mcp');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { profileFromPath } = require('../server/toolProfiles') as typeof import('../server/toolProfiles');

const calls: McpToolCallRecord[] = [];
const fakeBrowser = {} as never;
const fakeDevServer = {} as never;

async function rpc(path: string, method: string, params: object): Promise<{ result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean; instructions?: string }; error?: { message: string } }> {
	const profile = profileFromPath(path)!;
	const handler = createMcpHandler(() => buildMcpServer(fakeBrowser, fakeDevServer, profile, record => calls.push(record)));
	const response = await handler.fetch(new Request(`http://127.0.0.1${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	}));
	const text = await response.text();
	await handler.close();
	return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

test('each profile lists its own catalog and /mcp stays the full one', async t => {
	const catalogs: Record<string, { name: string }[]> = {};
	for (const path of ['/mcp', '/mcp/browser', '/mcp/code']) {
		catalogs[path] = (await rpc(path, 'tools/list', {})).result!.tools!;
	}
	const names = (path: string) => catalogs[path].map(tool => tool.name).sort();
	assert.deepStrictEqual(names('/mcp/code'), ['ide_chat_new_tab', 'ide_manual', 'ide_open_file', 'ide_run_command', 'ide_show_diff']);
	assert.ok(names('/mcp/browser').includes('browser_fill_form') && names('/mcp/browser').includes('devserver_status'));
	assert.ok(!names('/mcp/browser').some(name => name.startsWith('ide_ui_') || name.startsWith('ide_terminal_')));
	assert.ok(names('/mcp').includes('ide_ui_click') && names('/mcp').includes('ide_terminal_run') && names('/mcp').includes('browser_fill_form'));
	for (const path of Object.keys(catalogs)) {
		t.diagnostic(`${path}: ${catalogs[path].length} tools, ${JSON.stringify(catalogs[path]).length} characters of tool definitions`);
	}
});

test('a tool outside the profile cannot be called on that endpoint', async () => {
	const response = await rpc('/mcp/code', 'tools/call', { name: 'ide_terminal_run', arguments: { command: 'echo hi' } });
	const failed = response.error !== undefined || response.result?.isError === true;
	assert.ok(failed, JSON.stringify(response));
});

test('tool calls are measured: name, profile and result size, without the content', async () => {
	calls.length = 0;
	const response = await rpc('/mcp/code', 'tools/call', { name: 'ide_manual', arguments: { topic: 'kubernetes' } });
	const text = response.result!.content![0].text;
	assert.ok(text.startsWith('No manual section matches'), text);
	assert.deepStrictEqual(calls.map(call => ({ ...call, durationMs: 0 })), [{ tool: 'ide_manual', profile: 'code', durationMs: 0, threw: false, textChars: text.length, images: 0, imageBytes: 0, isError: false, truncated: false }]);
});
