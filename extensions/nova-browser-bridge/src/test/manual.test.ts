/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Unit tests of the manual helpers, against the real SKILL.md. Run: node --test out/test
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { extractCompactManual, listManualTopics, manualForMode, selectManualSection } from '../server/manual';

const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'nova-ide', 'SKILL.md'), 'utf8');

test('compact manual is the marked quick rules, short and with the essential rules', () => {
	const compact = extractCompactManual(manual)!;
	assert.ok(compact.length <= 1600, `compact manual has ${compact.length} characters`);
	for (const rule of ['ide_open_file', 'ide_show_diff', 'browser_fill_form', 'ide_chat_new_tab', 'ide_manual', 'same turn', 'snapshot']) {
		assert.ok(compact.includes(rule), `compact manual mentions ${rule}`);
	}
	assert.ok(!compact.includes('<!--'), 'markers are not part of it');
});

test('modes: compact, full and off', () => {
	assert.deepStrictEqual([manualForMode(manual, 'compact'), manualForMode(manual, 'off')], [extractCompactManual(manual), undefined]);
	const full = manualForMode(manual, 'full')!;
	assert.ok(!full.includes('## Quick rules') && !full.includes('<!--'), 'full mode leaves out the summary of itself');
	assert.ok(full.includes('# Working inside Nova IDE') && full.includes('## Showing things to the user') && full.includes('## Checklist before answering'));
	const removed = manual.length - full.length;
	const quickRules = extractCompactManual(manual)!.length;
	assert.ok(removed > quickRules && removed < quickRules + 120, `only the quick rules section is removed (${removed} characters)`);
	assert.strictEqual(manualForMode('# no markers', 'compact'), '# no markers');
	assert.strictEqual(manualForMode('# no markers', 'full'), '# no markers');
});

test('topics and aliases return one section, never the whole manual', () => {
	const headingOf = (text: string) => text.split('\n', 1)[0].trimEnd(); // the file may use CRLF
	assert.deepStrictEqual(
		['browser', 'navegador', 'ui', 'ide', 'terminal', 'files', 'chat', 'Integrated Browser'].map(topic => headingOf(selectManualSection(manual, topic))),
		['## Integrated Browser', '## Integrated Browser', '## Acting on the IDE itself', '## Acting on the IDE itself', '## Terminals and CLI', '## Showing things to the user', '## The Chat panel', '## Integrated Browser']
	);
	assert.ok(!selectManualSection(manual, 'quick').includes('<!--'));
});

test('no topic returns the whole manual; an unknown topic returns the short list of topics', () => {
	assert.strictEqual(selectManualSection(manual, undefined), manual);
	assert.strictEqual(selectManualSection(manual, '  '), manual);
	const unknown = selectManualSection(manual, 'kubernetes');
	assert.ok(unknown.length < 600, `unknown topic answer has ${unknown.length} characters`);
	assert.ok(unknown.startsWith('No manual section matches "kubernetes".'));
	for (const topic of listManualTopics(manual)) {
		assert.ok(unknown.includes(topic));
	}
});

test('the short quick rules section does not swallow the rest of the manual', () => {
	const quick = selectManualSection(manual, 'quick rules');
	assert.ok(quick.length < 1800, `quick rules section has ${quick.length} characters`);
	assert.ok(!quick.includes('## Showing things'));
});
