/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Chat tabs: the Chat view keeps several sessions open at once (for example Claude Code
 *  planning in one tab while OpenCode executes in another). The view still has a single
 *  ChatWidget; each tab holds a reference to its session so it stays alive, and keeps running,
 *  while another tab is shown. The tab strip is a row at the top of the view.
 *-------------------------------------------------------------------------------------------*/

import './media/chatViewTabs.css';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { KeyCode, KeyMod } from '../../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import Severity from '../../../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI, UriComponents } from '../../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IView } from '../../../../../common/views.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { IChatModelReference, IChatService } from '../../../common/chatService/chatService.js';
import { IChatSessionProviderOptionItem, IChatSessionsService, localChatSessionType } from '../../../common/chatSessionsService.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { getChatSessionType, isUntitledChatSession } from '../../../common/model/chatUri.js';
import { ChatViewId } from '../../chat.js';

/** What the tabs need from the Chat view that hosts them. */
export interface IChatViewTabsDelegate {
	/** Shows an existing session in the view's widget. */
	loadSession(resource: URI): Promise<unknown>;
	/** Starts a new session (of the default session type) in the view's widget. */
	newSession(): Promise<unknown>;
}

/** Implemented by the Chat view so commands can reach its tabs. */
export interface IChatViewTabsHost {
	readonly chatTabs: ChatViewTabs | undefined;
}

export interface IChatViewTab {
	readonly id: number;
	/** Session shown in the tab; `undefined` until the tab's first session is created. */
	resource: URI | undefined;
	/** Resources the session was committed to (untitled → real) while the tab held it. */
	aliases: URI[];
	title: string | undefined;
	running: boolean;
	needsInput: boolean;
	/** The session finished a request while the tab was not active. */
	unseen: boolean;
	readonly ref: MutableDisposable<IChatModelReference>;
	readonly modelListeners: MutableDisposable<DisposableStore>;
}

interface IStoredChatViewTabs {
	readonly tabs: readonly { readonly resource?: UriComponents; readonly title?: string }[];
	readonly active: number;
}

const STORAGE_KEY = 'nova.chat.viewTabs';

