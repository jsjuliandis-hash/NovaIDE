/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Unit tests of the Nova compact prompts and parsing. Run: node --test "out/test/*.test.js"
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { buildSummaryRequest, chooseTitle, clampSummaryChars, cleanSummary, parseCompactCommand, parseSummaryDocument, splitTitle, summaryDocument, summaryFileName, wrapSummary } from '../novaCompact';

test('the commands: /nova-compact and /nova-save with an optional focus, /compact is the agent\'s, anything else is a message', () => {
	assert.deepStrictEqual([
		parseCompactCommand('/nova-compact'),
		parseCompactCommand('  /nova-compact   keep the test numbers\nand paths '),
		parseCompactCommand('/nova-save'),
		parseCompactCommand('/nova-save the form tests'),
		parseCompactCommand('/nova-loaded'),
		parseCompactCommand('/compact focus on tests'),
		parseCompactCommand('/compacting'),
		parseCompactCommand('please /nova-compact'),
		parseCompactCommand('/review')
	], [
		{ kind: 'nova', focus: '' },
		{ kind: 'nova', focus: 'keep the test numbers\nand paths' },
		{ kind: 'save', focus: '' },
		{ kind: 'save', focus: 'the form tests' },
		{ kind: 'loaded' },
		{ kind: 'native' },
		undefined,
		undefined,
		undefined
	]);
});

test('the summary request carries the size limit, the title line, the sections and the focus, and forbids tools', () => {
	const request = buildSummaryRequest(6000, 'the form tests');
	assert.deepStrictEqual([
		request.includes('at most 6000 characters'),
		request.includes('Do not call tools'),
		request.includes('`TITLE: `'),
		['## User request', '## Done so far', '## Files', '### <path>', '- Values:', '## Key facts', '## Pending'].every(section => request.includes(section)),
		request.includes('focus on: the form tests'),
		buildSummaryRequest(6000, '').includes('focus on')
	], [true, true, true, true, true, false]);
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

test('titles: the TITLE line is split off and cleaned, with fallbacks when the agent leaves it out', () => {
	const body = '## User request\nAdd a save button to the chat\n## Done so far\nnothing';
	assert.deepStrictEqual([
		splitTitle('TITLE: Botão de salvar o chat\n' + body),
		splitTitle('**TITLE:** "Botão `de` salvar"\n' + body).title,
		splitTitle(body),
		splitTitle('TITLE: ' + 'a'.repeat(100) + '\n' + body).title?.length,
		chooseTitle(undefined, body),
		chooseTitle('Meu título', body),
		chooseTitle(undefined, 'no sections here')
	], [
		{ title: 'Botão de salvar o chat', body },
		'Botão de salvar',
		{ title: undefined, body },
		60,
		'Add a save button to the chat',
		'Meu título',
		'Conversa sem título'
	]);
});

test('a saved summary is read back with its code, and other files are not mistaken for one', () => {
	const date = new Date('2026-10-15T12:30:00.000Z');
	const summary = '## User request\nx\n\n---\n\nthe summary itself has a separator above';
	const text = summaryDocument({ code: 7, title: 'Botão de salvar', agentType: 'nova-claude-code', provider: 'Claude Code', date, contextBefore: 51000, options: { model: 'haiku', effort: 'medium' }, summary });
	assert.deepStrictEqual([
		parseSummaryDocument(text),
		parseSummaryDocument(text.replace('**Código:** 7\n', '')),
		parseSummaryDocument('# Nova compact — Claude Code\n\n**Data:** 2026-10-04 10:00\n\nold format'),
		summaryFileName(7, 'Botão de salvar o chat: ação!', date)
	], [
		{ code: 7, title: 'Botão de salvar', agentType: 'nova-claude-code', provider: 'Claude Code', date, options: { model: 'haiku', effort: 'medium' }, summary },
		undefined,
		undefined,
		'2026-10-15T12-30-00-000Z-7-botao-de-salvar-o-chat-acao.md'
	]);
});
