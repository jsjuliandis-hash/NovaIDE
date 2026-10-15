/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Registers external CLI agents that speak the Agent Client Protocol as chat session types,
 *  so they run in the background and talk through the Chat view.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentDefinition, AgentSessionProvider, clearChatAndAnnounceSummary } from './agentSessions';
import { RecentMetrics } from './requestMetrics';
import { SummaryStore } from './summaryStore';

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
		defaultVendor: 'anthropic',
		usageSemantics: 'request-sum'
	},
	{
		type: 'nova-codex',
		label: 'Codex CLI',
		settingsSection: 'nova.agents.codex',
		defaultCommand: 'npx',
		defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
		loginHint: 'codex login',
		icon: 'nova-logo-codex',
		defaultVendor: 'openai',
		usageSemantics: 'last-call'
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
	},
	{
		type: 'nova-nvidia',
		label: 'NVIDIA',
		settingsSection: 'nova.agents.nvidia',
		defaultCommand: 'opencode',
		defaultArgs: ['acp'],
		loginHint: '',
		icon: 'nova-logo-nvidia',
		defaultVendor: 'nvidia',
		gateway: 'nvidia'
	},
	{
		type: 'nova-openrouter',
		label: 'OpenRouter',
		settingsSection: 'nova.agents.openrouter',
		defaultCommand: 'opencode',
		defaultArgs: ['acp'],
		loginHint: '',
		icon: 'nova-logo-openrouter',
		defaultVendor: 'openrouter',
		gateway: 'openrouter'
	}
];

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Nova Agents', { log: true });
	context.subscriptions.push(log);
	const metrics = new RecentMetrics();
	const gatewayProviders: AgentSessionProvider[] = [];
	const providers = new Map<string, AgentSessionProvider>();
	const store = new SummaryStore(context.globalStorageUri);
	for (const agent of AGENTS) {
		const provider = new AgentSessionProvider(agent, context.secrets, log, metrics, store);
		context.subscriptions.push(provider);
		providers.set(agent.type, provider);
		if (agent.gateway) {
			gatewayProviders.push(provider);
		}
	}
	context.subscriptions.push(vscode.commands.registerCommand('novaAgentBridge.setApiKey', async () => {
		const picked = await vscode.window.showQuickPick(
			gatewayProviders.map(provider => ({ label: provider.label, provider })),
			{ title: vscode.l10n.t('Set API Key'), placeHolder: vscode.l10n.t('Choose the provider'), ignoreFocusOut: true }
		);
		await picked?.provider.askGatewayKey();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('novaAgentBridge.resumeSaved', () => resumeSaved(store, providers)));
	context.subscriptions.push(vscode.commands.registerCommand('novaAgentBridge.showLog', () => log.show()));
	context.subscriptions.push(vscode.commands.registerCommand('novaAgentBridge.exportMetrics', () => exportMetrics(metrics)));
}

/**
 * Lists the saved conversation summaries (newest first, filterable by code, title or agent) and opens a new chat of the
 * agent that wrote the one picked. The summary goes with the first message of that chat; no model call loads it.
 */
async function resumeSaved(store: SummaryStore, providers: ReadonlyMap<string, AgentSessionProvider>): Promise<void> {
	const saved = (await store.list()).filter(summary => providers.has(summary.agentType));
	if (!saved.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('There are no saved conversations yet. Use the Nova save button under an answer to save one.'));
		return;
	}
	const picked = await vscode.window.showQuickPick(saved.map(summary => ({
		label: `#${summary.code} ${summary.title}`,
		description: `${summary.provider} · ${summary.date.toLocaleString(vscode.env.language)}`,
		detail: summary.summary.replace(/^#+ .*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160),
		summary
	})), {
		title: vscode.l10n.t('Resume Saved Conversation'),
		placeHolder: vscode.l10n.t('Type a code, a title or an agent to filter'),
		matchOnDescription: true,
		matchOnDetail: false
	});
	if (!picked) {
		return;
	}
	const { summary } = picked;
	providers.get(summary.agentType)!.queueSummary(summary.summary, summary, new Map(Object.entries(summary.options)));
	// Switch to a chat of the agent that wrote the summary, then clear it, so the chat that gets the summary is always an empty one.
	await vscode.commands.executeCommand(`workbench.action.chat.openNewChatSessionInPlace.${summary.agentType}`, 'sidebar');
	await clearChatAndAnnounceSummary();
	void vscode.window.setStatusBarMessage(vscode.l10n.t('Saved conversation #{0} "{1}" loaded: your first message sends it to {2} along with it.', summary.code, summary.title, summary.provider), 15000);
}

/** Saves the metrics of the latest requests (sizes and counts only, no prompt text) to a JSON file the user picks. */
async function exportMetrics(metrics: RecentMetrics): Promise<void> {
	if (!metrics.size) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No agent requests were measured yet in this window.'));
		return;
	}
	const now = new Date();
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const name = `nova-agent-metrics-${now.toISOString().replace(/[:.]/g, '-')}.json`;
	const target = await vscode.window.showSaveDialog({
		title: vscode.l10n.t('Export Request Metrics'),
		defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
		filters: { JSON: ['json'] }
	});
	if (!target) {
		return;
	}
	await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(metrics.toExport(now), null, '\t')));
	void vscode.window.showInformationMessage(vscode.l10n.t('Saved the metrics of {0} requests to {1}.', metrics.size, target.fsPath));
}

export function deactivate(): void { }
