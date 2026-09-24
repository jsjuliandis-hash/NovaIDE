/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Main-process side of text to speech. The default voice is Piper, a small offline program that
 *  is downloaded on first use into the user data folder (so the installer stays small). Cloud
 *  providers live in ../node/novaCloudTts.ts.
 *-------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { extract } from '../../../base/node/zip.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { encodeNovaTtsError, INovaTtsAudio, INovaTtsCredentials, INovaTtsInstallProgress, INovaTtsRequest, INovaTtsService, NOVA_PIPER_VOICES, NovaTtsProviderId } from '../common/novaTts.js';
import { synthesizeInCloud, verifyCloudCredentials } from '../node/novaCloudTts.js';
import { wrapPcmAsWav } from '../node/novaWav.js';

export const INovaTtsMainService = createDecorator<INovaTtsMainService>('novaTts');

export interface INovaTtsMainService extends INovaTtsService {
	readonly _serviceBrand: undefined;
}

interface IDownload {
	readonly url: string;
	readonly sha256: string;
}

/** Piper 2023.11.14-2 for Windows (the last release of the original project that ships binaries). */
const PIPER_WINDOWS: IDownload = {
	url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
	sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
};

const VOICES_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR';

const PIPER_VOICE_HASHES: Record<string, { readonly onnx: string; readonly json: string }> = {
	'pt_BR-faber-medium': {
		onnx: '858555e3a064209c57088fe6bd70c4c3dc54d03eaa00c45d5ecaf43a33f95aa7',
		json: '7e694de195ae3fc36dd732c445eb04fb49b649854893cb5506b978f0d50a1d6f',
	},
	'pt_BR-cadu-medium': {
		onnx: '765f0809a6ea9035d4a6d0d008dbf8876e68b2dd32029312672fa8f405bdb535',
		json: '5fe03aa3d4901880554905b12075713cd552598c8a350455a1ec73f8b4e6be19',
	},
	'pt_BR-jeff-medium': {
		onnx: '3a6f4c46355813c2b7bbc4d16b6d13d60ed72074b952a393baace82a7d0c94b5',
		json: '7bf8145b572b36806f5ce0f1d3322b6711975bc7d0473e8d36fced4a9ec0030d',
	},
};

/** A voice takes about 0.3 s to load; a sentence takes far less. This only guards against a stuck process. */
const PIPER_TIMEOUT_MS = 60_000;

