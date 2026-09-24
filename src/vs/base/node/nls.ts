/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../common/path.js';
import { promises } from 'fs';
import { mark } from '../common/performance.js';
import { ILanguagePack, ILanguagePacks, INLSConfiguration } from '../../nls.js';
import { Promises } from './pfs.js';
import { novaTranslations } from '../common/novaNls.js';

export interface IResolveNLSConfigurationContext {

	/**
	 * Location where `nls.messages.json` and `nls.keys.json` are stored.
	 */
	readonly nlsMetadataPath: string;

	/**
	 * Precomputed identity of the commit and NLS tables, supplied by packaged products.
	 */
	readonly nlsMetadataHash?: string;

	/**
	 * Path to the user data directory. Used as a cache for
	 * language packs converted to the format we need.
	 */
	readonly userDataPath: string;

	/**
	 * Commit of the running application. Can be `undefined`
	 * when not built.
	 */
	readonly commit: string | undefined;

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;
}

export async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath, nlsMetadataHash }: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	mark('code/willGenerateNls');

	if (process.env['VSCODE_DEV'] && userLocale !== 'pseudo' && !userLocale.startsWith('en')) {
		const devConfiguration = await resolveNovaDevNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		if (devConfiguration) {
			return devConfiguration;
		}
	}

	if (
		process.env['VSCODE_DEV'] ||
		userLocale === 'pseudo' ||
		userLocale.startsWith('en') ||
		!commit ||
		!userDataPath
	) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	try {
		// NOVA: language packs bundled as built-in extensions work from the first launch, before
		// anything writes languagepacks.json. Installed language packs still take precedence.
		const installedLanguagePacks = await getLanguagePackConfigurations(userDataPath);
		const builtinLanguagePacks = await getNovaBuiltinLanguagePacks(nlsMetadataPath);
		const languagePacks = builtinLanguagePacks || installedLanguagePacks ? { ...builtinLanguagePacks, ...installedLanguagePacks } : undefined;
		if (!languagePacks) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const resolvedLanguage = resolveLanguagePackLanguage(languagePacks, userLocale);
		if (!resolvedLanguage) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePack = languagePacks[resolvedLanguage];
		const mainLanguagePackPath = languagePack?.translations?.['vscode'];
		if (
			!languagePack ||
			typeof languagePack.hash !== 'string' ||
			!languagePack.translations ||
			typeof mainLanguagePackPath !== 'string' ||
			!(await Promises.exists(mainLanguagePackPath))
		) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePackId = `${languagePack.hash}.${resolvedLanguage}`;
		const globalLanguagePackCachePath = join(userDataPath, 'clp', languagePackId);
		const commitLanguagePackCachePath = join(globalLanguagePackCachePath, nlsMetadataHash ?? commit);
		const languagePackMessagesFile = join(commitLanguagePackCachePath, 'nls.messages.json');
		const translationsConfigFile = join(globalLanguagePackCachePath, 'tcf.json');
		const languagePackCorruptMarkerFile = join(globalLanguagePackCachePath, 'corrupted.info');

		if (await Promises.exists(languagePackCorruptMarkerFile)) {
			await promises.rm(globalLanguagePackCachePath, { recursive: true, force: true, maxRetries: 3 }); // delete corrupted cache folder
		}

		const result: INLSConfiguration = {
			userLocale,
			osLocale,
			resolvedLanguage,
			defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),
			languagePack: {
				translationsConfigFile,
				messagesFile: languagePackMessagesFile,
				corruptMarkerFile: languagePackCorruptMarkerFile
			},

			// NLS: below properties are a relic from old times only used by vscode-nls and deprecated
			locale: userLocale,
			availableLanguages: { '*': resolvedLanguage },
			_languagePackId: languagePackId,
			_languagePackSupport: true,
			_translationsConfigFile: translationsConfigFile,
			_cacheRoot: globalLanguagePackCachePath,
			_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
			_corruptedFile: languagePackCorruptMarkerFile
		};

		if (await Promises.exists(languagePackMessagesFile)) {
			touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
			mark('code/didGenerateNls');
			return result;
		}

		const [
			nlsDefaultKeys,
			nlsDefaultMessages,
			nlsPackdata
		]:
			[Array<[string, string[]]>, string[], { contents: Record<string, Record<string, string>> }]
			//      ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
			= await Promise.all([
				promises.readFile(join(nlsMetadataPath, 'nls.keys.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(join(nlsMetadataPath, 'nls.messages.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(mainLanguagePackPath, 'utf-8').then(content => JSON.parse(content)),
			]);

		const nlsResult: string[] = [];

		// We expect NLS messages to be in a flat array in sorted order as they
		// where produced during build time. We use `nls.keys.json` to know the
		// right order and then lookup the related message from the translation.
		// If a translation does not exist, we fallback to the default message.

		let nlsIndex = 0;
		for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
			const moduleTranslations = nlsPackdata.contents[moduleId];
			const novaModuleTranslations = novaTranslations[resolvedLanguage]?.[moduleId]; // NOVA: strings Nova added to the core
			for (const nlsKey of nlsKeys) {
				nlsResult.push(moduleTranslations?.[nlsKey] || novaModuleTranslations?.[nlsKey] || nlsDefaultMessages[nlsIndex]);
				nlsIndex++;
			}
		}

		await promises.mkdir(commitLanguagePackCachePath, { recursive: true });

		await Promise.all([
			promises.writeFile(languagePackMessagesFile, JSON.stringify(nlsResult), 'utf-8'),
			promises.writeFile(translationsConfigFile, JSON.stringify(languagePack.translations), 'utf-8')
		]);

		mark('code/didGenerateNls');

		return result;
	} catch (error) {
		console.error('Generating translation files failed.', error);
	}

	return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
}