export class ChatViewTabs extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _tabs: IChatViewTab[] = [];
	private _active = 0;
	private nextId = 1;

	constructor(
		private readonly delegate: IChatViewTabsDelegate,
		restore: boolean,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IStorageService private readonly storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();

		if (restore) {
			this.restore();
		}

		this._register(this.chatSessionsService.onDidCommitSession(e => {
			for (const tab of this._tabs) {
				if (this.matches(tab, e.original)) {
					tab.aliases.push(e.committed);
				}
			}
		}));
		this._register(this.chatSessionsService.onDidChangeSessionOptions(e => {
			if (this._tabs.some(tab => this.matches(tab, e.sessionResource))) {
				this._onDidChange.fire();
			}
		}));
		this._register(this.storageService.onWillSaveState(() => this.save()));
		this._register({ dispose: () => this._tabs.forEach(tab => this.disposeTab(tab)) });
	}

	get tabs(): readonly IChatViewTab[] {
		return this._tabs;
	}

	get activeIndex(): number {
		return this._active;
	}

	/**
	 * Called whenever the view's widget shows another session. The session becomes the active
	 * tab's session, unless another tab already has it — then that tab becomes active.
	 */
	onDidShowSession(model: IChatModel | undefined): void {
		if (!model) {
			return; // transient state while a session loads
		}

		let index = this._tabs.findIndex(tab => this.matches(tab, model.sessionResource));
		if (index < 0) {
			if (!this._tabs.length) {
				this._tabs.push(this.createTab(undefined, undefined));
				this._active = 0;
			}
			index = this._active;
			const tab = this._tabs[index];
			tab.aliases = [];
			tab.unseen = false;
		}

		this._active = index;
		const tab = this._tabs[index];
		tab.resource = model.sessionResource;
		tab.unseen = false;
		this.bind(tab, model);
		this._onDidChange.fire();
	}

	async activate(index: number): Promise<void> {
		const tab = this._tabs[index];
		if (!tab) {
			return;
		}
		this._active = index;
		tab.unseen = false;
		this._onDidChange.fire();

		if (tab.resource) {
			await this.delegate.loadSession(tab.resource);
		} else {
			await this.delegate.newSession();
		}
	}

	async activateRelative(offset: number): Promise<void> {
		if (this._tabs.length > 1) {
			await this.activate((this._active + offset + this._tabs.length) % this._tabs.length);
		}
	}

	async newTab(): Promise<void> {
		this._tabs.push(this.createTab(undefined, undefined));
		this._active = this._tabs.length - 1;
		this._onDidChange.fire();
		await this.delegate.newSession();
	}

	async close(index: number): Promise<void> {
		const tab = this._tabs[index];
		if (!tab) {
			return;
		}

		const model = tab.ref.value?.object;
		if (model?.requestInProgress.get()) {
			const { result } = await this.dialogService.prompt<'keep' | 'stop'>({
				type: Severity.Info,
				message: localize('nova.chatTabs.closeRunning', "The session in this tab is still running."),
				detail: localize('nova.chatTabs.closeRunningDetail', "It can finish in the background and stay available in the sessions list."),
				buttons: [
					{ label: localize({ key: 'nova.chatTabs.keepRunning', comment: ['&& denotes a mnemonic'] }, "&&Let It Finish in the Background"), run: () => 'keep' },
					{ label: localize({ key: 'nova.chatTabs.stop', comment: ['&& denotes a mnemonic'] }, "&&Stop and Close"), run: () => 'stop' },
				],
				cancelButton: true,
			});
			if (!result) {
				return;
			}
			if (result === 'stop') {
				await this.chatService.cancelCurrentRequestForSession(model.sessionResource, 'ChatViewTabs#close');
			}
		}

		const current = this._tabs.indexOf(tab);
		if (current < 0) {
			return;
		}
		const wasActive = current === this._active;
		this._tabs.splice(current, 1);
		this.disposeTab(tab);

		if (!this._tabs.length) {
			await this.newTab();
			return;
		}
		if (current < this._active || (wasActive && this._active >= this._tabs.length)) {
			this._active--;
		}
		if (wasActive) {
			await this.activate(this._active);
		} else {
			this._onDidChange.fire();
		}
	}

	getIcon(tab: IChatViewTab): ThemeIcon {
		const model = this.getModelOption(tab);
		if (model?.icon) {
			return model.icon; // the logo of the model's company
		}
		if (tab.resource) {
			const type = getChatSessionType(tab.resource);
			if (type !== localChatSessionType) {
				const icon = this.chatSessionsService.getChatSessionContribution(type)?.icon;
				if (ThemeIcon.isThemeIcon(icon)) {
					return icon;
				}
			}
		}
		return Codicon.commentDiscussion;
	}

	getLabel(tab: IChatViewTab): string {
		if (tab.title) {
			return tab.title;
		}
		const type = tab.resource ? getChatSessionType(tab.resource) : localChatSessionType;
		return (type !== localChatSessionType ? this.chatSessionsService.getChatSessionContribution(type)?.displayName : undefined)
			?? localize('nova.chatTabs.newChat', "New Chat");
	}

	getAgentName(tab: IChatViewTab): string {
		const type = tab.resource ? getChatSessionType(tab.resource) : localChatSessionType;
		return (type !== localChatSessionType ? this.chatSessionsService.getChatSessionContribution(type)?.displayName : undefined)
			?? localize('nova.chatTabs.local', "Local");
	}

	getModelName(tab: IChatViewTab): string | undefined {
		return this.getModelOption(tab)?.name;
	}

	/** The session's selected model, recognized by its company logo (see nova-agent-bridge). */
	private getModelOption(tab: IChatViewTab): IChatSessionProviderOptionItem | undefined {
		for (const resource of tab.resource ? [tab.resource, ...tab.aliases] : []) {
			for (const optionId of this.chatSessionsService.getSessionOptions(resource)?.keys() ?? []) {
				const value = this.chatSessionsService.getSessionOption(resource, optionId);
				if (typeof value !== 'string' && value?.icon?.id.startsWith('nova-logo-')) {
					return value;
				}
			}
		}
		return undefined;
	}

	private matches(tab: IChatViewTab, resource: URI): boolean {
		return (!!tab.resource && isEqual(tab.resource, resource)) || tab.aliases.some(alias => isEqual(alias, resource));
	}

	private createTab(resource: URI | undefined, title: string | undefined): IChatViewTab {
		return {
			id: this.nextId++,
			resource,
			aliases: [],
			title,
			running: false,
			needsInput: false,
			unseen: false,
			ref: new MutableDisposable<IChatModelReference>(),
			modelListeners: new MutableDisposable<DisposableStore>(),
		};
	}

	private disposeTab(tab: IChatViewTab): void {
		tab.modelListeners.dispose();
		tab.ref.dispose();
	}

	/** Holds a reference to the tab's session and follows its title and progress. */
	private bind(tab: IChatViewTab, model: IChatModel): void {
		if (tab.ref.value?.object === model) {
			return;
		}

		tab.ref.value = this.chatService.acquireExistingSession(model.sessionResource, 'ChatViewTabs');
		tab.title = this.titleOf(model) ?? tab.title;

		const store = new DisposableStore();
		store.add(model.onDidChange(e => {
			if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
				tab.title = this.titleOf(model) ?? tab.title;
				this._onDidChange.fire();
			}
		}));
		store.add(autorun(reader => {
			const running = model.requestInProgress.read(reader);
			const needsInput = !!model.requestNeedsInput.read(reader);
			if (tab.running && !running && this._tabs[this._active] !== tab) {
				tab.unseen = true;
			}
			if (tab.running !== running || tab.needsInput !== needsInput) {
				tab.running = running;
				tab.needsInput = needsInput;
				this._onDidChange.fire();
			}
		}));
		tab.modelListeners.value = store;
	}

	private titleOf(model: IChatModel): string | undefined {
		return model.title ? renderAsPlaintext(new MarkdownString(model.title)) : undefined;
	}

	private restore(): void {
		let stored: IStoredChatViewTabs | undefined;
		try {
			stored = JSON.parse(this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, 'null'));
		} catch {
			stored = undefined;
		}
		for (const tab of stored?.tabs ?? []) {
			this._tabs.push(this.createTab(tab.resource ? URI.revive(tab.resource) : undefined, tab.title));
		}
		this._active = Math.max(0, Math.min(stored?.active ?? 0, this._tabs.length - 1));
	}

	private save(): void {
		const tabs = this._tabs.map(tab => {
			const resource = tab.aliases.at(-1) ?? tab.resource;
			return { resource: resource && !isUntitledChatSession(resource) ? resource.toJSON() : undefined, title: tab.title };
		});
		this.storageService.store(STORAGE_KEY, JSON.stringify({ tabs, active: this._active } satisfies IStoredChatViewTabs), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

/** The tab strip, a row at the top of the Chat view. */
export class ChatViewTabsWidget extends Disposable {

	/** Height of the tab row, which the view takes off the space for the chat. */
	static readonly HEIGHT = 30;

	private readonly renderDisposables = this._register(new DisposableStore());
	private strip: HTMLElement | undefined;

	constructor(
		container: HTMLElement,
		private readonly tabs: ChatViewTabs,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this._register(this.tabs.onDidChange(() => this.renderTabs()));
		this.render(container);
	}

	private render(container: HTMLElement): void {
		const root = append(container, $('.nova-chat-tabs'));
		root.style.height = `${ChatViewTabsWidget.HEIGHT}px`;
		this.strip = append(root, $('.nova-chat-tabs-strip', { role: 'tablist' }));
		this._register(addDisposableListener(this.strip, EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			if (this.strip && e.deltaY && !e.deltaX) {
				this.strip.scrollLeft += e.deltaY;
				EventHelper.stop(e, true);
			}
		}));

		const add = append(root, $(`a.nova-chat-tabs-add${ThemeIcon.asCSSSelector(Codicon.add)}`, { role: 'button', tabIndex: 0 }));
		this._register(this.hoverService.setupDelayedHover(add, { content: localize('nova.chatTabs.new', "New Chat Tab") }));
		this._register(addDisposableListener(add, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			void this.tabs.newTab();
		}));

		this.renderTabs();
	}

	private renderTabs(): void {
		if (!this.strip) {
			return;
		}
		this.renderDisposables.clear();
		this.strip.textContent = '';

		this.tabs.tabs.forEach((tab, index) => {
			const active = index === this.tabs.activeIndex;
			const element = append(this.strip!, $('.nova-chat-tab', { role: 'tab', tabIndex: 0, 'aria-selected': String(active) }));
			element.classList.toggle('active', active);
			element.classList.toggle('running', tab.running);
			element.classList.toggle('needs-input', tab.needsInput);
			element.classList.toggle('unseen', tab.unseen);

			const icon = tab.needsInput ? Codicon.bell : tab.running ? ThemeIcon.modify(Codicon.loading, 'spin') : this.tabs.getIcon(tab);
			append(element, $(`span.nova-chat-tab-icon${ThemeIcon.asCSSSelector(icon)}`));
			append(element, $('span.nova-chat-tab-label')).textContent = this.tabs.getLabel(tab);
			append(element, $('span.nova-chat-tab-dot'));
			const close = append(element, $(`span.nova-chat-tab-close${ThemeIcon.asCSSSelector(Codicon.close)}`, { role: 'button' }));

			this.renderDisposables.add(this.hoverService.setupDelayedHover(element, () => ({ content: this.hoverText(tab) })));
			this.renderDisposables.add(addDisposableListener(element, EventType.MOUSE_DOWN, (e: MouseEvent) => {
				if (e.button === 1) {
					EventHelper.stop(e, true);
				}
			}));
			this.renderDisposables.add(addDisposableListener(element, EventType.AUXCLICK, (e: MouseEvent) => {
				if (e.button === 1) {
					EventHelper.stop(e, true);
					void this.tabs.close(index);
				}
			}));
			this.renderDisposables.add(addDisposableListener(element, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				if (e.target === close) {
					void this.tabs.close(index);
				} else if (index !== this.tabs.activeIndex) {
					void this.tabs.activate(index);
				}
			}));
			this.renderDisposables.add(addDisposableListener(element, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					EventHelper.stop(e, true);
					void this.tabs.activate(index);
				} else if (e.key === 'Delete') {
					EventHelper.stop(e, true);
					void this.tabs.close(index);
				}
			}));

			if (active) {
				element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		});
	}

	private hoverText(tab: IChatViewTab): string {
		const agent = this.tabs.getAgentName(tab);
		const model = this.tabs.getModelName(tab);
		const status = tab.needsInput
			? localize('nova.chatTabs.needsInput', "Waiting for you")
			: tab.running
				? localize('nova.chatTabs.running', "Working…")
				: tab.unseen
					? localize('nova.chatTabs.finished', "Finished")
					: undefined;
		return [this.tabs.getLabel(tab), [agent, model, status].filter(Boolean).join(' · ')].join('\n');
	}
}

