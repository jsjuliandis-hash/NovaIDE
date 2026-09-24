/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Donation popup (Live Pix) shown when the application starts.
 *-------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const INovaDonationService = createDecorator<INovaDonationService>('novaDonation');

export const enum NovaDonationSettingId {
	ShowOnStartup = 'nova.donation.showOnStartup',
}

export interface INovaDonationService {
	readonly _serviceBrand: undefined;

	/** Opens the donation popup, or focuses it when it is already open. */
	show(): Promise<void>;
}
