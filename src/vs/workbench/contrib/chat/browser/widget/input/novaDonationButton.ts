/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Small "Donation" button above the chat input of the Chat view. It opens the Live Pix donation
 *  popup (command `nova.donation.show`, desktop only).
 *-------------------------------------------------------------------------------------------*/

import './media/novaDonationButton.css';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';

const SHOW_DONATION_COMMAND_ID = 'nova.donation.show';

/** Renders the button into `container`. Renders nothing where the donation popup does not exist (web). */
export function renderNovaDonationButton(container: HTMLElement, commandService: ICommandService, hoverService: IHoverService): IDisposable {
	const disposables = new DisposableStore();
	if (!CommandsRegistry.getCommand(SHOW_DONATION_COMMAND_ID)) {
		return disposables;
	}

	const row = append(container, $('.nova-donation-row'));
	const button = append(row, $('a.nova-donation-button', { role: 'button', tabIndex: 0 }));
	append(button, renderIcon(Codicon.heart));
	append(button, $('span', undefined, localize('nova.donation.button', "Donation")));
	disposables.add(hoverService.setupDelayedHover(button, { content: localize('nova.donation.buttonHover', "Support Nova IDE with a Pix donation") }));

	const open = (e: Event) => {
		EventHelper.stop(e, true);
		void commandService.executeCommand(SHOW_DONATION_COMMAND_ID);
	};
	disposables.add(addDisposableListener(button, EventType.CLICK, open));
	disposables.add(addDisposableListener(button, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		const event = new StandardKeyboardEvent(e);
		if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
			open(e);
		}
	}));
	disposables.add({ dispose: () => row.remove() });
	return disposables;
}
