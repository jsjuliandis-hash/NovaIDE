/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Read Aloud and automatic speech for chat answers. The default voice is Piper (local, offline,
 *  downloaded on first use); Azure, Google, ElevenLabs and Amazon Polly work with the user's own key.
 *-------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { raceCancellation } from '../../../../../base/common/async.js';
import { toAction } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { INovaTtsCredentials, INovaTtsService, NOVA_GOOGLE_VOICES, NOVA_PIPER_VOICES, NOVA_TTS_DEFAULT_VOICES, NOVA_TTS_PROVIDERS, NovaTtsProviderId, decodeNovaTtsError, novaGoogleVoiceId } from '../../../../../platform/novaTts/common/novaTts.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { isUntitledChatSession } from '../../common/model/chatUri.js';
import { ITextToSpeechEvent, ITextToSpeechSession, TextToSpeechInProgress, TextToSpeechStatus } from '../../../speech/common/speechService.js';

/** True in a chat widget whose current tab reads new answers aloud automatically. */
export const NovaAutoSpeakOn = new RawContextKey<boolean>('nova.tts.autoSpeakOn', false, { type: 'boolean', description: localize('nova.tts.autoSpeakOnKey', "True when the current chat tab reads new answers aloud automatically.") });

/** Command that opens the voice setup box (provider, voice and key). */
export const CONFIGURE_NOVA_TTS_COMMAND_ID = 'nova.tts.configure';

export const enum NovaTtsSettingId {
	Provider = 'nova.tts.provider',
	AutoSpeak = 'nova.tts.autoSpeak',
	Speed = 'nova.tts.speed',
	Language = 'nova.tts.language',
	AzureRegion = 'nova.tts.azure.region',
	AmazonRegion = 'nova.tts.amazon.region',
}

export function novaTtsVoiceSettingId(provider: NovaTtsProviderId): string {
	return `nova.tts.${provider}.voice`;
}

const SECRET_API_KEY = (provider: NovaTtsProviderId) => `nova.tts.${provider}.apiKey`;
const SECRET_AMAZON_SECRET = 'nova.tts.amazon.secretKey';

const AUTO_SPEAK_STORAGE_KEY = 'nova.tts.autoSpeakSessions';
const MAX_AUTO_SPEAK_ENTRIES = 300;

/** Longest text sent in one request. Piper starts a process per request, so it wants fewer, larger pieces than a cloud API wants. */
const MAX_PIECE_CHARS: Record<NovaTtsProviderId, number> = { piper: 700, azure: 2500, google: 2000, elevenlabs: 2500, amazon: 2500 };

export const INovaTextToSpeechService = createDecorator<INovaTextToSpeechService>('novaTextToSpeechService');

export interface INovaTextToSpeechSession extends ITextToSpeechSession {
	/** No more text will come: the session stops once the audio already queued has been played. */
	finish(): void;
}

export interface INovaTextToSpeechService {
	readonly _serviceBrand: undefined;

	readonly provider: NovaTtsProviderId;
	readonly providerLabel: string;

	createSession(token: CancellationToken): INovaTextToSpeechSession;

	/** Fires with the chat session (tab) whose automatic speech was switched on or off. */
	readonly onDidChangeAutoSpeak: Event<URI>;

	/** Whether new answers of this chat session (one chat tab) are read aloud automatically. */
	isAutoSpeakEnabled(sessionResource: URI): boolean;

	/** The user's choice for one chat session (one chat tab). It survives restarts. */
	setAutoSpeak(sessionResource: URI, enabled: boolean): void;

	/** Opens the setup box. Resolves to `true` when a provider was configured. */
	configure(): Promise<boolean>;
}

/** Symbols the voice must not read out: asterisks, slashes, backslashes and emojis (with their joiners, variation selectors and skin tones). */
const UNSPOKEN_SYMBOLS = /[*/\\]+|[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️⃣]+/gu;