/**
 * The `languagepacks.json` file is a JSON file that contains all metadata
 * about installed language extensions per language. Specifically, for
 * core (`vscode`) and all extensions it supports, it points to the related
 * translation files.
 *
 * The file is updated whenever a new language pack is installed or removed.
 */
async function getLanguagePackConfigurations(userDataPath: string): Promise<ILanguagePacks | undefined> {
	const configFile = join(userDataPath, 'languagepacks.json');
	try {
		return JSON.parse(await promises.readFile(configFile, 'utf-8'));
	} catch (err) {
		return undefined; // Do nothing. If we can't read the file we have no language pack config.
	}
}

interface INovaLocalizationManifest {
	readonly name?: string;
	readonly publisher?: string;
	readonly version?: string;
	readonly contributes?: {
		readonly localizations?: {
			readonly languageId?: string;
			readonly languageName?: string;
			readonly localizedLanguageName?: string;
			readonly translations?: { readonly id?: string; readonly path?: string }[];
		}[];
	};
}

/**
 * NOVA: builds language pack configurations from the language pack extensions shipped in
 * `<appRoot>/extensions` (see `builtInExtensions` in product.json). Built-in extensions that
 * ship their own `i18n/<language>.i18n.json` (the Nova extensions) are added to the pack.
 */
async function getNovaBuiltinLanguagePacks(nlsMetadataPath: string): Promise<ILanguagePacks | undefined> {
	const extensionsPath = join(nlsMetadataPath, '..', 'extensions');
	let allFolders: string[];
	try {
		allFolders = await promises.readdir(extensionsPath);
	} catch {
		return undefined;
	}
	const folders = allFolders.filter(folder => /language-pack/i.test(folder));

	const languagePacks: Record<string, ILanguagePack> = {};
	for (const folder of folders) {
		const extensionPath = join(extensionsPath, folder);
		let manifest: INovaLocalizationManifest;
		try {
			manifest = JSON.parse(await promises.readFile(join(extensionPath, 'package.json'), 'utf-8'));
		} catch {
			continue;
		}

		const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
		const version = manifest.version ?? '0.0.0';
		for (const localization of manifest.contributes?.localizations ?? []) {
			if (!localization.languageId || !localization.translations?.length) {
				continue;
			}
			const languageId = localization.languageId.toLowerCase();
			const translations: Record<string, string> = {};
			for (const translation of localization.translations) {
				if (translation.id && translation.path) {
					translations[translation.id] = join(extensionPath, translation.path);
				}
			}
			const bundled: string[] = [];
			for (const other of allFolders) {
				const i18nFile = join(extensionsPath, other, 'i18n', `${languageId}.i18n.json`);
				if (!await Promises.exists(i18nFile)) {
					continue;
				}
				try {
					const otherManifest: INovaLocalizationManifest = JSON.parse(await promises.readFile(join(extensionsPath, other, 'package.json'), 'utf-8'));
					translations[`${otherManifest.publisher}.${otherManifest.name}`] = i18nFile;
					bundled.push(`${otherManifest.name}@${otherManifest.version}`);
				} catch {
					// not an extension folder
				}
			}
			languagePacks[languageId] = {
				// the hash names the translation cache folder, so it must change when the bundled extensions do
				hash: `nova-builtin-${version}-${simpleHash(bundled.join(','))}`.replace(/[^\w.-]/g, '_'),
				label: localization.localizedLanguageName ?? localization.languageName,
				extensions: [{ extensionIdentifier: { id }, version }],
				translations
			};
		}
	}

	return Object.keys(languagePacks).length ? languagePacks : undefined;
}

function simpleHash(value: string): string {
	let hash = 5381;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(16);
}

function resolveLanguagePackLanguage(languagePacks: ILanguagePacks, locale: string | undefined): string | undefined {
	try {
		while (locale) {
			if (languagePacks[locale]) {
				return locale;
			}

			const index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				return undefined;
			}
		}
	} catch (error) {
		console.error('Resolving language pack configuration failed.', error);
	}

	return undefined;
}

// NOVA: dev builds have no nls.keys.json, so they use the per-message translations written by
// build/nova/devNls.ts to <repo>/.build/nova-nls/<locale>/ (tried as `pt-br`, then `pt`).
async function resolveNovaDevNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): Promise<INLSConfiguration | undefined> {
	const devNlsRoot = join(nlsMetadataPath, '..', '.build', 'nova-nls');
	for (const language of [userLocale, userLocale.split('-')[0]]) {
		const languageDir = join(devNlsRoot, language);
		const messagesFile = join(languageDir, 'messages.json');
		const translationsConfigFile = join(languageDir, 'tcf.json');
		if (await Promises.exists(messagesFile) && await Promises.exists(translationsConfigFile)) {
			const corruptMarkerFile = join(languageDir, 'corrupted.info');
			return {
				userLocale,
				osLocale,
				resolvedLanguage: language,
				defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),
				languagePack: { translationsConfigFile, messagesFile, corruptMarkerFile },
				locale: userLocale,
				availableLanguages: { '*': language },
				_languagePackSupport: true,
				_translationsConfigFile: translationsConfigFile,
				_cacheRoot: languageDir,
				_resolvedLanguagePackCoreLocation: languageDir,
				_corruptedFile: corruptMarkerFile
			};
		}
	}
	return undefined;
}

function defaultNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): INLSConfiguration {
	mark('code/didGenerateNls');

	return {
		userLocale,
		osLocale,
		resolvedLanguage: 'en',
		defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),

		// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
		locale: userLocale,
		availableLanguages: {}
	};
}

//#region fs helpers

function touch(path: string): Promise<void> {
	const date = new Date();

	return promises.utimes(path, date, date);
}

//#endregion
