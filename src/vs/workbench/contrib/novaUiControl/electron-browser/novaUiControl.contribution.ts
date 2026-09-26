/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Internal command the agent bridge (extension host) calls to reach the DevTools of this window.
 *-------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INovaUiControlService, NOVA_UI_CONTROL_CDP_COMMAND } from '../../../../platform/novaUiControl/common/novaUiControl.js';

CommandsRegistry.registerCommand(NOVA_UI_CONTROL_CDP_COMMAND, (accessor, method: string, params?: object) => {
	return accessor.get(INovaUiControlService).cdp(accessor.get(INativeHostService).windowId, method, params);
});
