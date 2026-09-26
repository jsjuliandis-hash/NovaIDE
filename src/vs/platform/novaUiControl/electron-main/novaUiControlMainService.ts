/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Main-process side of UI control: attaches the Electron debugger to the IDE window and relays
 *  a whitelist of DevTools commands, so agents can click and type in the real interface.
 *-------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { INovaUiControlService, NOVA_UI_CONTROL_ALLOWED_METHODS } from '../common/novaUiControl.js';

export const INovaUiControlMainService = createDecorator<INovaUiControlMainService>('novaUiControl');

export interface INovaUiControlMainService extends INovaUiControlService {
	readonly _serviceBrand: undefined;
}

const PROTOCOL_VERSION = '1.3';

export class NovaUiControlMainService extends Disposable implements INovaUiControlMainService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IWindowsMainService private readonly _windowsMainService: IWindowsMainService,
	) {
		super();
	}

	async cdp(windowId: number, method: string, params?: object): Promise<unknown> {
		if (!NOVA_UI_CONTROL_ALLOWED_METHODS.has(method)) {
			throw new Error(`DevTools method not allowed: ${method}`);
		}
		const contents = this._windowsMainService.getWindowById(windowId)?.win?.webContents;
		if (!contents || contents.isDestroyed()) {
			throw new Error(`IDE window ${windowId} not found`);
		}
		if (!contents.debugger.isAttached()) {
			contents.debugger.attach(PROTOCOL_VERSION);
		}
		return contents.debugger.sendCommand(method, params);
	}
}