/**
 * Cuts text into pieces of at most `max` characters, at sentence ends when possible, and drops
 * pieces that have nothing to read (no letter or digit). Links are replaced by the word "link" and asterisks, slashes, backslashes and emojis are never read.
 */
export function splitForSynthesis(text: string, max: number): string[] {
	const clean = text.replace(/https?:\/\/\S+/g, 'link').replace(UNSPOKEN_SYMBOLS, ' ').replace(/[ \t]+/g, ' ');
	const sentences = clean.match(/[^.!?\n]+[.!?]*\n*|\n+/g) ?? [clean];
	const pieces: string[] = [];
	let current = '';
	const flush = () => {
		if (current.trim()) {
			pieces.push(current.trim());
		}
		current = '';
	};
	for (const sentence of sentences) {
		if (current.length + sentence.length > max) {
			flush();
		}
		if (sentence.length > max) {
			for (let i = 0; i < sentence.length; i += max) {
				current = sentence.slice(i, i + max);
				flush();
			}
			continue;
		}
		current += sentence;
	}
	flush();
	return pieces.filter(piece => /[\p{L}\p{N}]/u.test(piece));
}

//#region Player

/** Plays whole audio files (WAV or MP3) one after the other, at the sample rate of each file. */
class NovaAudioPlayer extends Disposable {

	private readonly _onDidBecomeIdle = this._register(new Emitter<void>());
	readonly onDidBecomeIdle = this._onDidBecomeIdle.event;

	private _context: AudioContext | undefined;
	private _nextStart = 0;
	private _pending = 0;
	private _stopped = false;
	private readonly _sources = new Set<AudioBufferSourceNode>();

	get isBusy(): boolean {
		return this._pending > 0;
	}

	async enqueue(audioBase64: string): Promise<void> {
		this._context ??= new mainWindow.AudioContext();
		const context = this._context;
		if (context.state === 'suspended') {
			context.resume().catch(() => { /* best effort */ });
		}
		const bytes = decodeBase64(audioBase64).buffer;
		const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

		this._pending++;
		let decoded: AudioBuffer;
		try {
			decoded = await context.decodeAudioData(data);
		} catch (err) {
			this._pending--;
			throw err;
		}
		if (this._stopped) {
			this._pending--;
			return;
		}

		const source = context.createBufferSource();
		source.buffer = decoded;
		source.connect(context.destination);
		const start = Math.max(context.currentTime + 0.02, this._nextStart);
		source.start(start);
		this._nextStart = start + decoded.duration;
		this._sources.add(source);
		source.onended = () => {
			this._sources.delete(source);
			this._pending--;
			if (!this._stopped && !this.isBusy) {
				this._onDidBecomeIdle.fire();
			}
		};
	}

	stop(): void {
		this._stopped = true;
		for (const source of this._sources) {
			source.onended = null;
			try { source.stop(); } catch { /* not started yet */ }
		}
		this._sources.clear();
		this._pending = 0;
	}

	override dispose(): void {
		this.stop();
		this._context?.close().catch(() => { /* already closed */ });
		this._context = undefined;
		super.dispose();
	}
}

//#endregion

//#region Session

class NovaTextToSpeechSession extends Disposable implements INovaTextToSpeechSession {

