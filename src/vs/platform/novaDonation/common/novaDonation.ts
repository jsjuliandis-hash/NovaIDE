/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Donation popup (Live Pix) shown when the application starts.
 *-------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const INovaDonationService = createDecorator<INovaDonationService>('novaDonation');

/** Live Pix donation widget of the Nova IDE project. */
export const NOVA_DONATION_URL = 'https://widget.livepix.gg/embed/376b5a28-01ab-47ea-9a31-45ff13d2dace';

/** Hosts the donation popup may navigate to. Anything else opens in the system browser. */
export const NOVA_DONATION_HOST_SUFFIX = 'livepix.gg';

export const enum NovaDonationSettingId {
	ShowOnStartup = 'nova.donation.showOnStartup',
}

export interface INovaDonationService {
	readonly _serviceBrand: undefined;

	/** Opens the donation popup, or focuses it when it is already open. */
	show(): Promise<void>;
}
