/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Tests of the pieces of text to speech that need no network: WAV header, Amazon signature and
 *  the error that carries its kind through IPC.
 *-------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { decodeNovaTtsError, encodeNovaTtsError } from '../../common/novaTts.js';
import { signPollyRequest } from '../../node/novaCloudTts.js';
import { buildEdgeSsml, edgeSynthesize, generateSecMsGec, parseEdgeAudioFrame } from '../../node/novaEdgeTts.js';
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

	test('generates the Edge Sec-MS-GEC token like the edge-tts project', () => {
		// The value was computed with edge_tts' own algorithm (Python) for 2026-09-25 12:34:56 UTC; any second inside the same 5 minutes gives the same token.
		const expected = '59006C024A1C521401FF75F31FCBBCD5B5C708FD641A6BCEAE1EC1F67F82296F';
		assert.deepStrictEqual(
			[generateSecMsGec(Date.UTC(2026, 8, 25, 12, 34, 56)), generateSecMsGec(Date.UTC(2026, 8, 25, 12, 30, 0)), generateSecMsGec(Date.UTC(2026, 8, 25, 12, 35, 0)) === expected],
			[expected, expected, false]);
	});

	test('builds the Edge SSML with escaped text, speed and a safe voice name', () => {
		assert.strictEqual(
			buildEdgeSsml({ text: 'a < b & c\u000B', voice: 'pt-BR-FranciscaNeural', speed: 1.25 }),
			`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='pt-BR-FranciscaNeural'><prosody pitch='+0Hz' rate='+25%' volume='+0%'>a &lt; b &amp; c </prosody></voice></speak>`);
		assert.throws(() => buildEdgeSsml({ text: 'x', voice: `a'><evil`, speed: 1 }), /Invalid Edge voice/);
	});

	test('reads the audio of Edge binary frames and ignores the others', () => {
		const frame = (headers: string, body: number[]) => {
			const head = Buffer.from(headers, 'utf8');
			const length = Buffer.alloc(2);
			length.writeUInt16BE(head.length);
			return Buffer.concat([length, head, Buffer.from(body)]);
		};
		assert.deepStrictEqual(
			[parseEdgeAudioFrame(frame('X-RequestId:1\r\nContent-Type:audio/mpeg\r\nPath:audio', [1, 2, 3]))?.toString('hex'), parseEdgeAudioFrame(frame('Path:response', [1])), parseEdgeAudioFrame(Buffer.from([0]))],
			['010203', undefined, undefined]);
	});

	test('collects the audio of an Edge answer until turn.end and reports a closed connection', async () => {
		const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
		const received: string[] = [];
		server.on('connection', socket => {
			socket.on('message', (data, isBinary) => {
				received.push(data.toString());
				if (received.length === 2 && !isBinary) {
					const head = Buffer.from('Path:audio', 'utf8');
					const length = Buffer.alloc(2);
					length.writeUInt16BE(head.length);
					socket.send(Buffer.concat([length, head, Buffer.from('ab')]), { binary: true });
					socket.send(Buffer.concat([length, head, Buffer.from('cd')]), { binary: true });
					socket.send('X-RequestId:1\r\nPath:turn.end\r\n\r\n{}');
				}
			});
		});
		try {
			await new Promise<void>(resolve => server.once('listening', resolve));
			const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/?TrustedClientToken=test`;
			const request = { provider: 'edge', text: 'Olá', voice: 'pt-BR-FranciscaNeural', speed: 1, language: 'pt-BR' } as const;
			const audio = await edgeSynthesize(request, base);
			assert.deepStrictEqual(
				{ audio: Buffer.from(audio.audioBase64, 'base64').toString(), config: received[0].includes('Path:speech.config') && received[0].includes('audio-24khz-48kbitrate-mono-mp3'), ssml: received[1].includes('Path:ssml') && received[1].includes('Olá') },
				{ audio: 'abcd', config: true, ssml: true });

			server.removeAllListeners('connection');
			server.on('connection', socket => socket.close());
			await assert.rejects(edgeSynthesize(request, base), (err: Error) => decodeNovaTtsError(err).kind === 'network');
		} finally {
			server.close();
		}
	});

	test('keeps the error kind through the IPC boundary', () => {
		assert.deepStrictEqual(
			[decodeNovaTtsError(encodeNovaTtsError('auth', 'HTTP 401')), decodeNovaTtsError(new Error('boom'))],
			[{ kind: 'auth', message: 'HTTP 401' }, { kind: 'other', message: 'boom' }]);
	});
});