	private readonly _onDidChange = this._register(new Emitter<ITextToSpeechEvent>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _player = this._register(new NovaAudioPlayer());
	private _started = false;
	private _finished = false;
	private _ended = false;
	private _busy = 0;
	private _floor: Promise<(() => void) | undefined> | undefined;
	private _releaseFloor: (() => void) | undefined;

	constructor(
		private readonly _token: CancellationToken,
		private readonly _acquireFloor: (token: CancellationToken) => Promise<(() => void) | undefined>,
		private readonly _synthesizePiece: (text: string) => Promise<string>,
		private readonly _maxPieceChars: number,
		private readonly _onError: (error: unknown) => void,
	) {
		super();
		this._register(this._token.onCancellationRequested(() => this._end()));
		this._register(this._player.onDidBecomeIdle(() => this._endIfDone()));
	}

	async synthesize(text: string): Promise<void> {
		this._busy++;
		try {
			// Shown as "speaking" right away, so the tab offers Stop even while it waits for its turn.
			if (!this._started) {
				this._started = true;
				this._onDidChange.fire({ status: TextToSpeechStatus.Started });
			}

			// Only one tab speaks at a time. The others wait for their turn instead of talking over it.
			this._floor ??= this._acquireFloor(this._token).then(release => {
				this._releaseFloor = release;
				if (this._ended) {
					release?.();
				}
				return release;
			});
			if (!await this._floor) {
				return;
			}

			for (const piece of splitForSynthesis(text, this._maxPieceChars)) {
				if (this._ended) {
					return;
				}
				const audio = await this._synthesizePiece(piece);
				if (this._ended) {
					return;
				}
				await this._player.enqueue(audio);
			}
		} catch (err) {
			if (!this._ended) {
				this._onError(err);
				this._onDidChange.fire({ status: TextToSpeechStatus.Error, text: err instanceof Error ? err.message : String(err) });
				this._end();
			}
		} finally {
			this._busy--;
		}
	}

	finish(): void {
		this._finished = true;
		this._endIfDone();
	}

	private _endIfDone(): void {
		if (this._finished && !this._busy && !this._player.isBusy) {
			this._end();
		}
	}

	private _end(): void {
		if (this._ended) {
			return;
		}
		this._ended = true;
		this._releaseFloor?.();
		this._player.stop();
		this._onDidChange.fire({ status: TextToSpeechStatus.Stopped });
	}

	override dispose(): void {
		this._end();
		super.dispose();
	}
}

//#endregion

//#region Service

interface IProviderPickItem extends IQuickPickItem {
	readonly id: NovaTtsProviderId;
}

export class NovaTextToSpeechService extends Disposable implements INovaTextToSpeechService {

	declare readonly _serviceBrand: undefined;

	/** Guards against two setup boxes opening at once. */
	private _setup: Promise<boolean> | undefined;

	private _sessions = 0;
	private readonly _inProgress: IContextKey<boolean>;

	/** Tail of the queue of tabs waiting to speak. */
	private _floorTail: Promise<void> = Promise.resolve();

	private readonly _onDidChangeAutoSpeak = this._register(new Emitter<URI>());
	readonly onDidChangeAutoSpeak = this._onDidChangeAutoSpeak.event;

	/** Per chat session choice, by session resource. Sessions without a choice follow `nova.tts.autoSpeak`. */
	private readonly _autoSpeak: Map<string, boolean>;

	constructor(
		@INovaTtsService private readonly _tts: INovaTtsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IProgressService private readonly _progressService: IProgressService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly _storageService: IStorageService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._inProgress = TextToSpeechInProgress.bindTo(contextKeyService);
		this._autoSpeak = this._loadAutoSpeak();

		// A new tab starts as an untitled session and becomes the real session on the first message.
		// The tab is the same one, so its choice has to follow.
		this._register(this._chatSessionsService.onDidCommitSession(e => this._moveAutoSpeak(e.original, e.committed)));
	}

	private _moveAutoSpeak(from: URI, to: URI): void {
		const choice = this._autoSpeak.get(from.toString());
		if (choice === undefined) {
			return;
		}
		this._autoSpeak.delete(from.toString());
		this.setAutoSpeak(to, choice);
	}

	private _loadAutoSpeak(): Map<string, boolean> {
		try {
			const stored = JSON.parse(this._storageService.get(AUTO_SPEAK_STORAGE_KEY, StorageScope.PROFILE, '[]')) as [string, boolean][];
			return new Map(stored);
		} catch {
			return new Map();
		}
	}

