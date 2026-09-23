/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Bootstraps the NovaBrowser wrapper on startup. The MCP server, CLI, and
 *  DevServerManager (Fase 4/5) attach to this same instance.
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { NovaBrowser } from './novaBrowser';

/**
 * Result file written by {@link runSelfTest}, read by external automation
 * (no GUI interaction needed) to confirm Fase 3 end-to-end: extension host →
 * `browser` proposal → real CDP session → Playwright → snapshot.
 */
const SELF_TEST_RESULT_PATH = path.join(os.tmpdir(), 'nova-browser-selftest.json');

export function activate(context: vscode.ExtensionContext): void {
	const novaBrowser = new NovaBrowser();
	context.subscriptions.push(novaBrowser);

	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.selfTest', async () => {
		await runSelfTest(novaBrowser);
	}));

	if (process.env.NOVA_BROWSER_SELFTEST_ON_STARTUP === '1') {
		void runSelfTest(novaBrowser);
	}
}

/**
 * Minimal end-to-end check for Fase 3: open a page, connect Playwright to the
 * real Chromium view over its CDP session, and read back a snapshot. Runs via
 * the command palette ("Nova Browser Bridge: Self Test"), or automatically on
 * startup when `NOVA_BROWSER_SELFTEST_ON_STARTUP=1`, writing its outcome to
 * {@link SELF_TEST_RESULT_PATH} so it can be verified without touching the UI.
 */
async function runSelfTest(novaBrowser: NovaBrowser): Promise<void> {
	const startedAt = Date.now();
	try {
		const pageId = await novaBrowser.open('https://example.com', { background: true });
		const summary = await novaBrowser.snapshot(pageId);
		const screenshot = await novaBrowser.screenshot(pageId);
		await novaBrowser.close(pageId);

		const firstLine = summary.split('\n').find(line => line.startsWith('Page Title:')) ?? summary.slice(0, 80);
		void vscode.window.showInformationMessage(`Nova Browser Bridge OK — ${firstLine}`);
		await fs.writeFile(SELF_TEST_RESULT_PATH, JSON.stringify({
			ok: true,
			durationMs: Date.now() - startedAt,
			summary,
			screenshotBytes: screenshot.byteLength,
		}, null, 2));
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		void vscode.window.showErrorMessage(`Nova Browser Bridge self-test failed: ${message}`);
		await fs.writeFile(SELF_TEST_RESULT_PATH, JSON.stringify({
			ok: false,
			durationMs: Date.now() - startedAt,
			error: message,
		}, null, 2));
	}
}