function getChatTabs(viewsService: IViewsService): ChatViewTabs | undefined {
	return viewsService.getViewWithId<IView & IChatViewTabsHost>(ChatViewId)?.chatTabs;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.newTab',
			title: localize2('nova.chatTabs.newTab', "New Chat Tab"),
			category: localize2('nova.chatTabs.category', "Chat"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				when: ChatContextKeys.inChatSession,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(ChatViewId, true);
		await getChatTabs(viewsService)?.newTab();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.closeTab',
			title: localize2('nova.chatTabs.closeTab', "Close Chat Tab"),
			category: localize2('nova.chatTabs.category', "Chat"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const tabs = getChatTabs(accessor.get(IViewsService));
		await tabs?.close(tabs.activeIndex);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.nextTab',
			title: localize2('nova.chatTabs.nextTab', "Next Chat Tab"),
			category: localize2('nova.chatTabs.category', "Chat"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				when: ChatContextKeys.inChatSession,
				primary: KeyMod.CtrlCmd | KeyCode.PageDown,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await getChatTabs(accessor.get(IViewsService))?.activateRelative(1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.previousTab',
			title: localize2('nova.chatTabs.previousTab', "Previous Chat Tab"),
			category: localize2('nova.chatTabs.category', "Chat"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				when: ChatContextKeys.inChatSession,
				primary: KeyMod.CtrlCmd | KeyCode.PageUp,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await getChatTabs(accessor.get(IViewsService))?.activateRelative(-1);
	}
});
