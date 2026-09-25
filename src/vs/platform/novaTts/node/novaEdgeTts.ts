/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Edge TTS Neural: the neural voices of the Microsoft Edge "Read Aloud" service. No key and no
 *  account. It is not an official API, so the protocol can change; the values below follow the
 *  open source `edge-tts` project (rany2/edge-tts). Runs in the Node side and always returns a
 *  whole MP3 file, like the other cloud providers.
 *-------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID } from 'crypto';
import { encodeNovaTtsError, INovaTtsAudio, INovaTtsRequest } from '../common/novaTts.js';
import { escapeXml, percentRate } from './novaCloudTts.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

export const EDGE_WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const EDGE_VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

const REQUEST_TIMEOUT_MS = 30_000;
const WINDOWS_EPOCH_SECONDS = 11_644_473_600;

/** Voice names look like `pt-BR-FranciscaNeural`; anything else must not reach the SSML. */
const VOICE_PATTERN = /^[A-Za-z0-9-]{3,80}$/;

/** The token depends on the clock. The server date of a rejected request corrects a wrong system clock. */
let clockSkewSeconds = 0;

/** Token that proves the request comes from an Edge-like client: SHA-256 of the 5-minute-rounded Windows file time plus the client token. Exported for tests. */
export function generateSecMsGec(nowMs: number): string {
	let seconds = Math.floor(nowMs / 1000) + WINDOWS_EPOCH_SECONDS;
	seconds -= seconds % 300;
	const ticks = BigInt(seconds) * 10_000_000n;
	return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function currentGec(): string {
	return generateSecMsGec(Date.now() + clockSkewSeconds * 1000);
}

/** The service refuses some control characters (mostly the vertical tab of copied PDFs). */
function removeIncompatibleCharacters(text: string): string {
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

/** Builds the SSML the service expects. Exported for tests. */
export function buildEdgeSsml(request: Pick<INovaTtsRequest, 'text' | 'voice' | 'speed'>): string {
	if (!VOICE_PATTERN.test(request.voice)) {
		throw encodeNovaTtsError('other', `Invalid Edge voice: ${request.voice}`);
	}
	const text = escapeXml(removeIncompatibleCharacters(request.text));
	return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${request.voice}'><prosody pitch='+0Hz' rate='${percentRate(request.speed)}' volume='+0%'>${text}</prosody></voice></speak>`;
}

/** Javascript-style date the service expects in its message headers. */
function messageTimestamp(): string {
	return new Date().toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) ([\d:]{8}) GMT$/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');
}

/** Splits a binary frame into its `Path` header and audio bytes. Returns undefined for a frame that is not audio. */
export function parseEdgeAudioFrame(frame: Buffer): Buffer | undefined {
	if (frame.length < 2) {
		return undefined;
	}
	const headerLength = frame.readUInt16BE(0);
	if (frame.length < 2 + headerLength) {
		return undefined;
	}
	const headers = frame.toString('utf8', 2, 2 + headerLength);
	if (!/(^|\r\n)Path:audio(\r\n|$)/.test(headers)) {
		return undefined;
	}
	return frame.subarray(2 + headerLength);
}

class EdgeAuthError extends Error {
	constructor(readonly serverDate: string | undefined) {
		super('HTTP 403');
	}
}

async function synthesizeOnce(request: INovaTtsRequest, baseUrl: string): Promise<INovaTtsAudio> {
	const ssml = buildEdgeSsml(request);
	const WS = await import('ws');
	const url = `${baseUrl}&ConnectionId=${randomUUID().replace(/-/g, '')}&Sec-MS-GEC=${currentGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

	return new Promise<INovaTtsAudio>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let settled = false;
		const socket = new WS.WebSocket(url, {
			headers: {
				'Pragma': 'no-cache',
				'Cache-Control': 'no-cache',
				'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
				'User-Agent': USER_AGENT,
				'Accept-Language': 'en-US,en;q=0.9',
				'Cookie': `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
			},
		});
		const finish = (error?: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.terminate();
			if (error) {
				reject(error);
			} else if (!chunks.length) {
				reject(encodeNovaTtsError('other', 'The provider returned no audio.'));
			} else {
				resolve({ audioBase64: Buffer.concat(chunks).toString('base64') });
			}
		};
		const timer = setTimeout(() => finish(encodeNovaTtsError('network', 'Edge TTS took too long to answer.')), REQUEST_TIMEOUT_MS);

		socket.on('open', () => {
			socket.send(`X-Timestamp:${messageTimestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
			socket.send(`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${messageTimestamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
		});
		socket.on('message', (data, isBinary) => {
			if (isBinary) {
				const audio = parseEdgeAudioFrame(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data)));
				if (audio?.length) {
					chunks.push(audio);
				}
			} else if (/(^|\r\n)Path:turn\.end(\r\n|$)/.test(data.toString())) {
				finish();
			}
		});
		socket.on('unexpected-response', (_req, response) => {
			response.resume();
			const status = response.statusCode ?? 0;
			if (status === 403) {
				finish(new EdgeAuthError(response.headers.date));
			} else {
				finish(encodeNovaTtsError(status === 429 ? 'rateLimit' : 'other', `HTTP ${status}`));
			}
		});
		socket.on('error', err => finish(encodeNovaTtsError('network', err.message)));
		socket.on('close', () => finish(encodeNovaTtsError('network', 'The connection closed before the audio was complete.')));
	});
}

/** Turns text into MP3 audio with an Edge neural voice. Retries once when the server date shows the system clock is wrong. */
export async function edgeSynthesize(request: INovaTtsRequest, baseUrl: string = EDGE_WSS_URL): Promise<INovaTtsAudio> {
	try {
		return await synthesizeOnce(request, baseUrl);
	} catch (err) {
		if (!(err instanceof EdgeAuthError)) {
			throw err;
		}
		const serverTime = err.serverDate ? Date.parse(err.serverDate) : NaN;
		if (Number.isNaN(serverTime)) {
			throw encodeNovaTtsError('auth', 'Edge TTS refused the request. Check the date and time of this computer.');
		}
		clockSkewSeconds += (serverTime - (Date.now() + clockSkewSeconds * 1000)) / 1000;
		try {
			return await synthesizeOnce(request, baseUrl);
		} catch (retryErr) {
			throw retryErr instanceof EdgeAuthError ? encodeNovaTtsError('auth', 'Edge TTS refused the request. Check the date and time of this computer.') : retryErr;
		}
	}
}

export interface INovaEdgeVoice {
	readonly shortName: string;
	readonly gender: string;
	readonly locale: string;
}

/** Lists the voices of a locale (for example `pt-BR`). Throws a network error when the service cannot be reached. */
export async function edgeListVoices(locale: string): Promise<INovaEdgeVoice[]> {
	let response: Response;
	try {
		response = await fetch(`${EDGE_VOICE_LIST_URL}&Sec-MS-GEC=${currentGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`, {
			headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		throw encodeNovaTtsError('network', err instanceof Error ? err.message : String(err));
	}
	if (!response.ok) {
		throw encodeNovaTtsError(response.status === 403 ? 'auth' : 'other', `HTTP ${response.status}`);
	}
	const voices = await response.json() as { ShortName?: string; Gender?: string; Locale?: string }[];
	return voices
		.filter(voice => voice.ShortName && voice.Locale === locale && VOICE_PATTERN.test(voice.ShortName))
		.map(voice => ({ shortName: voice.ShortName!, gender: voice.Gender ?? '', locale }));
}
