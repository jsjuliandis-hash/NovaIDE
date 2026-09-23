/*---------------------------------------------------------------------------------------------
 *  Nova IDE — generates dev-mode translations from an official VS Code language pack.
 *
 *  Usage: node build/nova/devNls.ts [locale=pt-br]
 *
 *  Output in .build/nova-nls/<locale>/:
 *    messages.json  { "<key>\u0000<english message>": "<translation>" } read by src/vs/nls.ts in dev
 *    tcf.json       { "<extension id>": "<abs path to .i18n.json>" } used for built-in extensions
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import yauzl from 'yauzl';
import { analyzeLocalizeCalls, parseLocalizeKeyOrValue } from '../lib/nls-analysis.ts';

const PACKS: Record<string, string> = {
	'pt-br': 'https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-pt-BR/1.131.0/file/MS-CEINTL.vscode-language-pack-pt-BR-1.131.0.vsix',
};

const root = path.join(import.meta.dirname, '..', '..');
const srcDir = path.join(root, 'src');
const locale = (process.argv[2] ?? 'pt-br').toLowerCase();
const outDir = path.join(root, '.build', 'nova-nls', locale);
const vsixPath = path.join(outDir, 'pack.vsix');
const packDir = path.join(outDir, 'pack');

async function download(): Promise<void> {
	if (fs.existsSync(vsixPath)) {
		return;
	}
	const url = PACKS[locale];
	if (!url) {
		throw new Error(`No language pack URL configured for locale '${locale}'.`);
	}
	console.log(`[nova-nls] downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	}
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(vsixPath, Buffer.from(await res.arrayBuffer()));
}

function extract(): Promise<void> {
	fs.rmSync(packDir, { recursive: true, force: true });
	return new Promise((resolve, reject) => {
		yauzl.open(vsixPath, { lazyEntries: true }, (err, zip) => {
			if (err || !zip) {
				return reject(err);
			}
			zip.on('error', reject);
			zip.on('end', () => resolve());
			zip.on('entry', (entry: yauzl.Entry) => {
				if (!entry.fileName.startsWith('extension/') || entry.fileName.endsWith('/')) {
					return zip.readEntry();
				}
				const target = path.join(packDir, entry.fileName.slice('extension/'.length));
				if (!target.startsWith(packDir + path.sep)) {
					return reject(new Error(`Unsafe path in VSIX: ${entry.fileName}`));
				}
				fs.mkdirSync(path.dirname(target), { recursive: true });
				zip.openReadStream(entry, (streamErr, stream) => {
					if (streamErr || !stream) {
						return reject(streamErr);
					}
					stream.pipe(fs.createWriteStream(target)).on('finish', () => zip.readEntry()).on('error', reject);
				});
			});
			zip.readEntry();
		});
	});
}

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test' && entry.name !== 'node_modules') {
				yield* walk(full);
			}
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			yield full;
		}
	}
}

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

async function main(): Promise<void> {
	await download();
	await extract();

	const manifest = readJson<{ contributes: { localizations: { languageId: string; translations: { id: string; path: string }[] }[] } }>(path.join(packDir, 'package.json'));
	const localization = manifest.contributes.localizations[0];
	const tcf: Record<string, string> = {};
	for (const t of localization.translations) {
		tcf[t.id] = path.join(packDir, t.path);
	}

	// Built-in extensions that ship their own translations (e.g. nova-browser-bridge) in language-pack format.
	const extensionsDir = path.join(root, 'extensions');
	for (const name of fs.readdirSync(extensionsDir)) {
		const i18nFile = path.join(extensionsDir, name, 'i18n', `${locale}.i18n.json`);
		const manifestFile = path.join(extensionsDir, name, 'package.json');
		if (fs.existsSync(i18nFile) && fs.existsSync(manifestFile)) {
			const { publisher, name: extensionName } = readJson<{ publisher: string; name: string }>(manifestFile);
			tcf[`${publisher}.${extensionName}`] = i18nFile;
		}
	}

	const main = readJson<{ contents: Record<string, Record<string, string>> }>(tcf.vscode);
	const messages = new Map<string, string>();
	let calls = 0;
	let translated = 0;

	for (const file of walk(path.join(srcDir, 'vs'))) {
		const source = fs.readFileSync(file, 'utf8');
		if (!source.includes('localize')) {
			continue;
		}
		const moduleId = path.relative(srcDir, file).replace(/\\/g, '/').replace(/\.ts$/, '');
		const moduleTranslations = main.contents[moduleId];
		for (const fn of ['localize', 'localize2'] as const) {
			for (const call of analyzeLocalizeCalls(source, fn)) {
				calls++;
				let key: string;
				let english: string;
				try {
					const parsedKey = parseLocalizeKeyOrValue(call.key);
					key = typeof parsedKey === 'string' ? parsedKey : parsedKey.key;
					english = String(parseLocalizeKeyOrValue(call.value));
				} catch {
					continue; // non-literal key/message: cannot be translated statically
				}
				const translation = moduleTranslations?.[key];
				const id = `${key}\u0000${english}`;
				if (translation && translation !== english && !messages.has(id)) {
					messages.set(id, translation);
					translated++;
				}
			}
		}
	}

	fs.writeFileSync(path.join(outDir, 'messages.json'), JSON.stringify(Object.fromEntries(messages)));
	fs.writeFileSync(path.join(outDir, 'tcf.json'), JSON.stringify(tcf));
	console.log(`[nova-nls] ${locale}: ${translated} of ${calls} localize calls translated → ${outDir}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
