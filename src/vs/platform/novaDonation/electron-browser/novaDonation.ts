/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Renderer proxy of the donation popup service that runs in the main process.
 *-------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { INovaDonationService } from '../common/novaDonation.js';

registerMainProcessRemoteService(INovaDonationService, 'novaDonation');
