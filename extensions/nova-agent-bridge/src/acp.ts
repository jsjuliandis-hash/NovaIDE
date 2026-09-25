/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Agent Client Protocol (ACP) client: runs an external CLI agent (e.g. `opencode acp`) as a
 *  child process and talks JSON-RPC 2.0 to it over newline-delimited stdio.
 *-------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';

/**
 * Minimal Agent Client Protocol (ACP) types used by Nova. The protocol is JSON-RPC 2.0 over
 * newline-delimited stdio. See https://agentclientprotocol.com.
 */
export interface AcpConfigOption {
	readonly id: string;
	readonly name: string;
	readonly category?: string;
	readonly type: string;
	readonly currentValue?: string;
	readonly options?: readonly { readonly value: string; readonly name: string; readonly description?: string }[];
}

export interface AcpNewSessionResult {
	readonly sessionId: string;
	readonly configOptions?: readonly AcpConfigOption[];
	/** Older ACP session modes (set with `session/set_mode`). */
	readonly modes?: { readonly currentModeId?: string; readonly availableModes?: readonly { readonly id: string; readonly name: string; readonly description?: string }[] };
	/** Unstable ACP session models (set with `session/set_model`). */
	readonly models?: { readonly currentModelId?: string; readonly availableModels?: readonly { readonly modelId: string; readonly name: string; readonly description?: string }[] };
}

export interface AcpPromptResult {
	readonly stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;
}

export type AcpContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'resource_link'; readonly uri: string; readonly name: string };

export interface AcpToolCallContent {
	readonly type: string;
	readonly content?: { readonly type: string; readonly text?: string };
	readonly path?: string;
}

/** A slash command the agent accepts (`available_commands_update`), e.g. a skill or a custom command from `~/.claude/commands`. */
export interface AcpAvailableCommand {
	readonly name: string;
	readonly description?: string;
	readonly input?: { readonly hint?: string } | null;
}

export interface AcpSessionUpdate {
	readonly sessionUpdate: string;
	readonly availableCommands?: readonly AcpAvailableCommand[];
	readonly messageId?: string;
	readonly content?: { readonly type: string; readonly text?: string };
	readonly toolCallId?: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	readonly locations?: readonly { readonly path: string; readonly line?: number }[];
	readonly entries?: readonly { readonly content: string; readonly status: string }[];
	readonly configOptions?: readonly AcpConfigOption[];
	readonly used?: number;
	readonly size?: number;
	readonly cost?: { readonly amount: number; readonly currency: string };
}

export interface AcpPermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface AcpRequestHandlers {
	requestPermission(params: { sessionId: string; toolCall: { title?: string; kind?: string; locations?: readonly { path: string }[] }; options: readonly AcpPermissionOption[] }): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }>;
	readTextFile(params: { sessionId: string; path: string; line?: number; limit?: number }): Promise<{ content: string }>;
	writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<null>;
}

export interface AcpAuthMethod {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly _meta?: { readonly 'api-key'?: { readonly provider?: string } };
}

export class AcpError extends Error {
	constructor(message: string, readonly code: number | undefined, readonly data: unknown) {
		super(message);
	}
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/**
 * One running ACP agent process. Sessions are multiplexed over the same process.
 */
export class AcpConnection implements vscode.Disposable {

	private readonly process: ChildProcess;
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 0;
	private buffer = '';
	private exited = false;

	private readonly onDidUpdateEmitter = new vscode.EventEmitter<{ sessionId: string; update: AcpSessionUpdate }>();
	readonly onDidUpdate = this.onDidUpdateEmitter.event;

	private readonly onDidExitEmitter = new vscode.EventEmitter<number | null>();
	readonly onDidExit = this.onDidExitEmitter.event;

