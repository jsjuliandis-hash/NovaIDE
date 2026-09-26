/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Internal commands the agent bridges (extension host) call right after an agent opens an
 *  editor or a terminal, so its tab gets the blue dot until the user sees it.
 *-------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INovaAgentTabsService } from '../../../services/novaAgentTabs/browser/novaAgentTabsService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

const STATUS_ID = 'nova-agent-opened';

/** Marks the editor that is active now, which is the one the agent just opened. */
CommandsRegistry.registerCommand('nova.agentTabs.markActiveEditor', accessor => {
	const editor = accessor.get(IEditorService).activeEditor;
	if (editor) {
		accessor.get(INovaAgentTabsService).mark(editor);
	}
});

/** Marks the newest terminal with the given title. The terminal is created by the extension host, so it may not exist yet. */
CommandsRegistry.registerCommand('nova.agentTabs.markTerminal', async (accessor, title: string) => {
	const terminalService = accessor.get(ITerminalService);
	const find = (): ITerminalInstance | undefined => terminalService.instances.filter(instance => instance.title === title).at(-1);

	let instance = find();
	for (let attempt = 0; !instance && attempt < 20; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		instance = find();
	}
	if (!instance || instance.statusList.statuses.some(status => status.id === STATUS_ID)) {
		return;
	}

	instance.statusList.add({ id: STATUS_ID, severity: Severity.Warning, icon: Codicon.zap, tooltip: localize('nova.agentTabs.terminal', "Opened by an agent") });
	const store = new DisposableStore();
	const clear = () => {
		instance.statusList.remove(STATUS_ID);
		store.dispose();
	};
	store.add(instance.onDidFocus(clear));
	store.add(instance.onDisposed(() => store.dispose()));
});
