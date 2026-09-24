/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Tests of the pieces of text to speech that need no network: WAV header, Amazon signature and
 *  the error that carries its kind through IPC.
 *-------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { decodeNovaTtsError, encodeNovaTtsError } from '../../common/novaTts.js';
import { signPollyRequest } from '../../node/novaCloudTts.js';
import { wrapPcmAsWav } from '../../node/novaWav.js';

suite('Nova text to speech', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('wraps raw PCM as a mono 16-bit WAV file', () => {
		const wav = wrapPcmAsWav(Buffer.from([1, 2, 3, 4]), 22050);
		assert.deepStrictEqual({
			riff: wav.toString('ascii', 0, 4),
			size: wav.readUInt32LE(4),
			wave: wav.toString('ascii', 8, 12),
			channels: wav.readUInt16LE(22),
			sampleRate: wav.readUInt32LE(24),
			byteRate: wav.readUInt32LE(28),
			bits: wav.readUInt16LE(34),
			dataSize: wav.readUInt32LE(40),
			total: wav.length,
		}, { riff: 'RIFF', size: 40, wave: 'WAVE', channels: 1, sampleRate: 22050, byteRate: 44100, bits: 16, dataSize: 4, total: 48 });
	});

	test('signs Amazon Polly requests with AWS Signature Version 4', () => {
		// The signature was computed with an independent implementation (Python hmac/hashlib).
		const signed = signPollyRequest({
			method: 'POST',
			region: 'us-east-1',
			path: '/v1/speech',
			query: '',
			body: '{"a":1}',
			contentType: 'application/json',
			accessKey: 'AKIDEXAMPLE',
			secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
			now: new Date('2026-09-24T16:30:00Z'),
		});
		assert.deepStrictEqual(signed, {
			url: 'https://polly.us-east-1.amazonaws.com/v1/speech',
			headers: {
				'x-amz-date': '20260924T163000Z',
				'Authorization': 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260924/us-east-1/polly/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=3e2f8c3597cbfba12834a0955d44b039eac3e2c0e43beb60b453f1f6ee425627',
				'Content-Type': 'application/json',
			},
		});
	});

	test('keeps the error kind through the IPC boundary', () => {
		assert.deepStrictEqual(
			[decodeNovaTtsError(encodeNovaTtsError('auth', 'HTTP 401')), decodeNovaTtsError(new Error('boom'))],
			[{ kind: 'auth', message: 'HTTP 401' }, { kind: 'other', message: 'boom' }]);
	});
});
