/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Reads new chat answers aloud by themselves, in the chat tabs where the user turned it on.
 *  The choice is per tab; the default for tabs without a choice is the `nova.tts.autoSpeak` setting.
 *-------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../browser/chat.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { readChatResponseAloud } from '../actions/voiceChatActions.js';
import { INovaTextToSpeechService, NovaAutoSpeakOn, NovaTtsSettingId } from './novaTextToSpeechService.js';

/** How long to wait for the answer of a request to exist before giving up. */
const RESPONSE_WAIT_MS = 15_000;

export class NovaAutoSpeakContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.novaAutoSpeak';

	/** Context key of each chat widget that shows the automatic speech toggle. */
	private readonly _keys = new Map<IChatWidget, IContextKey<boolean>>();

	constructor(
		@IChatService private readonly _chatService: IChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@INovaTextToSpeechService private readonly _speech: INovaTextToSpeechService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._register(this._chatService.onDidSubmitRequest(e => this._onSubmit(e.chatSessionResource)));

		// Keep the toggle's on/off state right in every chat widget, whichever tab it shows.
		for (const widget of this._chatWidgetService.getAllWidgets()) {
			this._track(widget);
		}
		this._register(this._chatWidgetService.onDidAddWidget(widget => this._track(widget)));
		this._register(this._speech.onDidChangeAutoSpeak(() => this._updateAll()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(NovaTtsSettingId.AutoSpeak)) {
				this._updateAll();
			}
		}));
	}

	private _track(widget: IChatWidget): void {
		if (this._keys.has(widget)) {
			return;
		}
		const store = this._register(new DisposableStore());
		this._keys.set(widget, NovaAutoSpeakOn.bindTo(widget.scopedContextKeyService));
		store.add(widget.onDidChangeViewModel(() => this._update(widget)));
		this._update(widget);
	}

	private _update(widget: IChatWidget): void {
		const sessionResource = widget.viewModel?.sessionResource;
		this._keys.get(widget)?.set(!!sessionResource && this._speech.isAutoSpeakEnabled(sessionResource));
	}

	private _updateAll(): void {
		for (const widget of this._keys.keys()) {
			this._update(widget);
		}
	}

	private async _onSubmit(sessionResource: URI): Promise<void> {
		if (!this._speech.isAutoSpeakEnabled(sessionResource)) {
			return;
		}
		const model = this._chatService.getSession(sessionResource);
		const request = model?.lastRequest;
		if (!model || !request) {
			return;
		}
		if (!request.response) {
			await raceTimeout(Event.toPromise(Event.filter(model.onDidChange, () => !!request.response)), RESPONSE_WAIT_MS);
		}
		const response = request.response;
		// The user may have turned it off while the answer was being prepared.
		if (response && this._speech.isAutoSpeakEnabled(sessionResource)) {
			this._instantiationService.invokeFunction(accessor => readChatResponseAloud(accessor, response));
		}
	}
}
