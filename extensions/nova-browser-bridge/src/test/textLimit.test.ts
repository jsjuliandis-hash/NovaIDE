/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Unit tests of the result-size helpers and tool profiles. Run: node --test out/test
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { describeLimit, limitLines, measureToolResult } from '../server/textLimit';
import { isToolInProfile, mcpInstructions, profileFromPath } from '../server/toolProfiles';

const tree = ['- main:', '  - heading "Cart" [ref=e1]', '  - button "Pay" [ref=e2]', '  - link "Back" [ref=e3]'].join('\n');

test('limitLines cuts on line boundaries and keeps whole element lines', () => {
	const first = limitLines(tree, { maxChars: 40 });
	assert.deepStrictEqual(first, { text: '- main:\n  - heading "Cart" [ref=e1]', truncated: true, firstLine: 1, lastLine: 2, totalLines: 4, totalChars: tree.length });
	const rest = limitLines(tree, { startLine: first.lastLine + 1 });
	assert.deepStrictEqual([rest.text, rest.firstLine, rest.lastLine], ['  - button "Pay" [ref=e2]\n  - link "Back" [ref=e3]', 3, 4]);
	assert.strictEqual(first.text + '\n' + rest.text, tree, 'the two parts rebuild the original');
});

test('limitLines without limits, with a tiny limit and on empty text', () => {
	assert.strictEqual(limitLines(tree, {}).truncated, false);
	assert.strictEqual(limitLines(tree, { maxChars: 1 }).text, '- main:', 'at least one line');
	assert.deepStrictEqual(limitLines('', { maxChars: 10 }), { text: '', truncated: false, firstLine: 0, lastLine: 0, totalLines: 0, totalChars: 0 });
	assert.strictEqual(limitLines(tree, { startLine: 99 }).text, '  - link "Back" [ref=e3]', 'a start past the end clamps to the last line');
});

test('describeLimit tells how to continue, and is empty when nothing was left out', () => {
	assert.strictEqual(describeLimit(limitLines(tree, {}), 'startLine: {next}'), '');
	assert.strictEqual(
		describeLimit(limitLines(tree, { maxChars: 40 }), 'call again with startLine: {next}.'),
		`… (partial: lines 1-2 of 4, 35 of ${tree.length} characters. For the rest: call again with startLine: 3.)`
	);
});

test('measureToolResult counts text and image volume, errors and partial results', () => {
	assert.deepStrictEqual(
		measureToolResult({ content: [{ type: 'text', text: 'abc\n… (partial: lines 1-2 of 9)' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true }),
		{ textChars: 31, images: 1, imageBytes: 3, isError: true, truncated: true }
	);
	assert.deepStrictEqual(measureToolResult(undefined), { textChars: 0, images: 0, imageBytes: 0, isError: false, truncated: false });
});

test('tool profiles: /mcp stays full, code and browser are subsets', () => {
	assert.deepStrictEqual(['/mcp', '/mcp/', '/mcp/full', '/mcp/browser', '/mcp/code', '/mcp/other', '/v1/pages'].map(profileFromPath), ['full', 'full', 'full', 'browser', 'code', undefined, undefined]);
	const tools = ['ide_open_file', 'ide_show_diff', 'ide_manual', 'ide_chat_new_tab', 'ide_run_command', 'browser_fill_form', 'devserver_status', 'ide_ui_click', 'ide_terminal_run'];
	assert.deepStrictEqual(
		{ code: tools.filter(t => isToolInProfile(t, 'code')), browser: tools.filter(t => isToolInProfile(t, 'browser')), full: tools.filter(t => isToolInProfile(t, 'full')) },
		{ code: tools.slice(0, 5), browser: tools.slice(0, 7), full: tools }
	);
	assert.ok(!mcpInstructions('code').includes('browser_'), 'code instructions do not mention missing tools');
	assert.ok(!mcpInstructions('browser').includes('ide_ui_'));
	assert.ok(mcpInstructions('full').includes('ide_terminal_run'));
});
