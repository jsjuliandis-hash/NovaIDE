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
import { DevServerManager, type IDevServerStatus } from './devServer/devServerManager';
import { NovaBrowser } from './novaBrowser';
import { startCdpServer } from './server/cdpServer';
import { startBridgeServer, type INovaBridgeServer } from './server/httpServer';
import { generateToken, removeBridgeFile, writeBridgeFile } from './server/security';

/** Result file written by {@link runSelfTest}, read by external automation
 * (no GUI interaction needed) to confirm the extension-host → CDP → Playwright
 * path still works end-to-end. */
const SELF_TEST_RESULT_PATH = path.join(os.tmpdir(), 'nova-browser-selftest.json');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	if (process.env.NOVA_BROWSER_DIAG === '1') {
		await fs.writeFile(path.join(os.tmpdir(), 'nova-browser-diag.json'), JSON.stringify({
			isTrusted: vscode.workspace.isTrusted,
			workspaceName: vscode.workspace.name,
			folders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? null,
		}, null, 2));
	}

	const novaBrowser = new NovaBrowser();
	context.subscriptions.push(novaBrowser);

	const devServerManager = new DevServerManager(novaBrowser);
	context.subscriptions.push(devServerManager);

	const token = generateToken();
	const preferredPort = vscode.workspace.getConfiguration('nova.browserBridge').get<number>('port', 47800);
	const onAgentRequest = new vscode.EventEmitter<void>();
	context.subscriptions.push(onAgentRequest);
	const bridge = await startBridgeServer(novaBrowser, devServerManager, token, preferredPort, () => onAgentRequest.fire());
	context.subscriptions.push({ dispose: () => void bridge.close() });

	const preferredCdpPort = vscode.workspace.getConfiguration('nova.browserBridge').get<number>('cdpPort', 47801);
	const cdp = await startCdpServer(novaBrowser, token, preferredCdpPort, () => onAgentRequest.fire());
	context.subscriptions.push({ dispose: () => void cdp.close() });

	const mcpUrl = `http://127.0.0.1:${bridge.port}/mcp`;
	const restBaseUrl = `http://127.0.0.1:${bridge.port}/v1`;

	await writeBridgeFile({ url: restBaseUrl, token, pid: process.pid, cdpUrl: cdp.endpointUrl });
	context.subscriptions.push({ dispose: () => void removeBridgeFile() });

	exposeToIntegratedTerminals(context);

	const statusBarItem = createStatusBarItem(bridge, onAgentRequest.event);
	context.subscriptions.push(statusBarItem);

	const devServerStatusBarItem = createDevServerStatusBarItem(devServerManager);
	context.subscriptions.push(devServerStatusBarItem);

	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.selfTest', () => runSelfTest(novaBrowser)));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.copyToken', async () => {
		await vscode.env.clipboard.writeText(token);
		void vscode.window.showInformationMessage(vscode.l10n.t('Nova Browser Bridge token copied to the clipboard.'));
	}));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.showStatus', () => showStatusPicker(bridge)));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.configureCliAgents', () => configureCliAgents(mcpUrl)));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.devServer.start', () => devServerManager.autoStart()));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.devServer.stop', () => devServerManager.stop()));
	context.subscriptions.push(vscode.commands.registerCommand('novaBrowserBridge.devServer.restart', () => devServerManager.restart()));

	if (process.env.NOVA_BROWSER_SELFTEST_ON_STARTUP === '1') {
		void runSelfTest(novaBrowser);
	}

	if (process.env.NOVA_BROWSER_DEVSERVER_AUTOSTART !== '0') {
		void devServerManager.autoStart();
	}
}

/**
 * Puts the `nova-browser` CLI on the PATH of every integrated terminal opened from now on. VS Code
 * does not retroactively apply this to already-open terminals.
 *
 * The URLs and the token are deliberately NOT exported as environment variables: the token is
 * new on every activation, so terminals restored after a reload would be launched with a stale
 * environment and VS Code would flag them with "relaunch the terminal". The CLI reads them from
 * ~/.nova-ide/bridge.json instead, which is rewritten on every activation.
 */
function exposeToIntegratedTerminals(context: vscode.ExtensionContext): void {
	const env = context.environmentVariableCollection;
	env.clear();
	env.prepend('PATH', `${path.join(context.extensionUri.fsPath, 'bin')}${path.delimiter}`);
}

