/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Cloud dictation through the user's own API key (Groq Whisper or Google Gemini), so people
 *  without an NVIDIA GPU do not depend on the slow on-device model.
 *-------------------------------------------------------------------------------------------*/

import { VSBuffer, encodeBase64 } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { DEFAULT_LOCAL_TRANSCRIPTION_MODEL } from '../../../../../platform/localTranscription/common/localTranscription.js';

/** `dictation.model` value that routes dictation to the user's own cloud API key. */
export const DICTATION_NOVA_CLOUD_MODEL_ID = 'nova-cloud';

/** Command that opens the cloud dictation setup box (provider and API key). */
export const CONFIGURE_NOVA_DICTATION_COMMAND_ID = 'nova.dictation.configure';

export type NovaCloudProvider = 'groq' | 'google';

export const enum NovaDictationSettingId {
	Provider = 'nova.dictation.provider',
	GroqModel = 'nova.dictation.groq.model',
	GoogleModel = 'nova.dictation.google.model',
}

/** Sample rate (Hz) of the PCM16 audio produced by the dictation capture worklet. */
const PCM_SAMPLE_RATE = 16000;

/** Free-tier upload limits (bytes) with a little headroom. */
const MAX_UPLOAD_BYTES: Record<NovaCloudProvider, number> = {
	groq: 24 * 1024 * 1024,
	google: 19 * 1024 * 1024,
};

/** Recordings shorter than this are ignored (accidental taps). */
const MIN_AUDIO_MS = 300;

/** Peak amplitude (0..1) below which a recording is treated as silence, since Whisper invents text for silence. */
const SILENCE_PEAK = 0.004;

const REQUEST_TIMEOUT_MS = 60_000;

export type NovaCloudSetupResult = 'ready' | 'local' | 'cancelled';

export type NovaCloudErrorKind = 'auth' | 'rateLimit' | 'tooLarge' | 'network' | 'other';

export class NovaCloudTranscriptionError extends Error {
	constructor(readonly kind: NovaCloudErrorKind, message: string) {
		super(message);
	}
}

export const INovaCloudTranscriptionService = createDecorator<INovaCloudTranscriptionService>('novaCloudTranscriptionService');

export interface INovaCloudTranscriptionService {
	readonly _serviceBrand: undefined;

	/** Provider currently selected, or `undefined` before the first setup. */
	readonly provider: NovaCloudProvider | undefined;

	/** Short provider name for tooltips ("Groq Whisper", "Gemini"). */
	readonly providerLabel: string;

	/** Opens the setup box unless a provider and key are already stored. */
	ensureConfigured(): Promise<NovaCloudSetupResult>;

	/** Always opens the setup box: pick a provider and (re)enter its API key. */
	configure(): Promise<NovaCloudSetupResult>;

	/**
	 * Transcribes a complete recording.
	 * @param pcm16 Raw 16 kHz mono PCM16 (little endian) samples.
	 * @param language ISO 639-1 code (`pt`), or `undefined` to let the model detect it.
	 */
	transcribe(pcm16: Uint8Array, language: string | undefined, token: CancellationToken): Promise<string>;
}

// --- Pure helpers (unit tested) ---

/** Wraps raw PCM16 mono samples in a 44-byte RIFF/WAVE header. */
export function encodeWavPcm16(pcm16: Uint8Array, sampleRate = PCM_SAMPLE_RATE): Uint8Array {
	const wav = new Uint8Array(44 + pcm16.length);
	const view = new DataView(wav.buffer);
	const writeText = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	writeText(0, 'RIFF');
	view.setUint32(4, 36 + pcm16.length, true);
	writeText(8, 'WAVE');
	writeText(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeText(36, 'data');
	view.setUint32(40, pcm16.length, true);
	wav.set(pcm16, 44);
	return wav;
}

/** True when the recording is too short or too quiet to be worth sending. */
export function isSilentPcm16(pcm16: Uint8Array, sampleRate = PCM_SAMPLE_RATE): boolean {
	const samples = Math.floor(pcm16.length / 2);
	if (samples < sampleRate * MIN_AUDIO_MS / 1000) {
		return true;
	}
	const view = new DataView(pcm16.buffer, pcm16.byteOffset, samples * 2);
	let peak = 0;
	for (let i = 0; i < samples; i++) {
		peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)));
	}
	return peak / 0x8000 < SILENCE_PEAK;
}

