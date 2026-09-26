/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  UI control: lets the agent bridge drive the IDE window itself (click, type, press keys,
 *  screenshots) through the Chrome DevTools Protocol of the window's web contents.
 *-------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const INovaUiControlService = createDecorator<INovaUiControlService>('novaUiControl');

/** Command the extension host calls; it forwards to {@link INovaUiControlService.cdp} for its own window. */
export const NOVA_UI_CONTROL_CDP_COMMAND = 'nova.uiControl.cdp';

/** The only DevTools methods the bridge may call: enough to inspect, click, type and capture the window. */
export const NOVA_UI_CONTROL_ALLOWED_METHODS: ReadonlySet<string> = new Set([
	'Runtime.evaluate',
	'Input.dispatchMouseEvent',
	'Input.dispatchKeyEvent',
	'Input.insertText',
	'Page.captureScreenshot',
]);

export interface INovaUiControlService {
	readonly _serviceBrand: undefined;

	/** Sends a DevTools command to the web contents of the IDE window `windowId` and returns its result. */
	cdp(windowId: number, method: string, params?: object): Promise<unknown>;
}
