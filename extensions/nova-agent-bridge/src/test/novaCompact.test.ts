/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Unit tests of the Nova compact prompts and parsing. Run: node --test "out/test/*.test.js"
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { buildSummaryRequest, clampSummaryChars, cleanSummary, parseCompactCommand, wrapSummary } from '../novaCompact';

test('the commands: /nova-compact with an optional focus, /compact is the agent\'s, anything else is a message', () => {
	assert.deepStrictEqual([
		parseCompactCommand('/nova-compact'),
		parseCompactCommand('  /nova-compact   keep the test numbers\nand paths '),
		parseCompactCommand('/compact focus on tests'),
		parseCompactCommand('/compacting'),
		parseCompactCommand('please /nova-compact'),
		parseCompactCommand('/review')
	], [
		{ kind: 'nova', focus: '' },
		{ kind: 'nova', focus: 'keep the test numbers\nand paths' },
		{ kind: 'native' },
		undefined,
		undefined,
		undefined
	]);
});

test('the summary request carries the size limit, the sections and the focus, and forbids tools', () => {
	const request = buildSummaryRequest(6000, 'the form tests');
	assert.deepStrictEqual([
		request.includes('at most 6000 characters'),
		request.includes('Do not call tools'),
		['## User request', '## Done so far', '## Files', '### <path>', '- Values:', '## Key facts', '## Pending'].every(section => request.includes(section)),
		request.includes('focus on: the form tests'),
		buildSummaryRequest(6000, '').includes('focus on')
	], [true, true, true, true, false]);
});

test('summaries: fences are removed, short answers are rejected, limits are clamped', () => {
	const body = '## User request\n' + 'x'.repeat(300);
	assert.deepStrictEqual([
		cleanSummary('```markdown\n' + body + '\n```'),
		cleanSummary('  ' + body + '  '),
		cleanSummary('I cannot do that.'),
		clampSummaryChars(undefined),
		clampSummaryChars(100),
		clampSummaryChars(99999),
		wrapSummary('S').startsWith('<nova-conversation-summary>') && wrapSummary('S').endsWith('S\n</nova-conversation-summary>')
	], [body, body, undefined, 6000, 1500, 20000, true]);
});
