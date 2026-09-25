/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Tests of how answers are cut into pieces for the voice.
 *-------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { splitForSynthesis } from '../../electron-browser/novaTextToSpeech/novaTextToSpeechService.js';

suite('Nova text to speech: splitForSynthesis', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps short text in one piece and replaces links', () => {
		assert.deepStrictEqual(splitForSynthesis('Veja https://example.com/a?b=1 agora. Depois volte.', 100), ['Veja link agora. Depois volte.']);
	});

	test('never reads asterisks', () => {
		assert.deepStrictEqual(splitForSynthesis('Isto é **muito** importante, *sim*. 2*3 é seis.', 100), ['Isto é muito importante, sim . 2 3 é seis.']);
	});

	test('never reads backticks', () => {
		assert.deepStrictEqual(splitForSynthesis('Rode `npm test` e depois ```ok```.', 100), ['Rode npm test e depois ok .']);
	});

	test('never reads slashes, backslashes or emojis', () => {
		assert.deepStrictEqual(splitForSynthesis('Use e/ou C:\\pasta 🚀 e 👍🏽 pronto ✅.', 100), ['Use e ou C: pasta e pronto .']);
	});

	test('cuts at sentence ends when the text is longer than the limit', () => {
		assert.deepStrictEqual(splitForSynthesis('Primeira frase aqui. Segunda frase aqui. Terceira.', 25), ['Primeira frase aqui.', 'Segunda frase aqui.', 'Terceira.']);
	});

	test('cuts a sentence that is longer than the limit and drops pieces with nothing to read', () => {
		assert.deepStrictEqual(splitForSynthesis('abcdefghij\n---\n***', 4), ['abcd', 'efgh', 'ij']);
	});
});