	private constructor(command: string, args: readonly string[], cwd: string | undefined, env: Record<string, string>, private readonly handlers: AcpRequestHandlers, private readonly log: vscode.LogOutputChannel) {
		// npm-installed agents are .cmd shims on Windows, which need a shell to start.
		this.process = spawn(command, [...args], { cwd, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
		this.process.stdout!.setEncoding('utf8');
		this.process.stdout!.on('data', (chunk: string) => this.onData(chunk));
		this.process.stderr!.setEncoding('utf8');
		this.process.stderr!.on('data', (chunk: string) => this.log.trace(`[stderr] ${chunk.trimEnd()}`));
		this.process.on('error', error => this.fail(error));
		this.process.on('exit', code => {
			this.log.info(`agent process exited with code ${code}`);
			this.fail(new Error(vscode.l10n.t('The agent process exited (code {0}).', String(code))));
			this.onDidExitEmitter.fire(code);
		});
	}

	static async start(command: string, args: readonly string[], cwd: string | undefined, env: Record<string, string>, handlers: AcpRequestHandlers, log: vscode.LogOutputChannel): Promise<{ connection: AcpConnection; agentName: string | undefined; authMethods: readonly AcpAuthMethod[] }> {
		const connection = new AcpConnection(command, args, cwd, env, handlers, log);
		try {
			const result = await connection.request<{ agentInfo?: { name?: string; version?: string }; authMethods?: AcpAuthMethod[] }>('initialize', {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
				clientInfo: { name: 'nova-ide', title: 'Nova IDE', version: vscode.version }
			});
			log.info(`connected to ${result.agentInfo?.name ?? command} ${result.agentInfo?.version ?? ''}`);
			return { connection, agentName: result.agentInfo?.name, authMethods: result.authMethods ?? [] };
		} catch (error) {
			connection.dispose();
			throw error;
		}
	}

	get isAlive(): boolean {
		return !this.exited;
	}

	request<T>(method: string, params: unknown): Promise<T> {
		if (this.exited) {
			return Promise.reject(new Error(vscode.l10n.t('The agent process is not running.')));
		}
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as T), reject });
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.exited) {
			this.write({ jsonrpc: '2.0', method, params });
		}
	}

	dispose(): void {
		this.fail(new Error(vscode.l10n.t('The agent connection was closed.')));
		if (this.process.pid !== undefined && process.platform === 'win32') {
			// With shell: true the agent is a grandchild of the shell; kill the whole tree.
			spawn('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			this.process.kill();
		}
		this.onDidUpdateEmitter.dispose();
		this.onDidExitEmitter.dispose();
	}

	private write(message: unknown): void {
		const line = JSON.stringify(message);
		this.log.trace(`>> ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`);
		this.process.stdin!.write(line + '\n');
	}

	private fail(error: Error): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		for (const request of this.pending.values()) {
			request.reject(error);
		}
		this.pending.clear();
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				this.onMessage(line);
			}
		}
	}

	private onMessage(line: string): void {
		this.log.trace(`<< ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`);
		let message: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
		try {
			message = JSON.parse(line);
		} catch {
			this.log.warn(`ignoring non-JSON output: ${line}`);
			return;
		}

		if (message.method !== undefined && message.id !== undefined) {
			void this.handleAgentRequest(message.id, message.method, message.params);
		} else if (message.method !== undefined) {
			if (message.method === 'session/update' && message.params?.sessionId && message.params.update) {
				this.onDidUpdateEmitter.fire({ sessionId: message.params.sessionId, update: message.params.update });
			}
		} else if (typeof message.id === 'number') {
			const pending = this.pending.get(message.id);
			if (pending) {
				this.pending.delete(message.id);
				if (message.error) {
					pending.reject(new AcpError(message.error.message ?? 'ACP error', message.error.code, message.error.data));
				} else {
					pending.resolve(message.result);
				}
			}
		}
	}

	private async handleAgentRequest(id: number | string, method: string, params: any): Promise<void> {
		try {
			let result: unknown;
			switch (method) {
				case 'session/request_permission':
					result = await this.handlers.requestPermission(params);
					break;
				case 'fs/read_text_file':
					result = await this.handlers.readTextFile(params);
					break;
				case 'fs/write_text_file':
					result = await this.handlers.writeTextFile(params);
					break;
				default:
					this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
					return;
			}
			this.write({ jsonrpc: '2.0', id, result });
		} catch (error) {
			this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
		}
	}
}
