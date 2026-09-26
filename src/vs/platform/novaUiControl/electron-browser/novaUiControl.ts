/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Renderer proxy of the UI control service that runs in the main process.
 *-------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { INovaUiControlService } from '../common/novaUiControl.js';

registerMainProcessRemoteService(INovaUiControlService, 'novaUiControl');
