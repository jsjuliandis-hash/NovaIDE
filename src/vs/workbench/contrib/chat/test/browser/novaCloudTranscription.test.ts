/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *-------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveDictationBackend } from '../../browser/speechToText/chatSpeechToTextService.js';
import { DICTATION_NOVA_CLOUD_MODEL_ID, encodeWavPcm16, isSilentPcm16, parseGeminiTranscript, toIsoLanguageCode } from '../../browser/speechToText/novaCloudTranscription.js';

function pcm16(samples: number[]): Uint8Array {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
	return bytes;
}

suite('Nova cloud transcription', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('encodeWavPcm16 writes a 16 kHz mono 16-bit RIFF header', () => {
		const wav = encodeWavPcm16(pcm16([1, -1, 300]));
		const view = new DataView(wav.buffer);
		const text = (offset: number, length: number) => String.fromCharCode(...wav.slice(offset, offset + length));
		assert.deepStrictEqual({
			riff: text(0, 4),
			riffSize: view.getUint32(4, true),
			wave: text(8, 4),
			fmt: text(12, 4),
			format: view.getUint16(20, true),
			channels: view.getUint16(22, true),
			sampleRate: view.getUint32(24, true),
			byteRate: view.getUint32(28, true),
			bits: view.getUint16(34, true),
			data: text(36, 4),
			dataSize: view.getUint32(40, true),
			length: wav.length,
			lastSample: view.getInt16(48, true),
		}, {
			riff: 'RIFF',
			riffSize: 42,
			wave: 'WAVE',
			fmt: 'fmt ',
			format: 1,
			channels: 1,
			sampleRate: 16000,
			byteRate: 32000,
			bits: 16,
			data: 'data',
			dataSize: 6,
			length: 50,
			lastSample: 300,
		});
	});

	test('isSilentPcm16 skips taps and silence but keeps speech', () => {
		const loud = pcm16(Array.from({ length: 8000 }, (_, i) => (i % 2 ? 6000 : -6000)));
		const quiet = pcm16(Array.from({ length: 8000 }, () => 3));
		assert.deepStrictEqual({
			tooShort: isSilentPcm16(pcm16([9000, -9000, 9000])),
			quiet: isSilentPcm16(quiet),
			loud: isSilentPcm16(loud),
		}, { tooShort: true, quiet: true, loud: false });
	});

	test('toIsoLanguageCode keeps only the language subtag', () => {
		assert.deepStrictEqual(
			[toIsoLanguageCode('pt-BR'), toIsoLanguageCode('en-US'), toIsoLanguageCode('auto'), toIsoLanguageCode(undefined)],
			['pt', 'en', undefined, undefined],
		);
	});

	test('parseGeminiTranscript joins the text parts of the first candidate', () => {
		assert.deepStrictEqual(
			[
				parseGeminiTranscript({ candidates: [{ content: { parts: [{ text: ' Olá, ' }, { text: 'mundo. ' }] } }] }),
				parseGeminiTranscript({}),
			],
			['Olá, mundo.', ''],
		);
	});

	test('the nova-cloud model selects the nova backend on desktop only', () => {
		assert.deepStrictEqual(
			[
				resolveDictationBackend(DICTATION_NOVA_CLOUD_MODEL_ID, undefined, false),
				resolveDictationBackend(DICTATION_NOVA_CLOUD_MODEL_ID, undefined, true),
				resolveDictationBackend('mai', undefined, false),
				resolveDictationBackend(undefined, undefined, false),
			],
			['nova', 'mai', 'mai', 'nemo'],
		);
	});
});
