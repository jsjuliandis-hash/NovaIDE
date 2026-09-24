/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Registers external CLI agents that speak the Agent Client Protocol as chat session types,
 *  so they run in the background and talk through the Chat view.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentDefinition, AgentSessionProvider } from './agentSessions';

const AGENTS: readonly AgentDefinition[] = [
	{
		type: 'nova-opencode',
		label: 'OpenCode',
		settingsSection: 'nova.agents.opencode',
		defaultCommand: 'opencode',
		defaultArgs: ['acp'],
		loginHint: 'opencode auth login'
	}
];

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Nova Agents', { log: true });
	context.subscriptions.push(log);
	for (const agent of AGENTS) {
		context.subscriptions.push(new AgentSessionProvider(agent, log));
	}
	context.subscriptions.push(vscode.commands.registerCommand('novaAgentBridge.showLog', () => log.show()));
}

export function deactivate(): void { }
