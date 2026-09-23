/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Activates the bridge: starts the local MCP/REST server, publishes discovery
 *  info (bridge.json + terminal env vars), and offers commands to wire up
 *  external CLI agents and inspect/self-test the bridge.
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NovaBrowser } from './novaBrowser';
import { startBridgeServer, type INovaBridgeServer } from './server/httpServer';
import { generateToken, removeBridgeFile, writeBridgeFile } from './server/security';

/** Result file written by {@link runSelfTest}, read by external automation
 * (no GUI interaction needed) to confirm the extension-host → CDP → Playwright
 * path still works end-to-end. */
const SELF_TEST_RESULT_PATH = path.join(os.tmpdir(), 'nova-browser-selftest.json');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const novaBrowser = new NovaBrowser();
	context.subscriptions.push(novaBrowser);

	const token = generateToken();
	const preferredPort = vscode.workspace.getConfiguration('nova.browserBridge').get<number>('port', 47800);
	const bridge = await startBridgeServer(novaBrowser, token, preferredPort);
	context.subscriptions.push({ dispose: () => void bridge.close() });

	const mcpUrl = `http://127.0.0.1:${bridge.port}/mcp`;
	const restBaseUrl = `http://127.0.0.1:${bridge.port}/v1`;

	await writeBridgeFile({ url: restBaseUrl, token, pid: process.pid });
	context.subscriptions.push({ dispose: () => void removeBridgeFile() });

	exposeToIntegratedTerminals(context, mcpUrl, restBaseUrl, token);

	const statusBarItem = createStatusBarItem(bridge);
	context.subscriptions.push(statusBarItem);

	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.selfTest', () => runSelfTest(novaBrowser)));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.copyToken', async () => {
		await vscode.env.clipboard.writeText(token);
		void vscode.window.showInformationMessage('Nova Browser Bridge token copied to the clipboard.');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.showStatus', () => showStatusPicker(bridge)));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.configureCliAgents', () => configureCliAgents(mcpUrl)));

	if (process.env.NOVA_BROWSER_SELFTEST_ON_STARTUP === '1') {
		void runSelfTest(novaBrowser);
	}
}

/**
 * Makes `NOVA_BROWSER_URL`/`NOVA_BROWSER_TOKEN` and the `nova-browser` CLI
 * available in every integrated terminal opened from now on. VS Code does not
 * retroactively apply these to already-open terminals.
 */
function exposeToIntegratedTerminals(context: vscode.ExtensionContext, mcpUrl: string, restBaseUrl: string, token: string): void {
	const env = context.environmentVariableCollection;
	env.clear();
	env.replace('NOVA_BROWSER_URL', restBaseUrl);
	env.replace('NOVA_BROWSER_MCP_URL', mcpUrl);
	env.replace('NOVA_BROWSER_TOKEN', token);
	env.prepend('PATH', `${path.join(context.extensionUri.fsPath, 'bin')}${path.delimiter}`);
}

function createStatusBarItem(bridge: INovaBridgeServer): vscode.StatusBarItem {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	item.name = 'Nova Browser Bridge';
	item.text = '$(radio-tower) Nova Bridge';
	item.tooltip = `Nova Browser Bridge listening on 127.0.0.1:${bridge.port}. Click for options.`;
	item.command = 'novaBrowserBridge.showStatus';
	item.show();
	return item;
}

