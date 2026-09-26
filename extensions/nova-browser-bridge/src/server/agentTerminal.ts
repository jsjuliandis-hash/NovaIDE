/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Commands the agent runs in a real, visible IDE terminal. The process is spawned here and its
 *  output is both shown in the terminal and captured, so the agent gets the result back.
 *-------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { markTerminalOpenedByAgent } from '../agentTabs';

/** Most output kept per command; older output is dropped so a chatty process cannot exhaust memory. */
const MAX_OUTPUT_CHARS = 200_000;

/** Finished agent terminals kept open for the user to read; older ones are closed. */
const MAX_FINISHED_TERMINALS = 5;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export interface TerminalReport {
	readonly terminalId: string;
	/** Output not returned by an earlier call, with control sequences removed. */
	readonly output: string;
	readonly running: boolean;
	readonly exitCode: number | undefined;
}

let nextTerminalId = 1;
const terminals = new Map<string, AgentTerminal>();
const finishedOrder: string[] = [];

class AgentTerminal implements vscode.Pseudoterminal {

	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidClose = this.closeEmitter.event;

	private readonly child: ChildProcess;
	private output = '';
	private reported = 0;
	private exitCode: number | undefined;
	private exited = false;
	private readonly exitWaiters: (() => void)[] = [];
	readonly terminal: vscode.Terminal;

	constructor(readonly id: string, command: string, cwd: string | undefined) {
		// `shell: true` runs the line the way the platform shell would (cmd.exe on Windows).
		this.child = spawn(command, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
		this.child.stdout!.on('data', (chunk: Buffer) => this.append(chunk.toString('utf8')));
		this.child.stderr!.on('data', (chunk: Buffer) => this.append(chunk.toString('utf8')));
		this.child.on('error', error => this.append(`${error.message}\n`));
		this.child.on('close', code => {
			this.exitCode = code ?? undefined;
			this.exited = true;
			this.writeEmitter.fire(`\r\n\x1b[2m[${vscode.l10n.t('Process exited with code {0}', String(code))}]\x1b[0m\r\n`);
			this.exitWaiters.splice(0).forEach(resolve => resolve());
			this.noteFinished();
		});
		const name = `Agent: ${command.length > 30 ? `${command.slice(0, 30)}…` : command}`;
		this.terminal = vscode.window.createTerminal({ name, pty: this });
		this.terminal.show(true);
		markTerminalOpenedByAgent(name);
	}

	open(): void { /* the process is started by the constructor */ }

	close(): void {
		this.kill();
		terminals.delete(this.id);
	}

	/** Keystrokes typed by the user into the terminal go to the process. */
	handleInput(data: string): void {
		this.sendText(data);
	}

	sendText(text: string): void {
		this.child.stdin?.write(text);
	}

	kill(): void {
		if (this.exited) {
			return;
		}
		if (this.child.pid !== undefined && process.platform === 'win32') {
			// With shell: true the command is a grandchild of cmd.exe; kill the whole tree.
			spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			this.child.kill();
		}
	}

	get finished(): boolean {
		return this.exited;
	}

	/** Resolves when the process ends or `timeoutMs` passes, whichever is first. */
	waitForExit(timeoutMs: number): Promise<void> {
		if (this.exited) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			const timer = setTimeout(resolve, timeoutMs);
			this.exitWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	report(): TerminalReport {
		const fresh = this.output.slice(this.reported);
		this.reported = this.output.length;
		return { terminalId: this.id, output: fresh.replace(ANSI_PATTERN, ''), running: !this.exited, exitCode: this.exitCode };
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private append(text: string): void {
		this.output += text;
		if (this.output.length > MAX_OUTPUT_CHARS) {
			const dropped = this.output.length - MAX_OUTPUT_CHARS;
			this.output = this.output.slice(dropped);
			this.reported = Math.max(0, this.reported - dropped);
		}
		this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
	}

	private noteFinished(): void {
		finishedOrder.push(this.id);
		while (finishedOrder.length > MAX_FINISHED_TERMINALS) {
			terminals.get(finishedOrder.shift()!)?.dispose();
		}
	}
}

/** Starts `command` in a new visible terminal and waits up to `timeoutMs` for it to end. */
export async function runInTerminal(command: string, cwd: string | undefined, timeoutMs: number): Promise<TerminalReport> {
	const terminal = new AgentTerminal(`term-${nextTerminalId++}`, command, cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
	terminals.set(terminal.id, terminal);
	await terminal.waitForExit(timeoutMs);
	return terminal.report();
}

function getTerminal(terminalId: string): AgentTerminal {
	const terminal = terminals.get(terminalId);
	if (!terminal) {
		throw new Error(`Unknown terminal ${terminalId}. It was closed, or it was not started by ide_terminal_run.`);
	}
	return terminal;
}

/** Output produced since the last report of this terminal, optionally after waiting for it to end. */
export async function readTerminal(terminalId: string, waitMs: number): Promise<TerminalReport> {
	const terminal = getTerminal(terminalId);
	await terminal.waitForExit(waitMs);
	return terminal.report();
}

/** Writes text to the standard input of a terminal started by the agent. */
export function sendToTerminal(terminalId: string, text: string): void {
	const terminal = getTerminal(terminalId);
	if (terminal.finished) {
		throw new Error(`Terminal ${terminalId} has already finished.`);
	}
	terminal.sendText(text);
}

export function killTerminal(terminalId: string): void {
	getTerminal(terminalId).kill();
}
