/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Detects a project's dev server, runs it in a named "Dev Server" integrated
 *  terminal, finds the URL it starts listening on, and opens that URL in the
 *  Integrated Browser via NovaBrowser. Respects Workspace Trust: nothing here
 *  ever runs a script in an untrusted workspace.
 *-------------------------------------------------------------------------------------------*/

import * as net from 'node:net';
import * as vscode from 'vscode';
import { NovaBrowser } from '../novaBrowser';
import { DetectResult, detectDevServer, IDetectedDevServer, IDevServerCandidate, persistCandidateChoice } from './detect';
import { hasNodeModules, installCommand } from './packageManager';
import { findLocalUrl } from './urlFinder';

const TERMINAL_NAME = 'Dev Server';
const SHELL_INTEGRATION_TIMEOUT_MS = 3_000;
const URL_DETECTION_TIMEOUT_MS = 60_000;

export type DevServerPhase = 'idle' | 'not-detected' | 'needs-install' | 'starting' | 'running' | 'stopped' | 'error';

export interface IDevServerStatus {
	phase: DevServerPhase;
	url?: string;
	command?: string;
	cwd?: string;
	message?: string;
}

export class DevServerManager implements vscode.Disposable {
	private readonly _onDidChangeStatus = new vscode.EventEmitter<IDevServerStatus>();
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private _status: IDevServerStatus = { phase: 'idle' };
	private _terminal: vscode.Terminal | undefined;
	private readonly _disposables: vscode.Disposable[] = [];
	private _stopping = false;

	constructor(private readonly novaBrowser: NovaBrowser) {
		this._disposables.push(vscode.window.onDidCloseTerminal(t => {
			if (t === this._terminal && !this._stopping) {
				this._setStatus({ phase: 'stopped', message: 'The Dev Server terminal was closed.' });
				this._terminal = undefined;
			}
		}));
	}

