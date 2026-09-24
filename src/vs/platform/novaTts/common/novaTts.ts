/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Text to speech shared by the main process and the workbench: local Piper voice (default) and
 *  optional cloud voices with the user's own key (Azure, Google, ElevenLabs, Amazon Polly).
 *-------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const INovaTtsService = createDecorator<INovaTtsService>('novaTts');

export type NovaTtsProviderId = 'piper' | 'azure' | 'google' | 'elevenlabs' | 'amazon';

export const NOVA_TTS_PROVIDERS: readonly NovaTtsProviderId[] = ['piper', 'azure', 'google', 'elevenlabs', 'amazon'];

/** Piper voices (Brazilian Portuguese) that can be downloaded, best default first. */
export const NOVA_PIPER_VOICES = ['pt_BR-faber-medium', 'pt_BR-cadu-medium', 'pt_BR-jeff-medium'] as const;

export const NOVA_TTS_DEFAULT_VOICES: Record<NovaTtsProviderId, string> = {
	piper: 'pt_BR-faber-medium',
	azure: 'pt-BR-FranciscaNeural',
	google: 'pt-BR-Chirp3-HD-Aoede',
	elevenlabs: '21m00Tcm4TlvDq8ikWAM',
	amazon: 'Camila',
};

/** Secrets a cloud provider needs. Which fields are used depends on the provider. */
export interface INovaTtsCredentials {
	/** API key (Azure, Google, ElevenLabs) or AWS access key id (Amazon). */
	readonly apiKey?: string;
	/** AWS secret access key (Amazon only). */
	readonly secretKey?: string;
	/** Azure Speech region, or AWS region. */
	readonly region?: string;
}

export interface INovaTtsRequest {
	readonly provider: NovaTtsProviderId;
	readonly text: string;
	readonly voice: string;
	/** 1 is the normal speed. */
	readonly speed: number;
	/** BCP-47 language, for example `pt-BR`. */
	readonly language: string;
	readonly credentials?: INovaTtsCredentials;
}

export interface INovaTtsAudio {
	/** Base64 of a complete audio file (WAV or MP3) that `AudioContext.decodeAudioData` can decode. */
	readonly audioBase64: string;
}

export type NovaTtsErrorKind = 'auth' | 'rateLimit' | 'network' | 'unsupported' | 'other';

/** Prefix of an error message that carries an error kind through the IPC boundary. */
export const NOVA_TTS_ERROR_PREFIX = 'NOVA_TTS:';

export function encodeNovaTtsError(kind: NovaTtsErrorKind, message: string): Error {
	return new Error(`${NOVA_TTS_ERROR_PREFIX}${kind}:${message}`);
}

export function decodeNovaTtsError(error: unknown): { readonly kind: NovaTtsErrorKind; readonly message: string } {
	const message = error instanceof Error ? error.message : String(error);
	const match = new RegExp(`${NOVA_TTS_ERROR_PREFIX}(\\w+):([\\s\\S]*)`).exec(message);
	if (match) {
		return { kind: match[1] as NovaTtsErrorKind, message: match[2] };
	}
	return { kind: 'other', message };
}

export interface INovaTtsInstallProgress {
	readonly stage: 'piper' | 'voice';
	/** 0..100, or -1 when the size is unknown. */
	readonly percent: number;
}

export interface INovaTtsService {

	readonly _serviceBrand: undefined;

	/** Progress of the Piper download, so the workbench can show it. */
	readonly onDidInstallProgress: Event<INovaTtsInstallProgress>;

	/** Whether the Piper program and the given voice are already downloaded. */
	isPiperReady(voice: string): Promise<boolean>;

	/** Downloads Piper and the voice (checking their hashes) when missing. */
	installPiper(voice: string): Promise<void>;

	/** Turns text into audio. Throws an error created by {@link encodeNovaTtsError}. */
	synthesize(request: INovaTtsRequest): Promise<INovaTtsAudio>;

	/** Cheap authenticated request that checks the credentials. Resolves when they work. */
	verifyCredentials(provider: NovaTtsProviderId, credentials: INovaTtsCredentials): Promise<void>;
}