	isAutoSpeakEnabled(sessionResource: URI): boolean {
		return this._autoSpeak.get(sessionResource.toString())
			?? this._choiceOfUntitledSession(sessionResource)
			?? !!this._configurationService.getValue<boolean>(NovaTtsSettingId.AutoSpeak);
	}

	/**
	 * A new tab is an untitled session until its first message, and the choice was made on the untitled
	 * session. The link "untitled → real" only lives while the session is open (and the commit event
	 * only exists for sessions of extensions), so the choice moves to the real session the first time
	 * it is looked up, which is while sending the first message.
	 */
	private _choiceOfUntitledSession(sessionResource: URI): boolean | undefined {
		for (const [key, choice] of this._autoSpeak) {
			const untitled = URI.parse(key);
			if (isUntitledChatSession(untitled) && isEqual(this._chatSessionsService.getMaterializedSessionResource(untitled), sessionResource)) {
				this._autoSpeak.delete(key);
				this._autoSpeak.set(sessionResource.toString(), choice);
				this._saveAutoSpeak();
				return choice;
			}
		}
		return undefined;
	}

	private _saveAutoSpeak(): void {
		this._storageService.store(AUTO_SPEAK_STORAGE_KEY, JSON.stringify([...this._autoSpeak]), StorageScope.PROFILE, StorageTarget.USER);
	}

	setAutoSpeak(sessionResource: URI, enabled: boolean): void {
		const key = sessionResource.toString();
		this._autoSpeak.delete(key); // re-inserted last, so the oldest choices are the ones dropped
		this._autoSpeak.set(key, enabled);
		while (this._autoSpeak.size > MAX_AUTO_SPEAK_ENTRIES) {
			this._autoSpeak.delete(this._autoSpeak.keys().next().value!);
		}
		this._saveAutoSpeak();
		this._onDidChangeAutoSpeak.fire(sessionResource);
	}

	/**
	 * Waits for this session's turn to speak. Resolves with the function that gives the turn up, or
	 * `undefined` when `token` was cancelled while waiting.
	 */
	private async _acquireFloor(token: CancellationToken): Promise<(() => void) | undefined> {
		let release!: () => void;
		const turn = new Promise<void>(resolve => release = resolve);
		const previous = this._floorTail;
		this._floorTail = previous.then(() => turn);
		await raceCancellation(previous, token);
		if (token.isCancellationRequested) {
			release();
			return undefined;
		}
		return release;
	}

	get provider(): NovaTtsProviderId {
		const value = this._configurationService.getValue<string>(NovaTtsSettingId.Provider);
		return (NOVA_TTS_PROVIDERS as readonly string[]).includes(value) ? value as NovaTtsProviderId : 'piper';
	}

	get providerLabel(): string {
		return providerLabel(this.provider);
	}

	private _voice(provider: NovaTtsProviderId): string {
		return this._configurationService.getValue<string>(novaTtsVoiceSettingId(provider)) || NOVA_TTS_DEFAULT_VOICES[provider];
	}

	createSession(token: CancellationToken): INovaTextToSpeechSession {
		const provider = this.provider;
		const disposables = new DisposableStore();
		this._sessions++;
		this._inProgress.set(true);
		const session = new NovaTextToSpeechSession(
			token,
			floorToken => this._acquireFloor(floorToken),
			text => this._synthesizePiece(provider, text),
			MAX_PIECE_CHARS[provider],
			error => this._reportError(error),
		);
		disposables.add(session.onDidChange(e => {
			if (e.status === TextToSpeechStatus.Stopped) {
				this._sessions = Math.max(0, this._sessions - 1);
				if (!this._sessions) {
					this._inProgress.reset();
				}
				// Dispose after the other listeners have seen `Stopped`; the player and its audio context go with the session.
				mainWindow.setTimeout(() => session.dispose(), 0);
				disposables.dispose();
			}
		}));
		return session;
	}