async function showStatusPicker(bridge: INovaBridgeServer): Promise<void> {
	const items: (vscode.QuickPickItem & { action: string })[] = [
		{ label: '$(link) MCP endpoint', description: `http://127.0.0.1:${bridge.port}/mcp`, action: 'noop' },
		{ label: '$(key) Copy bridge token', action: 'copyToken' },
		{ label: '$(gear) Configure CLI agents (Claude Code / Gemini / Codex)', action: 'configure' },
		{ label: '$(beaker) Run self-test', action: 'selfTest' },
		{ label: '$(debug-stop) Stop bridge server', action: 'stop' },
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Nova Browser Bridge' });
	switch (picked?.action) {
		case 'copyToken': return vscode.commands.executeCommand('novaBrowserBridge.copyToken');
		case 'configure': return vscode.commands.executeCommand('novaBrowserBridge.configureCliAgents');
		case 'selfTest': return vscode.commands.executeCommand('novaBrowserBridge.selfTest');
		case 'stop':
			await bridge.close();
			void vscode.window.showInformationMessage('Nova Browser Bridge stopped. Reload the window to start it again.');
			return;
		default: return;
	}
}

/**
 * Writes/merges the "nova-browser" MCP server entry into the config files the
 * plan calls for, asking for confirmation before touching each one. Codex's
 * `~/.codex/config.toml` is only shown (TOML merging is too easy to get wrong
 * to do unattended) rather than written.
 */
async function configureCliAgents(mcpUrl: string): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage('Open a workspace folder first so Nova can write its project-level MCP config.');
		return;
	}

	const targets = await vscode.window.showQuickPick(
		[
			{ label: 'Claude Code (.mcp.json)', picked: true, id: 'claude' },
			{ label: 'Gemini CLI (.gemini/settings.json)', picked: true, id: 'gemini' },
			{ label: 'Codex (show snippet for ~/.codex/config.toml)', picked: true, id: 'codex' },
		],
		{ canPickMany: true, placeHolder: 'Which CLI agents should be configured to use this bridge?' },
	);
	if (!targets || targets.length === 0) {
		return;
	}

	for (const target of targets) {
		if (target.id === 'claude') {
			await mergeJsonFile(vscode.Uri.joinPath(folder.uri, '.mcp.json'), (json) => {
				const mcpServers = (json.mcpServers ??= {}) as Record<string, unknown>;
				mcpServers['nova-browser'] = {
					type: 'http',
					url: mcpUrl,
					headers: { Authorization: 'Bearer ${NOVA_BROWSER_TOKEN}' },
				};
			});
		} else if (target.id === 'gemini') {
			await mergeJsonFile(vscode.Uri.joinPath(folder.uri, '.gemini', 'settings.json'), (json) => {
				const mcpServers = (json.mcpServers ??= {}) as Record<string, unknown>;
				mcpServers['nova-browser'] = {
					httpUrl: mcpUrl,
					headers: { Authorization: 'Bearer ${NOVA_BROWSER_TOKEN}' },
				};
			});
		} else if (target.id === 'codex') {
			const snippet = [
				'[mcp_servers.nova-browser]',
				`url = "${mcpUrl}"`,
				'bearer_token_env_var = "NOVA_BROWSER_TOKEN"',
			].join('\n');
			const doc = await vscode.workspace.openTextDocument({ language: 'toml', content: `# Add this to ~/.codex/config.toml\n\n${snippet}\n` });
			await vscode.window.showTextDocument(doc, { preview: false });
		}
	}
}

async function mergeJsonFile(uri: vscode.Uri, mutate: (json: Record<string, unknown>) => void): Promise<void> {
	let json: Record<string, unknown> = {};
	let existed = false;
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		json = JSON.parse(Buffer.from(raw).toString('utf8'));
		existed = true;
	} catch {
		// File doesn't exist yet, or isn't valid JSON — we'll (re)create it below.
	}

	const confirm = await vscode.window.showWarningMessage(
		existed
			? `Update ${vscode.workspace.asRelativePath(uri)} with the Nova Browser Bridge MCP server entry?`
			: `Create ${vscode.workspace.asRelativePath(uri)} with the Nova Browser Bridge MCP server entry?`,
		{ modal: true },
		'Yes',
	);
	if (confirm !== 'Yes') {
		return;
	}

	mutate(json);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8'));
}

/**
 * Minimal end-to-end check: open a page, connect Playwright to the real
 * Chromium view over its CDP session, and read back a snapshot + screenshot.
 * Runs via the command palette, or automatically on startup when
 * `NOVA_BROWSER_SELFTEST_ON_STARTUP=1`, writing its outcome to
 * {@link SELF_TEST_RESULT_PATH} so it can be verified without touching the UI.
 */
async function runSelfTest(novaBrowser: NovaBrowser): Promise<void> {
	const startedAt = Date.now();
	try {
		// A data: URL keeps the self-test fully offline and exempt from
		// nova.browserBridge.allowedHosts (it has no network host to restrict).
		const testUrl = 'data:text/html,<h1>Nova Browser Bridge self-test</h1><p>It works.</p>';
		const pageId = await novaBrowser.open(testUrl, { background: true });
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
