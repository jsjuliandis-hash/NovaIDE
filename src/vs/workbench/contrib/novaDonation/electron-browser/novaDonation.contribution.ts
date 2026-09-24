/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Donation popup (Live Pix): the setting that shows it at startup and a command to open it any
 *  time. The popup itself is a window of the main process (platform/novaDonation).
 *-------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INovaDonationService, NovaDonationSettingId } from '../../../../platform/novaDonation/common/novaDonation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[NovaDonationSettingId.ShowOnStartup]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('nova.donation.showOnStartup', "Show the invitation to support Nova IDE with a donation (Live Pix) when the application starts. The command **Support Nova IDE** opens it at any time."),
		},
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'nova.donation.show',
			title: localize2('nova.donation.show', "Support Nova IDE"),
			category: Categories.Help,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(INovaDonationService).show();
	}
});