/** Idle: "Nova Bridge". For a few seconds after each agent request: a highlighted "agent is using the browser". */
function createStatusBarItem(bridge: INovaBridgeServer, onAgentRequest: vscode.Event<void>): vscode.Disposable {
	const ACTIVE_MS = 5_000;
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	item.name = 'Nova Browser Bridge';
	item.command = 'novaBrowserBridge.showStatus';
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	const showIdle = () => {
		item.text = '$(radio-tower) Nova Bridge';
		item.tooltip = vscode.l10n.t('Nova Browser Bridge listening on 127.0.0.1:{0}. Click for options.', bridge.port);
		item.backgroundColor = undefined;
	};
	const sub = onAgentRequest(() => {
		item.text = `$(robot) ${vscode.l10n.t('Agent is using the browser')}`;
		item.tooltip = vscode.l10n.t('An external agent is controlling the Integrated Browser through the Nova Browser Bridge. Click to stop the bridge or see options.');
		item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		clearTimeout(resetTimer);
		resetTimer = setTimeout(showIdle, ACTIVE_MS);
	});

	showIdle();
	item.show();
	return { dispose: () => { clearTimeout(resetTimer); sub.dispose(); item.dispose(); } };
}

function createDevServerStatusBarItem(devServerManager: DevServerManager): vscode.Disposable {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	item.name = 'Nova Dev Server';
	item.command = 'novaBrowserBridge.devServer.menu';

	const render = (status: IDevServerStatus) => {
		switch (status.phase) {
			case 'starting':
				item.text = `$(sync~spin) ${vscode.l10n.t('Dev: starting…')}`;
				item.tooltip = status.message ?? status.command;
				item.show();
				break;
			case 'running':
				item.text = `$(circle-filled) Dev: ${status.url ?? ''}`;
				item.tooltip = vscode.l10n.t('{0} — click for options', status.command ?? '');
				item.show();
				break;
			case 'error':
				item.text = `$(warning) ${vscode.l10n.t('Dev: error')}`;
				item.tooltip = status.message;
				item.show();
				break;
			case 'stopped':
				item.text = `$(circle-outline) ${vscode.l10n.t('Dev: stopped')}`;
				item.tooltip = status.message ?? vscode.l10n.t('Click to start the dev server');
				item.show();
				break;
			case 'not-detected':
			case 'needs-install':
			case 'idle':
			default:
				item.hide();
		}
	};
	render(devServerManager.status);
	const sub = devServerManager.onDidChangeStatus(render);

	const menuSub = vscode.commands.registerCommand('novaBrowserBridge.devServer.menu', async () => {
		const status = devServerManager.status;
		const items: (vscode.QuickPickItem & { action: string })[] = [
			...(status.url ? [{ label: `$(globe) ${vscode.l10n.t('Open in Integrated Browser')}`, action: 'open' }] : []),
			{ label: `$(terminal) ${vscode.l10n.t('View logs')}`, action: 'logs' },
			{ label: `$(debug-restart) ${vscode.l10n.t('Restart')}`, action: 'restart' },
			{ label: `$(debug-stop) ${vscode.l10n.t('Stop')}`, action: 'stop' },
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Nova Dev Server' });
		switch (picked?.action) {
			case 'open': return devServerManager.openInBrowser();
			case 'logs': return devServerManager.revealTerminal();
			case 'restart': return devServerManager.restart();
			case 'stop': return devServerManager.stop();
			default: return;
		}
	});

	return { dispose: () => { item.dispose(); sub.dispose(); menuSub.dispose(); } };
}

async function showStatusPicker(bridge: INovaBridgeServer): Promise<void> {
	const items: (vscode.QuickPickItem & { action: string })[] = [
		{ label: `$(link) ${vscode.l10n.t('MCP endpoint')}`, description: `http://127.0.0.1:${bridge.port}/mcp`, action: 'noop' },
		{ label: `$(key) ${vscode.l10n.t('Copy bridge token')}`, action: 'copyToken' },
		{ label: `$(gear) ${vscode.l10n.t('Configure CLI agents (Claude Code / Gemini / Codex)')}`, action: 'configure' },
		{ label: `$(beaker) ${vscode.l10n.t('Run self-test')}`, action: 'selfTest' },
		{ label: `$(debug-stop) ${vscode.l10n.t('Stop bridge server')}`, action: 'stop' },
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Nova Browser Bridge' });
	switch (picked?.action) {
		case 'copyToken': return vscode.commands.executeCommand('novaBrowserBridge.copyToken');
		case 'configure': return vscode.commands.executeCommand('novaBrowserBridge.configureCliAgents');
		case 'selfTest': return vscode.commands.executeCommand('novaBrowserBridge.selfTest');
		case 'stop':
			await bridge.close();
			void vscode.window.showInformationMessage(vscode.l10n.t('Nova Browser Bridge stopped. Reload the window to start it again.'));
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
		void vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder first so Nova can write its project-level MCP config.'));
		return;
	}

	const targets = await vscode.window.showQuickPick(
		[
			{ label: 'Claude Code (.mcp.json)', picked: true, id: 'claude' },
			{ label: 'Gemini CLI (.gemini/settings.json)', picked: true, id: 'gemini' },
			{ label: vscode.l10n.t('Codex (show snippet for ~/.codex/config.toml)'), picked: true, id: 'codex' },
		],
		{ canPickMany: true, placeHolder: vscode.l10n.t('Which CLI agents should be configured to use this bridge?') },
	);
	if (!targets || targets.length === 0) {
		return;
	}

	for (const target of targets) {
		if (target.id === 'claude') {
			await mergeJsonFile(vscode.Uri.joinPath(folder.uri, '.mcp.json'), (json) => {
				const mcpServers = (json.mcpServers ??= {}) as Record<string, unknown>;
				// The token changes on every activation and is not in the terminal environment, so Claude Code asks the CLI for it.
				mcpServers['nova-browser'] = {
					type: 'http',
					url: mcpUrl,
					headersHelper: `node "${path.join(vscode.extensions.getExtension('nova-ide.nova-browser-bridge')?.extensionPath ?? '', 'bin', 'nova-browser.js')}" mcp-headers`,
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
			const doc = await vscode.workspace.openTextDocument({ language: 'toml', content: `# ${vscode.l10n.t('Add this to ~/.codex/config.toml')}\n# ${vscode.l10n.t('NOVA_BROWSER_TOKEN is not set in the terminals anymore: before starting Codex, run it with the output of "nova-browser token".')}\n\n${snippet}\n` });
			await vscode.window.showTextDocument(doc, { preview: false });
		}
	}
}

async function mergeJsonFile(uri: vscode.Uri, mutate: (json: Record<string, unknown>) => void): Promise<void> {
	let json: Record<string, unknown> = {};
	let existed = false;
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		// Strip a leading UTF-8 BOM: some editors write one, and JSON.parse rejects it outright.
		json = JSON.parse(Buffer.from(raw).toString('utf8').replace(/^﻿/, ''));
		existed = true;
	} catch {
		// File doesn't exist yet, or isn't valid JSON — we'll (re)create it below.
	}

	const yes = vscode.l10n.t('Yes');
	const confirm = await vscode.window.showWarningMessage(
		existed
			? vscode.l10n.t('Update {0} with the Nova Browser Bridge MCP server entry?', vscode.workspace.asRelativePath(uri))
			: vscode.l10n.t('Create {0} with the Nova Browser Bridge MCP server entry?', vscode.workspace.asRelativePath(uri)),
		{ modal: true },
		yes,
	);
	if (confirm !== yes) {
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
		void vscode.window.showInformationMessage(vscode.l10n.t('Nova Browser Bridge OK — {0}', firstLine));
		await fs.writeFile(SELF_TEST_RESULT_PATH, JSON.stringify({
			ok: true,
			durationMs: Date.now() - startedAt,
			summary,
			screenshotBytes: screenshot.byteLength,
		}, null, 2));
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		void vscode.window.showErrorMessage(vscode.l10n.t('Nova Browser Bridge self-test failed: {0}', message));
		await fs.writeFile(SELF_TEST_RESULT_PATH, JSON.stringify({
			ok: false,
			durationMs: Date.now() - startedAt,
			error: message,
		}, null, 2));
	}
}
