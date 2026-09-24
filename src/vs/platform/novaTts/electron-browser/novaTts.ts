/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Renderer proxy of the text to speech service that runs in the main process.
 *-------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { INovaTtsService } from '../common/novaTts.js';

registerMainProcessRemoteService(INovaTtsService, 'novaTts');