	get status(): IDevServerStatus {
		return this._status;
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose();
		}
		this._onDidChangeStatus.dispose();
	}

	/**
	 * Runs on activation for every trusted workspace folder: detects a project,
	 * and starts it according to `nova.devServer.autoStart` ('always' | 'ask' |
	 * 'never', default 'ask' — asking persists the answer so it isn't repeated).
	 */
	async autoStart(): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			this._setStatus({ phase: 'stopped', message: 'Workspace is not trusted; Nova will not auto-detect or run dev server scripts.' });
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0];
		if (!root) {
			this._setStatus({ phase: 'not-detected', message: 'No workspace folder is open.' });
			return;
		}

		const result = detectDevServer(root.uri.fsPath);
		if (result.kind === 'none') {
			this._setStatus({ phase: 'not-detected' });
			return;
		}

		const setting = vscode.workspace.getConfiguration('nova.devServer').get<'always' | 'ask' | 'never'>('autoStart', 'ask');
		if (setting === 'never') {
			this._setStatus({ phase: 'stopped', message: 'Dev server detected but nova.devServer.autoStart is "never".' });
			return;
		}

		const server = await this._resolve(result, root.uri.fsPath);
		if (!server) {
			this._setStatus({ phase: 'not-detected', message: 'No dev server candidate was chosen.' });
			return;
		}

		if (setting === 'always') {
			await this.start(server);
			return;
		}

		const choice = await vscode.window.showInformationMessage(
			`Detected a dev server (${server.command} in ${vscode.workspace.asRelativePath(server.cwd)}). Start it and open it in the Integrated Browser?`,
			'Yes', 'Always for this workspace', "Don't ask again",
		);
		if (choice === 'Yes') {
			await this.start(server);
		} else if (choice === 'Always for this workspace') {
			await vscode.workspace.getConfiguration('nova.devServer').update('autoStart', 'always', vscode.ConfigurationTarget.Workspace);
			await this.start(server);
		} else if (choice === "Don't ask again") {
			await vscode.workspace.getConfiguration('nova.devServer').update('autoStart', 'never', vscode.ConfigurationTarget.Workspace);
			this._setStatus({ phase: 'stopped', message: 'Dev server auto-start disabled for this workspace.' });
		}
	}

	/** Re-runs detection (ignoring autoStart's ask/never gate) and starts it. Used by the "Restart" command/status bar action. */
	async restart(): Promise<void> {
		await this.stop();
		const root = vscode.workspace.workspaceFolders?.[0];
		if (!root) {
			return;
		}
		const result = detectDevServer(root.uri.fsPath);
		const server = await this._resolve(result, root.uri.fsPath);
		if (server) {
			await this.start(server);
		}
	}

	async stop(): Promise<void> {
		this._stopping = true;
		this._terminal?.dispose();
		this._terminal = undefined;
		this._stopping = false;
		this._setStatus({ phase: 'stopped' });
	}

	openInBrowser(): void {
		if (this._status.url) {
			void this.novaBrowser.open(this._status.url, { reuse: true });
		}
	}

	revealTerminal(): void {
		this._terminal?.show();
	}

	/** Resolves a `choose` result by asking the user, persisting the pick for next time. Returns undefined if there's nothing to run or the user cancels. */
	private async _resolve(result: DetectResult, root: string): Promise<IDetectedDevServer | undefined> {
		if (result.kind === 'found') {
			return result.server;
		}
		if (result.kind === 'none') {
			this._setStatus({ phase: 'not-detected' });
			return undefined;
		}
		// result.kind === 'choose'
		const picked = await this._pickCandidate(result.candidates);
		if (!picked) {
			return undefined;
		}
		persistCandidateChoice(root, picked.cwd);
		const reresolved = detectDevServer(root);
		return reresolved.kind === 'found' ? reresolved.server : undefined;
	}

	private async _pickCandidate(candidates: IDevServerCandidate[]): Promise<IDevServerCandidate | undefined> {
		const items = candidates.map(c => ({ label: c.label, candidate: c }));
		const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Multiple runnable projects found — which one should Nova run as the dev server?' });
		return picked?.candidate;
	}

	async start(server: IDetectedDevServer): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Nova Browser Bridge will not run dev server scripts in an untrusted workspace.');
			return;
		}

		if (server.needsInstall && !hasNodeModules(server.cwd)) {
			const install = await vscode.window.showWarningMessage(
				`node_modules not found in ${vscode.workspace.asRelativePath(server.cwd)}. Install dependencies before starting the dev server?`,
				{ modal: true }, 'Install',
			);
			if (install !== 'Install') {
				return;
			}
			this._setStatus({ phase: 'starting', cwd: server.cwd, message: 'Installing dependencies…' });
			await this._runInTerminal(installCommand(server.packageManager), server.cwd, server.env);
		}

		this._setStatus({ phase: 'starting', cwd: server.cwd, command: server.command });

		if (server.knownUrl) {
			// .nova/devserver.json told us the URL directly — no need to detect it.
			await this._runInTerminal(server.command, server.cwd, server.env);
			await this._onUrlFound(server.knownUrl);
			return;
		}

		const execution = await this._runInTerminal(server.command, server.cwd, server.env);
		const url = await this._detectUrl(execution, server.expectedPort);
		if (url) {
			await this._onUrlFound(url);
		} else {
			this._setStatus({
				phase: 'error', cwd: server.cwd, command: server.command,
				message: `Started, but no local URL was detected within ${URL_DETECTION_TIMEOUT_MS / 1000}s. Check the "${TERMINAL_NAME}" terminal.`,
			});
		}
	}

	private async _onUrlFound(url: string): Promise<void> {
		this._setStatus({ ...this._status, phase: 'running', url });
		try {
			await this.novaBrowser.open(url, { reuse: true });
		} catch (error) {
			this._setStatus({ ...this._status, phase: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Runs `command` in the shared "Dev Server" terminal, preferring shell
	 * integration (needed to later read its output) and falling back to
	 * `sendText` if integration doesn't activate in time — matching the
	 * fallback pattern documented on `TerminalShellIntegration.executeCommand`.
	 */
	private async _runInTerminal(command: string, cwd: string, env: Record<string, string> | undefined): Promise<vscode.TerminalShellExecution | undefined> {
		if (!this._terminal || this._terminal.exitStatus !== undefined) {
			this._terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd, env });
		}
		this._terminal.show(true);

		if (this._terminal.shellIntegration) {
			return this._terminal.shellIntegration.executeCommand(command);
		}

		const integration = await this._waitForShellIntegration(this._terminal);
		if (integration) {
			return integration.executeCommand(command);
		}

		// No shell integration available (e.g. some remote/exotic shells) — we can
		// still run the command, we just can't read its output afterwards.
		this._terminal.sendText(command);
		return undefined;
	}

	private _waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
		return new Promise(resolve => {
			const timeout = setTimeout(() => {
				sub.dispose();
				resolve(undefined);
			}, SHELL_INTEGRATION_TIMEOUT_MS);
			const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
				if (e.terminal === terminal) {
					clearTimeout(timeout);
					sub.dispose();
					resolve(e.shellIntegration);
				}
			});
		});
	}

	/**
	 * Races reading the shell execution's own output (preferred: exact URL,
	 * host and port as printed) against TCP-polling the framework's expected
	 * port (fallback, used when there's no shell integration or the process
	 * doesn't print a recognizable URL banner).
	 */
	private async _detectUrl(execution: vscode.TerminalShellExecution | undefined, expectedPort: number | undefined): Promise<string | undefined> {
		const fromOutput = execution ? this._detectUrlFromOutput(execution) : Promise.resolve(undefined);
		const fromPolling = expectedPort ? this._pollPort('127.0.0.1', expectedPort) : Promise.resolve(undefined);
		const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), URL_DETECTION_TIMEOUT_MS));

		return firstDefined([fromOutput, fromPolling, timeout]);
	}

	private async _detectUrlFromOutput(execution: vscode.TerminalShellExecution): Promise<string | undefined> {
		try {
			for await (const chunk of execution.read()) {
				const found = findLocalUrl(chunk);
				if (found) {
					return `http://${found.host}:${found.port}/`;
				}
			}
		} catch {
			// Execution stream ended/errored — fall through to let polling/timeout decide.
		}
		return undefined;
	}

	private async _pollPort(host: string, port: number): Promise<string | undefined> {
		const deadline = Date.now() + URL_DETECTION_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await isPortOpen(host, port)) {
				return `http://${host}:${port}/`;
			}
			await new Promise(r => setTimeout(r, 1_000));
		}
		return undefined;
	}

	private _setStatus(status: IDevServerStatus): void {
		this._status = status;
		this._onDidChangeStatus.fire(status);
	}
}

function isPortOpen(host: string, port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host, port, timeout: 500 });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => resolve(false));
		socket.once('timeout', () => { socket.destroy(); resolve(false); });
	});
}

/** Resolves with the first promise that settles to a defined value, ignoring `undefined` results from the others. */
function firstDefined<T>(promises: Promise<T | undefined>[]): Promise<T | undefined> {
	return new Promise(resolve => {
		let remaining = promises.length;
		for (const p of promises) {
			p.then(value => {
				if (value !== undefined) {
					resolve(value);
				} else if (--remaining === 0) {
					resolve(undefined);
				}
			}).catch(() => {
				if (--remaining === 0) {
					resolve(undefined);
				}
			});
		}
	});
}