export class NovaTtsMainService extends Disposable implements INovaTtsMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidInstallProgress = this._register(new Emitter<INovaTtsInstallProgress>());
	readonly onDidInstallProgress = this._onDidInstallProgress.event;

	private readonly _root: string;
	private _install: Promise<void> | undefined;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._root = join(environmentMainService.userDataPath, 'nova-tts');
	}

	//#region Piper files

	private get _piperExe(): string {
		return join(this._root, 'piper', 'piper.exe');
	}

	private _voicePath(voice: string, extension: 'onnx' | 'onnx.json'): string {
		return join(this._root, 'voices', `${voice}.${extension}`);
	}

	private _checkPiperPlatform(): void {
		if (process.platform !== 'win32') {
			throw encodeNovaTtsError('unsupported', 'The local Piper voice is only available on Windows for now. Pick a cloud voice in the settings.');
		}
	}

	private _checkVoice(voice: string): void {
		if (!(NOVA_PIPER_VOICES as readonly string[]).includes(voice)) {
			throw encodeNovaTtsError('other', `Unknown Piper voice: ${voice}`);
		}
	}

	private async _exists(path: string): Promise<boolean> {
		try {
			await fs.access(path);
			return true;
		} catch {
			return false;
		}
	}

	async isPiperReady(voice: string): Promise<boolean> {
		if (process.platform !== 'win32' || !(NOVA_PIPER_VOICES as readonly string[]).includes(voice)) {
			return false;
		}
		const checks = await Promise.all([this._piperExe, this._voicePath(voice, 'onnx'), this._voicePath(voice, 'onnx.json')].map(path => this._exists(path)));
		return checks.every(Boolean);
	}

	//#endregion

	//#region Download

	installPiper(voice: string): Promise<void> {
		this._checkPiperPlatform();
		this._checkVoice(voice);
		this._install ??= this._runInstall(voice).finally(() => this._install = undefined);
		return this._install;
	}

	private async _runInstall(voice: string): Promise<void> {
		try {
			await fs.mkdir(join(this._root, 'voices'), { recursive: true });

			if (!await this._exists(this._piperExe)) {
				const zip = join(this._root, 'piper.zip');
				await this._download(PIPER_WINDOWS, zip, 'piper');
				await extract(zip, join(this._root, 'piper'), { overwrite: true, sourcePath: 'piper' }, CancellationToken.None);
				await fs.rm(zip, { force: true });
			}

			const hashes = PIPER_VOICE_HASHES[voice];
			const name = voice.split('-')[1]; // pt_BR-faber-medium → faber
			const baseUrl = `${VOICES_BASE_URL}/${name}/medium/${voice}`;
			if (!await this._exists(this._voicePath(voice, 'onnx.json'))) {
				await this._download({ url: `${baseUrl}.onnx.json`, sha256: hashes.json }, this._voicePath(voice, 'onnx.json'), 'voice');
			}
			if (!await this._exists(this._voicePath(voice, 'onnx'))) {
				await this._download({ url: `${baseUrl}.onnx`, sha256: hashes.onnx }, this._voicePath(voice, 'onnx'), 'voice');
			}
		} catch (err) {
			this._logService.error('[nova-tts] Piper install failed', err);
			throw err instanceof Error && err.message.startsWith('NOVA_TTS:') ? err : encodeNovaTtsError('network', err instanceof Error ? err.message : String(err));
		}
	}

	/** Downloads to a temporary file, checks the SHA-256, then moves it into place. */
	private async _download(source: IDownload, target: string, stage: INovaTtsInstallProgress['stage']): Promise<void> {
		const response = await fetch(source.url, { redirect: 'follow' });
		if (!response.ok || !response.body) {
			throw new Error(`Download failed (${response.status}): ${source.url}`);
		}
		const total = Number(response.headers.get('content-length') ?? 0);
		const hash = createHash('sha256');
		let received = 0;
		let lastPercent = -2;

		const temp = `${target}.download`;
		const body = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
		body.on('data', (chunk: Buffer) => {
			hash.update(chunk);
			received += chunk.length;
			const percent = total ? Math.floor(received / total * 100) : -1;
			if (percent !== lastPercent) {
				lastPercent = percent;
				this._onDidInstallProgress.fire({ stage, percent });
			}
		});
		await pipeline(body, createWriteStream(temp));

		if (hash.digest('hex') !== source.sha256) {
			await fs.rm(temp, { force: true });
			throw new Error(`The downloaded file does not match the expected hash: ${source.url}`);
		}
		await fs.rename(temp, target);
	}

	//#endregion

	//#region Synthesis

	async synthesize(request: INovaTtsRequest): Promise<INovaTtsAudio> {
		if (request.provider === 'piper') {
			return this._synthesizeWithPiper(request);
		}
		return synthesizeInCloud(request);
	}

	verifyCredentials(provider: NovaTtsProviderId, credentials: INovaTtsCredentials): Promise<void> {
		return verifyCloudCredentials(provider, credentials);
	}

	private async _synthesizeWithPiper(request: INovaTtsRequest): Promise<INovaTtsAudio> {
		this._checkPiperPlatform();
		this._checkVoice(request.voice);
		if (!await this.isPiperReady(request.voice)) {
			await this.installPiper(request.voice);
		}

		const model = this._voicePath(request.voice, 'onnx');
		const config = this._voicePath(request.voice, 'onnx.json');
		const sampleRate = (JSON.parse(await fs.readFile(config, 'utf8')) as { audio?: { sample_rate?: number } }).audio?.sample_rate ?? 22050;
		const lengthScale = String(Math.min(2, Math.max(0.4, 1 / request.speed)));

		const pcm = await new Promise<Buffer>((resolve, reject) => {
			const child = spawn(this._piperExe, ['--model', model, '--config', config, '--output_raw', '--length_scale', lengthScale, '--sentence_silence', '0.15'], {
				cwd: join(this._root, 'piper'),
				windowsHide: true,
			});
			const chunks: Buffer[] = [];
			const errors: Buffer[] = [];
			const timer = setTimeout(() => {
				child.kill();
				reject(encodeNovaTtsError('other', 'Piper took too long to answer.'));
			}, PIPER_TIMEOUT_MS);
			child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
			child.on('error', err => {
				clearTimeout(timer);
				reject(encodeNovaTtsError('other', err.message));
			});
			child.on('close', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve(Buffer.concat(chunks));
				} else {
					reject(encodeNovaTtsError('other', `Piper exited with code ${code}: ${Buffer.concat(errors).toString('utf8').slice(-300)}`));
				}
			});
			child.stdin.on('error', () => { /* the process ended early; the close handler reports it */ });
			child.stdin.end(request.text.replace(/\r?\n+/g, '\n').trim() + '\n', 'utf8');
		});

		return { audioBase64: wrapPcmAsWav(pcm, sampleRate).toString('base64') };
	}

	//#endregion
}
