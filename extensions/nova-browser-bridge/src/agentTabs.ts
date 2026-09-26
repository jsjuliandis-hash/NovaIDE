import * as vscode from 'vscode';

/**
 * Tells Nova IDE that an agent just opened an editor or a terminal, so its tab gets the blue dot
 * until the user sees it. The commands live in the core (`nova.agentTabs.*`); a failure here must
 * never break the tool that opened the tab.
 */

/** Marks the editor that is active now; call it right after the agent's tool opened (and focused) an editor. */
export function markActiveEditorOpenedByAgent(): void {
	void Promise.resolve(vscode.commands.executeCommand('nova.agentTabs.markActiveEditor')).then(undefined, () => undefined);
}

/** Marks the terminal with this name, which the agent just created. */
export function markTerminalOpenedByAgent(name: string): void {
	void Promise.resolve(vscode.commands.executeCommand('nova.agentTabs.markTerminal', name)).then(undefined, () => undefined);
}
