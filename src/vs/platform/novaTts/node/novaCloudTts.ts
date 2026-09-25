/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Cloud text to speech with the user's own key: Azure Speech, Google Cloud, ElevenLabs and
 *  Amazon Polly. Runs in the Node side (no CORS) and always returns a whole audio file.
 *-------------------------------------------------------------------------------------------*/

import { createHash, createHmac } from 'crypto';
import { encodeNovaTtsError, INovaTtsAudio, INovaTtsCredentials, INovaTtsRequest, NovaTtsErrorKind, NovaTtsProviderId } from '../common/novaTts.js';

const REQUEST_TIMEOUT_MS = 30_000;

/** Regions look like `brazilsouth` or `sa-east-1`; anything else must not reach a host name. */
const REGION_PATTERN = /^[a-z0-9-]{3,30}$/;

function toBase64(bytes: ArrayBuffer): string {
	return Buffer.from(bytes).toString('base64');
}

function errorKind(status: number): NovaTtsErrorKind {
	if (status === 401 || status === 403) {
		return 'auth';
	}
	if (status === 429) {
		return 'rateLimit';
	}
	return 'other';
}

async function send(url: string, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (err) {
		throw encodeNovaTtsError('network', err instanceof Error ? err.message : String(err));
	}
	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		throw encodeNovaTtsError(errorKind(response.status), `HTTP ${response.status} ${detail}`);
	}
	return response;
}

function requireRegion(credentials: INovaTtsCredentials): string {
	const region = credentials.region?.trim().toLowerCase();
	if (!region || !REGION_PATTERN.test(region)) {
		throw encodeNovaTtsError('auth', 'Invalid or missing region.');
	}
	return region;
}

function requireKey(credentials: INovaTtsCredentials): string {
	const key = credentials.apiKey?.trim();
	if (!key) {
		throw encodeNovaTtsError('auth', 'Missing API key.');
	}
	return key;
}

export function escapeXml(text: string): string {
	return text.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' })[c]!);
}

export function percentRate(speed: number): string {
	const percent = Math.round((speed - 1) * 100);
	return `${percent >= 0 ? '+' : ''}${percent}%`;
}

//#region Azure

async function azureSynthesize(request: INovaTtsRequest): Promise<INovaTtsAudio> {
	const credentials = request.credentials ?? {};
	const region = requireRegion(credentials);
	const ssml = `<speak version="1.0" xml:lang="${escapeXml(request.language)}"><voice name="${escapeXml(request.voice)}"><prosody rate="${percentRate(request.speed)}">${escapeXml(request.text)}</prosody></voice></speak>`;
	const response = await send(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': requireKey(credentials),
			'Content-Type': 'application/ssml+xml',
			'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
			'User-Agent': 'NovaIDE',
		},
		body: ssml,
	});
	return { audioBase64: toBase64(await response.arrayBuffer()) };
}

async function azureVerify(credentials: INovaTtsCredentials): Promise<void> {
	const region = requireRegion(credentials);
	await send(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`, {
		method: 'POST',
		headers: { 'Ocp-Apim-Subscription-Key': requireKey(credentials) },
	});
}

//#endregion

//#region Google

async function googleSynthesize(request: INovaTtsRequest): Promise<INovaTtsAudio> {
	const key = requireKey(request.credentials ?? {});
	const response = await send(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			input: { text: request.text },
			voice: { languageCode: request.language, name: request.voice },
			audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: Math.min(4, Math.max(0.25, request.speed)) },
		}),
	});
	const json = await response.json() as { audioContent?: string };
	if (!json.audioContent) {
		throw encodeNovaTtsError('other', 'The provider returned no audio.');
	}
	return { audioBase64: json.audioContent };
}

async function googleVerify(credentials: INovaTtsCredentials): Promise<void> {
	const key = requireKey(credentials);
	await send(`https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR&key=${encodeURIComponent(key)}`, { method: 'GET' });
}

//#endregion

//#region ElevenLabs

async function elevenLabsSynthesize(request: INovaTtsRequest): Promise<INovaTtsAudio> {
	const key = requireKey(request.credentials ?? {});
	const response = await send(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voice)}?output_format=mp3_44100_128`, {
		method: 'POST',
		headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
		body: JSON.stringify({
			text: request.text,
			model_id: 'eleven_multilingual_v2',
			voice_settings: { speed: Math.min(1.2, Math.max(0.7, request.speed)) },
		}),
	});
	return { audioBase64: toBase64(await response.arrayBuffer()) };
}

