/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Unit tests of the activity panel texts. Run: node --test "out/test/*.test.js"
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { diffText, inlineCode, MAX_ACTIVITY_DETAIL, shortText, tail, toolOutputText } from '../activityLog';

test('titles are one short line and inline code survives backticks', () => {
	assert.deepStrictEqual([
		shortText('npm   run\n test'),
		shortText('x'.repeat(200)).length,
		inlineCode('src/a.ts'),
		inlineCode('echo `date`'),
	], ['npm run test', 160, '`src/a.ts`', '`` echo `date` ``']);
});

test('command output: text content first, else a string raw output, keeping the end of long output', () => {
	const long = 'a'.repeat(MAX_ACTIVITY_DETAIL) + 'END';
	assert.deepStrictEqual([
		toolOutputText([{ type: 'content', content: { type: 'text', text: 'line 1' } }, { type: 'content', content: { type: 'text', text: 'line 2\n' } }], 'ignored'),
		toolOutputText([], 'raw output'),
		toolOutputText(undefined, { exitCode: 0 }),
		toolOutputText(undefined, '   '),
		toolOutputText([{ type: 'content', content: { type: 'text', text: '```console\num\nDOIS\n```' } }], undefined),
		tail(long).endsWith('END') && tail(long).startsWith('…\n'),
	], ['line 1\nline 2', 'raw output', undefined, undefined, 'um\nDOIS', true]);
});

test('edits show only the changed lines of each file', () => {
	const diff = diffText([
		{ type: 'diff', path: 'src/a.ts', oldText: 'one\ntwo\nthree', newText: 'one\nTWO\nthree' },
		{ type: 'diff', path: 'src/new.ts', oldText: null, newText: 'created' },
		{ type: 'content', content: { type: 'text', text: 'not a diff' } },
	]);
	assert.deepStrictEqual([diff, diffText([]), diffText(undefined)], ['@@ src/a.ts\n- two\n+ TWO\n@@ src/new.ts\n+ created', undefined, undefined]);
});
