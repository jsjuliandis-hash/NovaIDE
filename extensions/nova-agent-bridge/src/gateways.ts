/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Model gateways (NVIDIA, OpenRouter) offered as chat providers. Each one runs OpenCode, restricted to
 *  that gateway, with the API key kept in the IDE secure storage. The model lists are fetched from the
 *  gateways' public catalogs, so free models show up without maintaining a list here.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type GatewayId = 'nvidia' | 'openrouter';

export interface Gateway {
	readonly label: string;
	/** Environment variable OpenCode reads the key from. */
	readonly envName: string;
	/** Where the user creates a key. */
	readonly keyUrl: string;
	/** OpenCode configuration (`OPENCODE_CONFIG_CONTENT`) that limits it to this gateway and lists its models. */
	buildConfig(): Promise<object>;
}

const CATALOG_TIMEOUT_MS = 10_000;

/** NVIDIA catalog entries that are not chat models and would only clutter the picker. */
const NVIDIA_NON_CHAT = /embed|rerank|guard|safety|reward|deplot|fuyu|paligemma|clip|parse|retriev|riva|tts|asr|translate|whisper|diffusion|stable-|flux|sdxl|cosmos|segment|ocr|pii|topic|detector|sparsedrive|streampetr|studiovoice|usdcode|usdvalidate/i;

/** Preferred default models, best first; the first one the catalog has is selected when a chat starts. */
const NVIDIA_DEFAULT_MODELS = ['z-ai/glm-5.3', 'moonshotai/kimi-k2.6', 'nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-20b'];

async function fetchCatalog<T>(url: string): Promise<T | undefined> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
		return response.ok ? await response.json() as T : undefined;
	} catch {
		return undefined;
	}
}

export const GATEWAYS: Record<GatewayId, Gateway> = {
	nvidia: {
		label: 'NVIDIA',
		envName: 'NVIDIA_API_KEY',
		keyUrl: 'https://build.nvidia.com/settings/api-keys',
		async buildConfig() {
			const catalog = await fetchCatalog<{ data: { id: string }[] }>('https://integrate.api.nvidia.com/v1/models');
			const models: Record<string, { name: string }> = {};
			for (const { id } of catalog?.data ?? []) {
				if (!NVIDIA_NON_CHAT.test(id)) {
					models[id] = { name: id };
				}
			}
			const defaultModel = NVIDIA_DEFAULT_MODELS.find(id => models[id]);
			return {
				enabled_providers: ['nvidia'],
				...(defaultModel ? { model: `nvidia/${defaultModel}` } : {}),
				provider: {
					nvidia: {
						npm: '@ai-sdk/openai-compatible',
						name: 'NVIDIA',
						options: { baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: '{env:NVIDIA_API_KEY}' },
						models,
						// OpenCode also brings its own NVIDIA catalog, with entries that are not chat models.
						whitelist: Object.keys(models)
					}
				}
			};
		}
	},
	openrouter: {
		label: 'OpenRouter',
		envName: 'OPENROUTER_API_KEY',
		keyUrl: 'https://openrouter.ai/settings/keys',
		async buildConfig() {
			// The free router is the default, so a chat only spends credit when the user picks a paid model.
			const config: { enabled_providers: string[]; model: string; provider?: object } = { enabled_providers: ['openrouter'], model: 'openrouter/openrouter/free' };
			if (vscode.workspace.getConfiguration('nova.agents.openrouter').get<boolean>('freeModelsOnly', false)) {
				const catalog = await fetchCatalog<{ data: { id: string; pricing?: { prompt?: string; completion?: string }; architecture?: { output_modalities?: string[] } }[] }>('https://openrouter.ai/api/v1/models');
				const free = (catalog?.data ?? [])
					.filter(m => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0))
					// Chat models only: music, image and safety-classifier models are listed too.
					.filter(m => (m.architecture?.output_modalities ?? ['text']).every(modality => modality === 'text') && !/safety|guard/i.test(m.id))
					.map(m => m.id);
				if (free.length) {
					config.provider = { openrouter: { whitelist: free } };
				}
			}
			return config;
		}
	}
};