/** `pt-BR` → `pt`; `auto` and unknown values → `undefined` (model detects the language). */
export function toIsoLanguageCode(language: string | undefined): string | undefined {
	const code = language?.split('-')[0].toLowerCase();
	return code && /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

/** Concatenates all text parts of the first Gemini candidate. */
export function parseGeminiTranscript(response: { candidates?: { content?: { parts?: { text?: string }[] } }[] }): string {
	const parts = response.candidates?.[0]?.content?.parts ?? [];
	return parts.map(part => part.text ?? '').join('').trim();
}

function geminiPrompt(language: string | undefined): string {
	const languageHint = language ? ` The speaker is speaking the language with ISO code "${language}".` : '';
	return `Transcribe this audio verbatim, with natural punctuation and capitalization.${languageHint} Reply with the transcription only: no comments, no quotes, no translation. If there is no speech, reply with an empty string.`;
}

const SECRET_KEYS: Record<NovaCloudProvider, string> = {
	groq: 'nova.dictation.groq.apiKey',
	google: 'nova.dictation.google.apiKey',
};

const LOCAL_PICK_ID = 'local';

/** Shapes of the keys each provider hands out, to recognise a key pasted into the provider list. */
const PASTED_KEY_PATTERNS: { readonly provider: NovaCloudProvider; readonly pattern: RegExp }[] = [
	{ provider: 'groq', pattern: /^gsk_[A-Za-z0-9]{48,}$/ },
	{ provider: 'google', pattern: /^AIza[\w-]{35,}$/ },
];

interface IProviderPickItem extends IQuickPickItem {
	readonly id: NovaCloudProvider | typeof LOCAL_PICK_ID;
}

export class NovaCloudTranscriptionService implements INovaCloudTranscriptionService {

	declare readonly _serviceBrand: undefined;

	/** Guards against two setup boxes opening at once (e.g. a double click on the mic). */
	private _setup: Promise<NovaCloudSetupResult> | undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	get provider(): NovaCloudProvider | undefined {
		const value = this._configurationService.getValue<string>(NovaDictationSettingId.Provider);
		return value === 'groq' || value === 'google' ? value : undefined;
	}

	get providerLabel(): string {
		switch (this.provider) {
			case 'groq': return localize('nova.dictation.groqLabel', "Groq Whisper");
			case 'google': return localize('nova.dictation.googleLabel', "Google Gemini");
			default: return localize('nova.dictation.cloudLabel', "Cloud");
		}
	}

	async ensureConfigured(): Promise<NovaCloudSetupResult> {
		const provider = this.provider;
		if (provider && await this._secretStorageService.get(SECRET_KEYS[provider])) {
			return 'ready';
		}
		return this.configure();
	}

	configure(): Promise<NovaCloudSetupResult> {
		this._setup ??= this._runSetup().finally(() => this._setup = undefined);
		return this._setup;
	}

	private async _runSetup(): Promise<NovaCloudSetupResult> {
		const current = this.provider;
		const currentLabel = localize('nova.dictation.current', "current");
		const freeLabel = localize('nova.dictation.free', "free");
		const items: IProviderPickItem[] = [
			{
				id: 'groq',
				label: localize('nova.dictation.pickGroq', "Groq — Whisper Large v3 Turbo"),
				description: current === 'groq' ? currentLabel : freeLabel,
				detail: localize('nova.dictation.pickGroqDetail', "Fastest and very accurate. Free API key at console.groq.com/keys"),
			},
			{
				id: 'google',
				label: localize('nova.dictation.pickGoogle', "Google — Gemini Flash"),
				description: current === 'google' ? currentLabel : freeLabel,
				detail: localize('nova.dictation.pickGoogleDetail', "Free API key at aistudio.google.com/apikey"),
			},
			{
				id: LOCAL_PICK_ID,
				label: localize('nova.dictation.pickLocal', "Local model (runs on this computer)"),
				detail: localize('nova.dictation.pickLocalDetail', "No API key. Slower without an NVIDIA GPU."),
			},
		];
		const choice = await this._pickProvider(items, current);
		if (!choice) {
			return 'cancelled';
		}
		const picked = choice.item;

		if (picked.id === LOCAL_PICK_ID) {
			await this._configurationService.updateValue('dictation.model', DEFAULT_LOCAL_TRANSCRIPTION_MODEL, ConfigurationTarget.USER);
			return 'local';
		}

		const provider = picked.id;
		const existingKey = await this._secretStorageService.get(SECRET_KEYS[provider]);
		let errorMessage: string | undefined;
		let pasted = choice.pastedKey;
		for (; ;) {
			// A key pasted straight into the provider list skips the key box the first time.
			const entered = pasted ?? await this._quickInputService.input({
				title: provider === 'groq'
					? localize('nova.dictation.keyTitleGroq', "Groq API Key")
					: localize('nova.dictation.keyTitleGoogle', "Google Gemini API Key"),
				prompt: errorMessage ?? (provider === 'groq'
					? localize('nova.dictation.keyPromptGroq', "Paste your key from console.groq.com/keys (starts with gsk_)")
					: localize('nova.dictation.keyPromptGoogle', "Paste your key from aistudio.google.com/apikey")),
				placeHolder: existingKey
					? localize('nova.dictation.keyKeep', "Leave empty to keep the saved key")
					: localize('nova.dictation.keyPlaceholder', "API key"),
				password: true,
				ignoreFocusLost: true,
				validateInput: async value => (!value.trim() && !existingKey) ? localize('nova.dictation.keyRequired', "Paste an API key to continue.") : undefined,
			});
			pasted = undefined;
			if (entered === undefined) {
				return 'cancelled';
			}
			const key = entered.trim() || existingKey;
			if (!key) {
				continue;
			}
			if (key !== existingKey) {
				const check = await this._verifyKey(provider, key);
				if (check) {
					errorMessage = check;
					continue;
				}
				await this._secretStorageService.set(SECRET_KEYS[provider], key);
			}
			break;
		}

		await this._configurationService.updateValue(NovaDictationSettingId.Provider, provider, ConfigurationTarget.USER);
		await this._configurationService.updateValue('dictation.model', DICTATION_NOVA_CLOUD_MODEL_ID, ConfigurationTarget.USER);
		this._notificationService.info(localize('nova.dictation.saved', "Dictation now uses {0}.", this.providerLabel));
		return 'ready';
	}

	/**
	 * Provider list. The items stay visible whatever is typed, and a key pasted into the filter box
	 * (`gsk_…` for Groq, `AIza…` for Google) picks its provider automatically.
	 */
	private _pickProvider(items: IProviderPickItem[], current: NovaCloudProvider | undefined): Promise<{ item: IProviderPickItem; pastedKey?: string } | undefined> {
		return new Promise(resolve => {
			const pick = this._quickInputService.createQuickPick<IProviderPickItem>();
			const disposables = new DisposableStore();
			disposables.add(pick);
			let settled = false;
			const finish = (result: { item: IProviderPickItem; pastedKey?: string } | undefined) => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
				disposables.dispose();
			};
			pick.title = localize('nova.dictation.pickTitle', "Dictation: How Should Your Voice Be Transcribed?");
			pick.placeholder = localize('nova.dictation.pickPlaceholder', "Pick a provider below, or paste your API key here. Your audio is sent to the provider, only while you dictate.");
			pick.ignoreFocusOut = true;
			pick.matchOnDescription = false;
			pick.items = items.map(item => ({ ...item, alwaysShow: true }));
			const active = pick.items.find(item => item.id === current);
			if (active) {
				pick.activeItems = [active];
			}
			disposables.add(pick.onDidChangeValue(value => {
				const key = value.trim();
				const pasted = PASTED_KEY_PATTERNS.find(candidate => candidate.pattern.test(key));
				if (pasted) {
					finish({ item: items.find(item => item.id === pasted.provider)!, pastedKey: key });
				}
			}));
			disposables.add(pick.onDidAccept(() => {
				const selected = pick.selectedItems[0];
				if (selected) {
					finish({ item: items.find(item => item.id === selected.id)! });
				}
			}));
			disposables.add(pick.onDidHide(() => finish(undefined)));
			pick.show();
		});
	}

	/** Cheap authenticated request; returns an error message, or `undefined` when the key works. */
	private async _verifyKey(provider: NovaCloudProvider, key: string): Promise<string | undefined> {
		try {
			const response = provider === 'groq'
				? await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } })
				: await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
			if (response.ok) {
				return undefined;
			}
			if (response.status === 400 || response.status === 401 || response.status === 403) {
				return localize('nova.dictation.keyInvalid', "That key was rejected by the provider. Check it and paste it again.");
			}
			return localize('nova.dictation.keyHttp', "The provider answered with an error ({0}). Try again.", response.status);
		} catch (err) {
			this._logService.warn('[nova-dictation] could not verify API key', err);
			return localize('nova.dictation.keyNetwork', "Could not reach the provider. Check your internet connection and try again.");
		}
	}

	async transcribe(pcm16: Uint8Array, language: string | undefined, token: CancellationToken): Promise<string> {
		const provider = this.provider;
		const key = provider ? await this._secretStorageService.get(SECRET_KEYS[provider]) : undefined;
		if (!provider || !key) {
			throw new NovaCloudTranscriptionError('auth', localize('nova.dictation.noKey', "No API key is set for cloud dictation."));
		}
		const wav = encodeWavPcm16(pcm16);
		if (wav.length > MAX_UPLOAD_BYTES[provider]) {
			throw new NovaCloudTranscriptionError('tooLarge', this._tooLargeMessage());
		}

		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
		const cancelListener = token.onCancellationRequested(() => abort.abort());
		try {
			return provider === 'groq'
				? await this._transcribeGroq(wav, key, language, abort.signal)
				: await this._transcribeGemini(wav, key, language, abort.signal);
		} catch (err) {
			if (err instanceof NovaCloudTranscriptionError) {
				throw err;
			}
			if (token.isCancellationRequested) {
				return '';
			}
			this._logService.warn('[nova-dictation] transcription request failed', err);
			throw new NovaCloudTranscriptionError('network', localize('nova.dictation.network', "Could not reach {0}. Check your internet connection.", this.providerLabel));
		} finally {
			clearTimeout(timer);
			cancelListener.dispose();
		}
	}

	private async _transcribeGroq(wav: Uint8Array, key: string, language: string | undefined, signal: AbortSignal): Promise<string> {
		const form = new FormData();
		form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
		form.append('model', this._configurationService.getValue<string>(NovaDictationSettingId.GroqModel) || 'whisper-large-v3-turbo');
		form.append('response_format', 'json');
		form.append('temperature', '0');
		if (language) {
			form.append('language', language);
		}
		const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}` },
			body: form,
			signal,
		});
		await this._throwIfFailed(response);
		const json: { text?: string } = await response.json();
		return (json.text ?? '').trim();
	}

	private async _transcribeGemini(wav: Uint8Array, key: string, language: string | undefined, signal: AbortSignal): Promise<string> {
		const model = this._configurationService.getValue<string>(NovaDictationSettingId.GoogleModel) || 'gemini-flash-latest';
		const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
			method: 'POST',
			headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				contents: [{
					parts: [
						{ text: geminiPrompt(language) },
						{ inline_data: { mime_type: 'audio/wav', data: encodeBase64(VSBuffer.wrap(wav)) } },
					],
				}],
				generationConfig: { temperature: 0 },
			}),
			signal,
		});
		await this._throwIfFailed(response);
		return parseGeminiTranscript(await response.json());
	}

	private _tooLargeMessage(): string {
		return localize('nova.dictation.tooLarge', "This recording is too long for the {0} free tier. Dictate in shorter parts.", this.providerLabel);
	}

	private async _throwIfFailed(response: Response): Promise<void> {
		if (response.ok) {
			return;
		}
		const body = (await response.text().catch(() => '')).slice(0, 300);
		this._logService.warn(`[nova-dictation] ${this.providerLabel} answered HTTP ${response.status}: ${body}`);
		// Gemini reports an invalid key as HTTP 400 (API_KEY_INVALID), Groq as 401.
		if (response.status === 401 || response.status === 403 || (response.status === 400 && /api[ _]key/i.test(body))) {
			throw new NovaCloudTranscriptionError('auth', localize('nova.dictation.authFailed', "{0} rejected the API key.", this.providerLabel));
		}
		switch (response.status) {
			case 413:
				throw new NovaCloudTranscriptionError('tooLarge', this._tooLargeMessage());
			case 429:
				throw new NovaCloudTranscriptionError('rateLimit', localize('nova.dictation.rateLimit', "{0} free-tier limit reached. Wait a moment and try again.", this.providerLabel));
			default:
				throw new NovaCloudTranscriptionError('other', localize('nova.dictation.httpError', "{0} returned an error ({1}).", this.providerLabel, response.status));
		}
	}
}

registerSingleton(INovaCloudTranscriptionService, NovaCloudTranscriptionService, InstantiationType.Delayed);
