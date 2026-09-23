/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Detects what dev server (if any) to run for a workspace folder: an explicit
 *  `.nova/devserver.json` override, the root `package.json`, or a single
 *  candidate under `apps/*` / `packages/*` in a monorepo.
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectPackageManager, hasNodeModules, PackageManager, runScriptCommand } from './packageManager';

const SCRIPT_PRIORITY = ['dev', 'start', 'serve'];
const MONOREPO_GLOBS = ['apps', 'packages'];

/** Dependency name → expected default port, used only as a TCP-polling fallback hint. */
const FRAMEWORK_PORTS: [RegExp, number][] = [
	[/^vite$/, 5173],
	[/^next$/, 3000],
	[/^@angular\/cli$/, 4200],
	[/^@vue\/cli-service$/, 8080],
	[/^react-scripts$/, 3000],
	[/^astro$/, 4321],
	[/^nuxt3?$/, 3000],
	[/^@sveltejs\/kit$/, 5173],
];

export interface IDevServerOverride {
	command: string;
	cwd?: string;
	url?: string;
	env?: Record<string, string>;
}

export interface IDetectedDevServer {
	readonly cwd: string;
	readonly command: string;
	readonly packageManager: PackageManager;
	readonly needsInstall: boolean;
	/** Set only when `.nova/devserver.json` provides one — skips URL detection entirely. */
	readonly knownUrl?: string;
	readonly env?: Record<string, string>;
	/** Best-guess port for the TCP-polling fallback; the real URL from terminal output always wins. */
	readonly expectedPort?: number;
}

export interface IDevServerCandidate {
	readonly label: string;
	readonly cwd: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		// Strip a leading UTF-8 BOM: some editors (and PowerShell's `-Encoding
		// utf8`) write one, and JSON.parse rejects it outright.
		const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function readOverride(root: string): IDevServerOverride | undefined {
	const file = path.join(root, '.nova', 'devserver.json');
	const json = readJson(file);
	if (!json || typeof json.command !== 'string') {
		return undefined;
	}
	return {
		command: json.command,
		cwd: typeof json.cwd === 'string' ? path.resolve(root, json.cwd) : undefined,
		url: typeof json.url === 'string' ? json.url : undefined,
		env: typeof json.env === 'object' && json.env ? json.env as Record<string, string> : undefined,
	};
}

/** Writes back a chosen monorepo candidate so future activations don't need to ask again. */
export function persistCandidateChoice(root: string, candidateCwd: string): void {
	const relativeCwd = path.relative(root, candidateCwd) || '.';
	const file = path.join(root, '.nova', 'devserver.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const pm = detectPackageManager(candidateCwd);
	const script = pickScript(readJson(path.join(candidateCwd, 'package.json')));
	if (!script) {
		return;
	}
	fs.writeFileSync(file, JSON.stringify({ command: runScriptCommand(pm, script), cwd: relativeCwd }, null, 2) + '\n');
}

function pickScript(packageJson: Record<string, unknown> | undefined): string | undefined {
	const scripts = packageJson?.scripts as Record<string, string> | undefined;
	if (!scripts) {
		return undefined;
	}
	return SCRIPT_PRIORITY.find(name => typeof scripts[name] === 'string');
}

function guessPort(packageJson: Record<string, unknown> | undefined): number | undefined {
	const deps = {
		...(packageJson?.dependencies as Record<string, string> | undefined),
		...(packageJson?.devDependencies as Record<string, string> | undefined),
	};
	for (const depName of Object.keys(deps)) {
		const match = FRAMEWORK_PORTS.find(([pattern]) => pattern.test(depName));
		if (match) {
			return match[1];
		}
	}
	return undefined;
}

/** Finds every subdirectory under apps/*, packages/* with a package.json that has a runnable script. */
function findMonorepoCandidates(root: string): IDevServerCandidate[] {
	const candidates: IDevServerCandidate[] = [];
	for (const group of MONOREPO_GLOBS) {
		const groupDir = path.join(root, group);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(groupDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const candidateCwd = path.join(groupDir, entry.name);
			const packageJson = readJson(path.join(candidateCwd, 'package.json'));
			if (pickScript(packageJson)) {
				candidates.push({ label: `${group}/${entry.name}`, cwd: candidateCwd });
			}
		}
	}
	return candidates;
}

export type DetectResult =
	| { kind: 'found'; server: IDetectedDevServer }
	| { kind: 'choose'; candidates: IDevServerCandidate[] }
	| { kind: 'none' };

/**
 * Detects a dev server for `root`. Returns `choose` when a monorepo has more
 * than one runnable candidate under apps/*|packages/* and no override/root
 * script has already resolved it — the caller should ask the user and persist
 * the answer via {@link persistCandidateChoice}.
 */
export function detectDevServer(root: string): DetectResult {
	const override = readOverride(root);
	if (override) {
		return {
			kind: 'found',
			server: {
				cwd: override.cwd ?? root,
				command: override.command,
				packageManager: detectPackageManager(override.cwd ?? root),
				needsInstall: false, // an explicit override is assumed to already be runnable as given
				knownUrl: override.url,
				env: override.env,
			},
		};
	}

	const rootPackageJson = readJson(path.join(root, 'package.json'));
	const rootScript = pickScript(rootPackageJson);
	if (rootScript) {
		return { kind: 'found', server: buildFromPackageJson(root, rootPackageJson!, rootScript) };
	}

	const candidates = findMonorepoCandidates(root);
	if (candidates.length === 1) {
		const packageJson = readJson(path.join(candidates[0].cwd, 'package.json'))!;
		return { kind: 'found', server: buildFromPackageJson(candidates[0].cwd, packageJson, pickScript(packageJson)!) };
	}
	if (candidates.length > 1) {
		return { kind: 'choose', candidates };
	}

	return { kind: 'none' };
}

function buildFromPackageJson(cwd: string, packageJson: Record<string, unknown>, script: string): IDetectedDevServer {
	const pm = detectPackageManager(cwd);
	return {
		cwd,
		command: runScriptCommand(pm, script),
		packageManager: pm,
		needsInstall: !hasNodeModules(cwd),
		expectedPort: guessPort(packageJson),
	};
}
