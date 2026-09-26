/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  ACP terminal methods (terminal/create, output, wait_for_exit, kill, release). Each command an
 *  agent runs shows up in a real IDE terminal, while its output is captured for the agent.
 *  The agent asks for permission (session/request_permission) before it runs a command, so no
 *  second prompt is shown here.
 *-------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';

export interface AcpTerminalExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

export interface AcpTerminalOutput {
	readonly output: string;
	readonly truncated: boolean;
	readonly exitStatus?: AcpTerminalExit;
}

export interface AcpTerminalCreateParams {
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: readonly { readonly name: string; readonly value: string }[];
	readonly cwd?: string | null;
	readonly outputByteLimit?: number | null;
}

/** Output kept when the agent sets no limit. */
const DEFAULT_OUTPUT_LIMIT = 1_000_000;

class AcpTerminal implements vscode.Pseudoterminal {

	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidClose = this.closeEmitter.event;

	private readonly child: ChildProcess;
	private output = '';
	private truncated = false;
	private exit: AcpTerminalExit | undefined;
	private readonly exitWaiters: (() => void)[] = [];
	private readonly terminal: vscode.Terminal;

	constructor(params: AcpTerminalCreateParams, private readonly outputLimit: number) {
		const env = { ...process.env, ...Object.fromEntries((params.env ?? []).map(variable => [variable.name, variable.value])) };
		// npm-installed tools are .cmd shims on Windows, which need a shell to start.
		this.child = spawn(params.command, [...(params.args ?? [])], { cwd: params.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'], env });
		this.child.stdout!.on('data', (chunk: Buffer) => this.append(chunk.toString('utf8')));
		this.child.stderr!.on('data', (chunk: Buffer) => this.append(chunk.toString('utf8')));
		this.child.on('error', error => this.append(`${error.message}\n`));
		this.child.on('close', (code, signal) => {
			this.exit = { exitCode: code, signal };
			this.writeEmitter.fire(`\r\n\x1b[2m[${vscode.l10n.t('Process exited with code {0}', String(code))}]\x1b[0m\r\n`);
			this.exitWaiters.splice(0).forEach(resolve => resolve());
		});
		const commandLine = [params.command, ...(params.args ?? [])].join(' ');
		this.terminal = vscode.window.createTerminal({ name: `Agent: ${commandLine.length > 30 ? `${commandLine.slice(0, 30)}…` : commandLine}`, pty: this });
		this.terminal.show(true);
	}

	open(): void { /* the process is started by the constructor */ }

	close(): void {
		this.kill();
	}

	/** Keystrokes typed by the user into the terminal go to the process. */
	handleInput(data: string): void {
		this.child.stdin?.write(data);
	}

	kill(): void {
		if (this.exit) {
			return;
		}
		if (this.child.pid !== undefined && process.platform === 'win32') {
			// With shell: true the command is a grandchild of cmd.exe; kill the whole tree.
			spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			this.child.kill();
		}
	}

	waitForExit(): Promise<AcpTerminalExit> {
		if (this.exit) {
			return Promise.resolve(this.exit);
		}
		return new Promise(resolve => this.exitWaiters.push(() => resolve(this.exit!)));
	}

	snapshot(): AcpTerminalOutput {
		return { output: this.output, truncated: this.truncated, ...(this.exit ? { exitStatus: this.exit } : {}) };
	}

	/** Stops the process and closes the terminal tab. */
	release(): void {
		this.kill();
		this.terminal.dispose();
	}

	private append(text: string): void {
		this.output += text;
		const bytes = Buffer.byteLength(this.output, 'utf8');
		if (bytes > this.outputLimit) {
			// Drop from the start, on a character boundary, until the output fits again.
			let excess = bytes - this.outputLimit;
			let cut = 0;
			while (excess > 0 && cut < this.output.length) {
				excess -= Buffer.byteLength(this.output[cut], 'utf8');
				cut++;
			}
			this.output = this.output.slice(cut);
			this.truncated = true;
		}
		this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
	}
}

/** The terminals one ACP connection created, by the id the agent got. */
export class AcpTerminals {

	private readonly terminals = new Map<string, AcpTerminal>();
	private nextId = 1;

	create(params: AcpTerminalCreateParams): { terminalId: string } {
		const terminalId = `nova-term-${this.nextId++}`;
		this.terminals.set(terminalId, new AcpTerminal(params, params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT));
		return { terminalId };
	}

	output(terminalId: string): AcpTerminalOutput {
		return this.get(terminalId).snapshot();
	}

	waitForExit(terminalId: string): Promise<AcpTerminalExit> {
		return this.get(terminalId).waitForExit();
	}

	kill(terminalId: string): null {
		this.get(terminalId).kill();
		return null;
	}

	release(terminalId: string): null {
		this.terminals.get(terminalId)?.release();
		this.terminals.delete(terminalId);
		return null;
	}

	/** Called when the agent process goes away: nothing it started should keep running. */
	dispose(): void {
		for (const terminal of this.terminals.values()) {
			terminal.release();
		}
		this.terminals.clear();
	}

	private get(terminalId: string): AcpTerminal {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) {
			throw new Error(`Unknown terminal ${terminalId}`);
		}
		return terminal;
	}
}
