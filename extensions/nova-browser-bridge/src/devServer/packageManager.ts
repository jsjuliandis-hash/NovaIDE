/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Package manager detection by lockfile, and a node_modules presence check
 *  used to decide whether to ask before installing.
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

const LOCKFILE_BY_MANAGER: [string, PackageManager][] = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm'],
];

/** Detects the package manager for `cwd` by lockfile presence, defaulting to npm. */
export function detectPackageManager(cwd: string): PackageManager {
	for (const [lockfile, manager] of LOCKFILE_BY_MANAGER) {
		if (fs.existsSync(path.join(cwd, lockfile))) {
			return manager;
		}
	}
	return 'npm';
}

export function hasNodeModules(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, 'node_modules'));
}

export function installCommand(manager: PackageManager): string {
	switch (manager) {
		case 'pnpm': return 'pnpm install';
		case 'yarn': return 'yarn install';
		case 'bun': return 'bun install';
		case 'npm': return 'npm install';
	}
}

export function runScriptCommand(manager: PackageManager, script: string): string {
	switch (manager) {
		case 'pnpm': return `pnpm run ${script}`;
		case 'yarn': return `yarn ${script}`;
		case 'bun': return `bun run ${script}`;
		case 'npm': return `npm run ${script}`;
	}
}
