/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  The row above the chat input of the Chat view: an Integrated Browser button on the left, followed by a saved-conversations button (lists the summaries saved by Nova save); the browser one opens
 *  the browser, or lists its tabs when one is open) and a small "Donation" button on the right that
 *  opens the Live Pix donation popup (command `nova.donation.show`). Both exist on desktop only.
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
import { novaBrowserIcon } from '../../../../../common/novaBrowserIcon.js';

const SHOW_DONATION_COMMAND_ID = 'nova.donation.show';
/** BrowserViewCommandId.OpenOrList: opens the Integrated Browser, or lists its tabs when one is open. */
const OPEN_BROWSER_COMMAND_ID = 'workbench.action.browser.openOrList';
/** nova-agent-bridge: lists the saved conversation summaries and starts a chat from the one picked. */
const RESUME_SAVED_COMMAND_ID = 'novaAgentBridge.resumeSaved';

/** Renders the row into `container`. Renders nothing where neither command exists (web). */
export function renderNovaInputRow(container: HTMLElement, commandService: ICommandService, hoverService: IHoverService): IDisposable {
	const disposables = new DisposableStore();
	const hasBrowser = !!CommandsRegistry.getCommand(OPEN_BROWSER_COMMAND_ID);
	const hasDonation = !!CommandsRegistry.getCommand(SHOW_DONATION_COMMAND_ID);
	if (!hasBrowser && !hasDonation) {
		return disposables;
	}

	const row = append(container, $('.nova-donation-row'));
	disposables.add({ dispose: () => row.remove() });
	if (hasBrowser) {
		// The left group keeps the buttons together and pushes the donation button to the right.
		const left = append(row, $('.nova-left-buttons'));
		const button = append(left, $('a.nova-browser-button', { role: 'button', tabIndex: 0, 'aria-label': localize('nova.browserButton.label', "Open Integrated Browser") }));
		append(button, renderIcon(novaBrowserIcon));
		disposables.add(hoverService.setupDelayedHover(button, { content: localize('nova.browserButton.hover', "Open the Integrated Browser") }));
		addButtonHandler(disposables, button, () => commandService.executeCommand(OPEN_BROWSER_COMMAND_ID));

		const saved = append(left, $('a.nova-saved-button', { role: 'button', tabIndex: 0, 'aria-label': localize('nova.savedButton.label', "Resume Saved Conversation") }));
		append(saved, renderIcon(Codicon.history));
		disposables.add(hoverService.setupDelayedHover(saved, { content: localize('nova.savedButton.hover', "Saved conversations: pick one to continue from its summary") }));
		addButtonHandler(disposables, saved, () => commandService.executeCommand(RESUME_SAVED_COMMAND_ID));
	}
	if (hasDonation) {
		const button = append(row, $('a.nova-donation-button', { role: 'button', tabIndex: 0 }));
		append(button, renderIcon(Codicon.heart));
		append(button, $('span', undefined, localize('nova.donation.button', "Donation")));
		disposables.add(hoverService.setupDelayedHover(button, { content: localize('nova.donation.buttonHover', "Support Nova IDE with a Pix donation") }));
		addButtonHandler(disposables, button, () => commandService.executeCommand(SHOW_DONATION_COMMAND_ID));
	}
	return disposables;
}

/** Runs `action` on click, Enter and Space. */
function addButtonHandler(disposables: DisposableStore, button: HTMLElement, action: () => Promise<unknown>): void {
	const run = (e: Event) => {
		EventHelper.stop(e, true);
		void action();
	};
	disposables.add(addDisposableListener(button, EventType.CLICK, run));
	disposables.add(addDisposableListener(button, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		const event = new StandardKeyboardEvent(e);
		if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
			run(e);
		}
	}));
}