async function elevenLabsVerify(credentials: INovaTtsCredentials): Promise<void> {
	await send('https://api.elevenlabs.io/v1/voices?page_size=1', { method: 'GET', headers: { 'xi-api-key': requireKey(credentials) } });
}

//#endregion

//#region Amazon Polly (AWS Signature Version 4)

function sha256Hex(data: string): string {
	return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
	return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Signs a Polly request. Exported for tests. */
export function signPollyRequest(options: {
	readonly method: 'GET' | 'POST';
	readonly region: string;
	readonly path: string;
	readonly query: string;
	readonly body: string;
	readonly contentType?: string;
	readonly accessKey: string;
	readonly secretKey: string;
	readonly now: Date;
}): { readonly url: string; readonly headers: Record<string, string> } {
	const host = `polly.${options.region}.amazonaws.com`;
	const amzDate = options.now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260924T163000Z
	const date = amzDate.slice(0, 8);

	const headers: Record<string, string> = { host, 'x-amz-date': amzDate };
	if (options.contentType) {
		headers['content-type'] = options.contentType;
	}
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map(name => `${name}:${headers[name]}\n`).join('');
	const signedHeaders = names.join(';');
	const canonicalRequest = [options.method, options.path, options.query, canonicalHeaders, signedHeaders, sha256Hex(options.body)].join('\n');

	const scope = `${date}/${options.region}/polly/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.secretKey}`, date), options.region), 'polly'), 'aws4_request');
	const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

	const sent: Record<string, string> = {
		'x-amz-date': amzDate,
		'Authorization': `AWS4-HMAC-SHA256 Credential=${options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
	if (options.contentType) {
		sent['Content-Type'] = options.contentType;
	}
	return { url: `https://${host}${options.path}${options.query ? `?${options.query}` : ''}`, headers: sent };
}

function requireAwsKeys(credentials: INovaTtsCredentials): { accessKey: string; secretKey: string; region: string } {
	const secretKey = credentials.secretKey?.trim();
	if (!secretKey) {
		throw encodeNovaTtsError('auth', 'Missing AWS secret access key.');
	}
	return { accessKey: requireKey(credentials), secretKey, region: requireRegion(credentials) };
}

async function amazonSynthesize(request: INovaTtsRequest): Promise<INovaTtsAudio> {
	const aws = requireAwsKeys(request.credentials ?? {});
	const body = JSON.stringify({
		Engine: 'neural',
		OutputFormat: 'mp3',
		VoiceId: request.voice,
		LanguageCode: request.language,
		TextType: 'ssml',
		Text: `<speak><prosody rate="${Math.round(request.speed * 100)}%">${escapeXml(request.text)}</prosody></speak>`,
	});
	const signed = signPollyRequest({ method: 'POST', path: '/v1/speech', query: '', body, contentType: 'application/json', now: new Date(), ...aws });
	const response = await send(signed.url, { method: 'POST', headers: signed.headers, body });
	return { audioBase64: toBase64(await response.arrayBuffer()) };
}

async function amazonVerify(credentials: INovaTtsCredentials): Promise<void> {
	const aws = requireAwsKeys(credentials);
	const signed = signPollyRequest({ method: 'GET', path: '/v1/voices', query: 'LanguageCode=pt-BR', body: '', now: new Date(), ...aws });
	await send(signed.url, { method: 'GET', headers: signed.headers });
}

//#endregion

export function synthesizeInCloud(request: INovaTtsRequest): Promise<INovaTtsAudio> {
	switch (request.provider) {
		case 'azure': return azureSynthesize(request);
		case 'google': return googleSynthesize(request);
		case 'elevenlabs': return elevenLabsSynthesize(request);
		case 'amazon': return amazonSynthesize(request);
		default: throw encodeNovaTtsError('other', `Not a cloud provider: ${request.provider}`);
	}
}

export function verifyCloudCredentials(provider: NovaTtsProviderId, credentials: INovaTtsCredentials): Promise<void> {
	switch (provider) {
		case 'azure': return azureVerify(credentials);
		case 'google': return googleVerify(credentials);
		case 'elevenlabs': return elevenLabsVerify(credentials);
		case 'amazon': return amazonVerify(credentials);
		default: throw encodeNovaTtsError('other', `Not a cloud provider: ${provider}`);
	}
}