	private async _synthesizePiece(provider: NovaTtsProviderId, text: string): Promise<string> {
		const voice = this._voice(provider);
		if (provider === 'piper' && !await this._tts.isPiperReady(voice)) {
			await this._installPiper(voice);
		}
		const result = await this._tts.synthesize({
			provider,
			text,
			voice,
			speed: this._configurationService.getValue<number>(NovaTtsSettingId.Speed) || 1,
			language: this._configurationService.getValue<string>(NovaTtsSettingId.Language) || 'pt-BR',
			credentials: provider === 'piper' ? undefined : await this._credentials(provider),
		});
		return result.audioBase64;
	}

	private async _credentials(provider: NovaTtsProviderId): Promise<INovaTtsCredentials> {
		return {
			apiKey: await this._secretStorageService.get(SECRET_API_KEY(provider)),
			secretKey: provider === 'amazon' ? await this._secretStorageService.get(SECRET_AMAZON_SECRET) : undefined,
			region: provider === 'azure' ? this._configurationService.getValue<string>(NovaTtsSettingId.AzureRegion)
				: provider === 'amazon' ? this._configurationService.getValue<string>(NovaTtsSettingId.AmazonRegion)
					: undefined,
		};
	}

	private _installPiper(voice: string): Promise<void> {
		return this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('nova.tts.installing', "Downloading the local voice (Piper). This happens only once."),
		}, progress => {
			let last = 0;
			const listener = this._tts.onDidInstallProgress(e => {
				if (e.percent >= 0 && e.percent > last) {
					progress.report({ increment: e.percent - last });
					last = e.percent;
				}
			});
			return this._tts.installPiper(voice).finally(() => listener.dispose());
		});
	}

	private _reportError(error: unknown): void {
		const { kind, message } = decodeNovaTtsError(error);
		this._logService.warn('[nova-tts]', kind, message);
		const configure = toAction({ id: CONFIGURE_NOVA_TTS_COMMAND_ID, label: localize('nova.tts.configure', "Configure Voice"), run: () => this.configure() });
		switch (kind) {
			case 'auth':
				this._notificationService.notify({ severity: Severity.Error, message: localize('nova.tts.authError', "The voice provider rejected your key. Check the key and the region."), actions: { primary: [configure] } });
				break;
			case 'rateLimit':
				this._notificationService.notify({ severity: Severity.Warning, message: localize('nova.tts.rateLimit', "The voice provider's free limit was reached. Try again later or pick another voice."), actions: { primary: [configure] } });
				break;
			case 'network':
				this._notificationService.notify({ severity: Severity.Error, message: localize('nova.tts.networkError', "Could not reach the voice provider or download the local voice. Check your internet connection. ({0})", message), actions: { primary: [configure] } });
				break;
			case 'unsupported':
				this._notificationService.notify({ severity: Severity.Warning, message: localize('nova.tts.unsupported', "The local voice is not available on this system yet. Pick a cloud voice."), actions: { primary: [configure] } });
				break;
			default:
				this._notificationService.notify({ severity: Severity.Error, message: localize('nova.tts.error', "The voice could not read this text: {0}", message), actions: { primary: [configure] } });
		}
	}

	configure(): Promise<boolean> {
		this._setup ??= this._runSetup().finally(() => this._setup = undefined);
		return this._setup;
	}

	private async _runSetup(): Promise<boolean> {
		const current = this.provider;
		const currentLabel = localize('nova.tts.current', "current");
		const items: IProviderPickItem[] = [
			{ id: 'piper', label: localize('nova.tts.pickPiper', "Piper (local, offline, free)"), description: current === 'piper' ? currentLabel : localize('nova.tts.recommended', "recommended"), detail: localize('nova.tts.pickPiperDetail', "No key, no account, no limit. Downloads about 100 MB once. Windows only for now.") },
			{ id: 'azure', label: localize('nova.tts.pickAzure', "Microsoft Azure Speech"), description: current === 'azure' ? currentLabel : undefined, detail: localize('nova.tts.pickAzureDetail', "Your own key. Free plan: about 500,000 characters per month.") },
			{ id: 'google', label: localize('nova.tts.pickGoogle', "Google Cloud Text-to-Speech (Chirp 3 HD)"), description: current === 'google' ? currentLabel : undefined, detail: localize('nova.tts.pickGoogleDetail', "Your own API key from a Google Cloud project. Free plan: about 1 million characters per month.") },
			{ id: 'elevenlabs', label: localize('nova.tts.pickEleven', "ElevenLabs"), description: current === 'elevenlabs' ? currentLabel : undefined, detail: localize('nova.tts.pickElevenDetail', "Your own key. Very natural voices, but the free plan is small (about 10,000 characters per month).") },
			{ id: 'amazon', label: localize('nova.tts.pickAmazon', "Amazon Polly"), description: current === 'amazon' ? currentLabel : undefined, detail: localize('nova.tts.pickAmazonDetail', "Your own AWS access key and secret. Free plan for the first 12 months.") },
		];
		const picked = await this._quickInputService.pick(items, {
			title: localize('nova.tts.pickTitle', "Voice: Who Should Read Aloud?"),
			placeHolder: localize('nova.tts.pickPlaceholder', "Piper works on this computer. Cloud voices send the text to the provider."),
			ignoreFocusLost: true,
		});
		if (!picked) {
			return false;
		}

		const provider = picked.id;
		if (provider === 'piper') {
			return this._setupPiper();
		}
		return this._setupCloud(provider);
	}

	private async _setupPiper(): Promise<boolean> {
		const currentVoice = this._voice('piper');
		const voice = await this._quickInputService.pick(NOVA_PIPER_VOICES.map(id => ({ id, label: id.replace('pt_BR-', '').replace('-medium', ''), description: id === currentVoice ? localize('nova.tts.current', "current") : undefined })), {
			title: localize('nova.tts.voiceTitle', "Piper Voice"),
			ignoreFocusLost: true,
		});
		if (!voice) {
			return false;
		}
		try {
			if (!await this._tts.isPiperReady(voice.id)) {
				await this._installPiper(voice.id);
			}
		} catch (err) {
			this._reportError(err);
			return false;
		}
		await this._configurationService.updateValue(novaTtsVoiceSettingId('piper'), voice.id, ConfigurationTarget.USER);
		await this._configurationService.updateValue(NovaTtsSettingId.Provider, 'piper', ConfigurationTarget.USER);
		this._notificationService.info(localize('nova.tts.savedPiper', "The voice is now Piper (local)."));
		return true;
	}

	private async _setupCloud(provider: NovaTtsProviderId): Promise<boolean> {
		const label = providerLabel(provider);
		const existing = await this._credentials(provider);
		let errorMessage: string | undefined;

		for (; ;) {
			const apiKey = await this._ask({
				title: provider === 'amazon' ? localize('nova.tts.awsAccessTitle', "{0}: AWS Access Key ID", label) : localize('nova.tts.keyTitle', "{0}: API Key", label),
				prompt: errorMessage ?? localize('nova.tts.keyPrompt', "Paste the key. It is stored in the system's secret storage, never in settings."),
				password: true,
				existing: existing.apiKey,
			});
			if (apiKey === undefined) {
				return false;
			}

			let secretKey = existing.secretKey;
			if (provider === 'amazon') {
				const entered = await this._ask({ title: localize('nova.tts.awsSecretTitle', "{0}: AWS Secret Access Key", label), prompt: localize('nova.tts.keyPrompt', "Paste the key. It is stored in the system's secret storage, never in settings."), password: true, existing: existing.secretKey });
				if (entered === undefined) {
					return false;
				}
				secretKey = entered;
			}

			let region = existing.region;
			if (provider === 'azure' || provider === 'amazon') {
				const entered = await this._ask({
					title: localize('nova.tts.regionTitle', "{0}: Region", label),
					prompt: provider === 'azure' ? localize('nova.tts.azureRegionPrompt', "Region of your Speech resource, for example brazilsouth.") : localize('nova.tts.awsRegionPrompt', "AWS region, for example us-east-1."),
					existing: region || (provider === 'azure' ? 'brazilsouth' : 'us-east-1'),
					password: false,
					allowEmpty: true,
				});
				if (entered === undefined) {
					return false;
				}
				region = entered;
			}

			try {
				await this._tts.verifyCredentials(provider, { apiKey, secretKey, region });
			} catch (err) {
				const { kind } = decodeNovaTtsError(err);
				errorMessage = kind === 'auth'
					? localize('nova.tts.keyInvalid', "That key or region was rejected by the provider. Check it and paste it again.")
					: localize('nova.tts.keyNetwork', "Could not check the key with the provider. Check your internet connection and try again.");
				continue;
			}

			await this._secretStorageService.set(SECRET_API_KEY(provider), apiKey);
			if (provider === 'amazon' && secretKey) {
				await this._secretStorageService.set(SECRET_AMAZON_SECRET, secretKey);
			}
			if (provider === 'azure' && region) {
				await this._configurationService.updateValue(NovaTtsSettingId.AzureRegion, region, ConfigurationTarget.USER);
			}
			if (provider === 'amazon' && region) {
				await this._configurationService.updateValue(NovaTtsSettingId.AmazonRegion, region, ConfigurationTarget.USER);
			}
			if (provider === 'google') {
				const currentVoice = this._voice('google');
				const female = localize('nova.tts.voiceFemale', "female");
				const male = localize('nova.tts.voiceMale', "male");
				const voice = await this._quickInputService.pick(NOVA_GOOGLE_VOICES.map(v => ({ id: novaGoogleVoiceId(v.name), label: v.name, description: novaGoogleVoiceId(v.name) === currentVoice ? localize('nova.tts.current', "current") : undefined, detail: v.female ? female : male })), {
					title: localize('nova.tts.googleVoiceTitle', "Google Voice (Chirp 3 HD)"),
					ignoreFocusLost: true,
				});
				if (voice) {
					await this._configurationService.updateValue(novaTtsVoiceSettingId('google'), voice.id, ConfigurationTarget.USER);
				}
			}
			await this._configurationService.updateValue(NovaTtsSettingId.Provider, provider, ConfigurationTarget.USER);
			this._notificationService.info(localize('nova.tts.saved', "The voice is now {0}.", label));
			return true;
		}
	}

	/** Input box that keeps the saved value when left empty (secrets) or offers it as the default (plain text). */
	private async _ask(options: { title: string; prompt: string; password: boolean; existing: string | undefined; allowEmpty?: boolean }): Promise<string | undefined> {
		const entered = await this._quickInputService.input({
			title: options.title,
			prompt: options.prompt,
			value: options.password ? undefined : options.existing,
			placeHolder: options.password && options.existing ? localize('nova.tts.keyKeep', "Leave empty to keep the saved value") : undefined,
			password: options.password,
			ignoreFocusLost: true,
			validateInput: async value => (!value.trim() && !options.existing && !options.allowEmpty) ? localize('nova.tts.required', "This value is required.") : undefined,
		});
		if (entered === undefined) {
			return undefined;
		}
		return entered.trim() || options.existing || '';
	}
}

function providerLabel(provider: NovaTtsProviderId): string {
	switch (provider) {
		case 'piper': return localize('nova.tts.labelPiper', "Piper (local)");
		case 'azure': return localize('nova.tts.labelAzure', "Azure Speech");
		case 'google': return localize('nova.tts.labelGoogle', "Google Cloud");
		case 'elevenlabs': return localize('nova.tts.labelEleven', "ElevenLabs");
		case 'amazon': return localize('nova.tts.labelAmazon', "Amazon Polly");
	}
}

registerSingleton(INovaTextToSpeechService, NovaTextToSpeechService, InstantiationType.Delayed);

//#endregion
