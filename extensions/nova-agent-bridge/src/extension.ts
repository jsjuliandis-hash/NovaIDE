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
		loginHint: 'opencode auth login',
		icon: 'nova-logo-opencode',
		defaultVendor: 'opencode'
	},
	{
		type: 'nova-claude-code',
		label: 'Claude Code',
		settingsSection: 'nova.agents.claudeCode',
		defaultCommand: 'npx',
		defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
		loginHint: 'claude',
		icon: 'nova-logo-claude-code',
		defaultVendor: 'anthropic'
	},
	{
		type: 'nova-codex',
		label: 'Codex CLI',
		settingsSection: 'nova.agents.codex',
		defaultCommand: 'npx',
		defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
		loginHint: 'codex login',
		icon: 'nova-logo-codex',
		defaultVendor: 'openai'
	},
	{
		type: 'nova-gemini',
		label: 'Gemini CLI',
		settingsSection: 'nova.agents.gemini',
		defaultCommand: 'npx',
		defaultArgs: ['-y', '@google/gemini-cli', '--acp'],
		loginHint: 'gemini',
		icon: 'nova-logo-gemini-cli',
		defaultVendor: 'google'
	}
];

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Nova Agents', { log: true });
	context.subscriptions.push(log);
	for (const agent of AGENTS) {
		context.subscriptions.push(new AgentSessionProvider(agent, context.secrets, log));
	}
	context.subscriptions.push(vscode.commands.registerCommand('novaAgentBridge.showLog', () => log.show()));
}

export function deactivate(): void { }
