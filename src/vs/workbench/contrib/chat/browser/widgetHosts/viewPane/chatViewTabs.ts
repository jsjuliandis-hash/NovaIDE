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
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
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
import { isResponseVM } from '../../../common/model/chatViewModel.js';
import { getChatSessionType, isUntitledChatSession } from '../../../common/model/chatUri.js';
import { ChatViewId, IChatWidgetService } from '../../chat.js';

/** What the tabs need from the Chat view that hosts them. */
export interface IChatViewTabsDelegate {
	/** Shows an existing session in the view's widget. */
	loadSession(resource: URI): Promise<unknown>;
	/** Starts a new session (of the default session type) in the view's widget. */
	newSession(): Promise<unknown>;
	/** Starts a new session of the given (non-local) session type in the view's widget. */
	newSessionOfType(resource: URI): Promise<IChatModel | undefined>;
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

/** Data type of a chat tab being dragged inside the tab strip. */
const CHAT_TAB_DRAG_TYPE = 'application/x-nova-chat-tab';

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

	/** Opens a blank tab; with a session type, the tab starts a session of that type instead of a Local one. */
	async newTab(sessionType?: string): Promise<IChatModel | undefined> {
		this._tabs.push(this.createTab(undefined, undefined));
		this._active = this._tabs.length - 1;
		this._onDidChange.fire();
		if (sessionType && sessionType !== localChatSessionType) {
			return this.delegate.newSessionOfType(URI.from({ scheme: sessionType, path: `/untitled-${generateUuid()}` }));
		}
		return await this.delegate.newSession() as IChatModel | undefined;
	}

	/** Moves a tab to another position (drag and drop); the active tab stays the same one. */
	move(from: number, to: number): void {
		if (from === to || !this._tabs[from] || to < 0 || to >= this._tabs.length) {
			return;
		}
		const activeTab = this._tabs[this._active];
		const [tab] = this._tabs.splice(from, 1);
		this._tabs.splice(to, 0, tab);
		this._active = this._tabs.indexOf(activeTab);
		this._onDidChange.fire();
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
	private draggedIndex: number | undefined;

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
			this.registerDragAndDrop(element, index);
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

	/** Lets the user drag a tab to another position in the strip. */
	private registerDragAndDrop(element: HTMLElement, index: number): void {
		element.draggable = true;

		const dropSide = (e: DragEvent): 'before' | 'after' => {
			const rect = element.getBoundingClientRect();
			return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
		};
		const clearIndicator = () => element.classList.remove('drop-before', 'drop-after');

		this.renderDisposables.add(addDisposableListener(element, EventType.DRAG_START, (e: DragEvent) => {
			this.draggedIndex = index;
			element.classList.add('dragging');
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData(CHAT_TAB_DRAG_TYPE, String(index));
			}
		}));
		this.renderDisposables.add(addDisposableListener(element, EventType.DRAG_END, () => {
			this.draggedIndex = undefined;
			element.classList.remove('dragging');
		}));
		this.renderDisposables.add(addDisposableListener(element, EventType.DRAG_OVER, (e: DragEvent) => {
			if (this.draggedIndex === undefined || this.draggedIndex === index) {
				return;
			}
			EventHelper.stop(e, true);
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			const side = dropSide(e);
			element.classList.toggle('drop-before', side === 'before');
			element.classList.toggle('drop-after', side === 'after');
		}));
		this.renderDisposables.add(addDisposableListener(element, EventType.DRAG_LEAVE, clearIndicator));
		this.renderDisposables.add(addDisposableListener(element, EventType.DROP, (e: DragEvent) => {
			const from = this.draggedIndex;
			this.draggedIndex = undefined;
			clearIndicator();
			if (from === undefined || from === index) {
				return;
			}
			EventHelper.stop(e, true);
			let to = index + (dropSide(e) === 'after' ? 1 : 0);
			if (from < to) {
				to--; // the dragged tab leaves its old slot first
			}
			this.tabs.move(from, to);
		}));
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

/** Arguments of `workbench.action.chat.nova.openTab`. Names are matched without regard to case. */
interface IOpenChatTabArgs {
	/** Session type, name or display name of the provider (for example `nova-openrouter`, `OpenRouter`, `Claude Code`). Default: Local. */
	readonly provider?: string;
	readonly model?: string;
	readonly mode?: string;
	readonly effort?: string;
	/** Any other picker, keyed by option group id or name. */
	readonly options?: Record<string, string>;
	/** Sent as the first message of the new tab. */
	readonly prompt?: string;
}

const OPTION_GROUP_TIMEOUT = 30_000;
const OPTION_KEY_ALIASES: Record<string, readonly string[]> = {
	model: ['model', 'acp.model'],
	mode: ['mode', 'acp.mode'],
	effort: ['effort', 'thought_level', 'reasoning_effort', 'reasoning', 'thinking'],
};

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

/** Waits until the provider has reported its pickers (models, modes…): the agent discovers them after it starts. */
function waitForOptionGroups(chatSessionsService: IChatSessionsService, sessionType: string): Promise<void> {
	if (chatSessionsService.getOptionGroupsForSessionType(sessionType)?.length) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const store = new DisposableStore();
		const done = () => {
			store.dispose();
			resolve();
		};
		const handle = setTimeout(done, OPTION_GROUP_TIMEOUT);
		store.add({ dispose: () => clearTimeout(handle) });
		store.add(chatSessionsService.onDidChangeOptionGroups(type => {
			if (type === sessionType && chatSessionsService.getOptionGroupsForSessionType(sessionType)?.length) {
				done();
			}
		}));
	});
}

function findOptionGroup(groups: readonly { id: string; name: string }[], key: string): { id: string; name: string } | undefined {
	const wanted = normalizeName(key);
	const names = OPTION_KEY_ALIASES[wanted] ?? [wanted];
	return groups.find(g => names.includes(normalizeName(g.id)) || normalizeName(g.name) === wanted)
		?? groups.find(g => names.some(n => normalizeName(g.id).endsWith(`.${n}`) || normalizeName(g.id).endsWith(`_${n}`)));
}

/** Lowercase words of a name; separators such as spaces, dashes and slashes do not matter. */
function nameWords(value: string): string[] {
	return value.toLowerCase().split(/[\s\-_/:()]+/).filter(Boolean);
}

/** Items whose id or name contains every word of `value`, in any order. */
function findOptionItems(items: readonly IChatSessionProviderOptionItem[], value: string): IChatSessionProviderOptionItem[] {
	const exact = items.find(i => normalizeName(i.id) === normalizeName(value) || normalizeName(i.name) === normalizeName(value));
	if (exact) {
		return [exact];
	}
	const words = nameWords(value);
	const matches = items.filter(i => {
		const haystack = nameWords(`${i.id} ${i.name}`);
		return words.length > 0 && words.every(w => haystack.some(h => h.includes(w)));
	});
	// Prefer the items where the words are whole words (so "flash" does not pick "flash-image" over "flash" when both match)
	const whole = matches.filter(i => {
		const haystack = nameWords(`${i.id} ${i.name}`);
		return words.every(w => haystack.includes(w));
	});
	const found = whole.length ? whole : matches;
	// "flash-lite" next to "flash-lite-preview" and "flash-lite-image": the base model is the one whose id the others extend
	const base = found.reduce<IChatSessionProviderOptionItem | undefined>((shortest, i) => !shortest || i.id.length < shortest.id.length ? i : shortest, undefined);
	return base && found.every(i => i.id.startsWith(base.id)) ? [base] : found;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.openTab',
			title: localize2('nova.chatTabs.openTab', "Open Chat Tab with Provider and Model"),
			category: localize2('nova.chatTabs.category', "Chat"),
			f1: false,
		});
	}

	/**
	 * Opens a new chat tab (keeping the others) for a provider, with model, mode and effort already selected,
	 * and optionally sends the first message. Returns what ended up selected, or why something could not be.
	 */
	async run(accessor: ServicesAccessor, args?: IOpenChatTabArgs): Promise<object> {
		const viewsService = accessor.get(IViewsService);
		const chatSessionsService = accessor.get(IChatSessionsService);
		const chatService = accessor.get(IChatService);
		const chatWidgetService = accessor.get(IChatWidgetService);

		const problems: string[] = [];
		const contributions = chatSessionsService.getAllChatSessionContributions();
		const providers = contributions.map(c => ({ type: c.type, name: c.displayName || c.name }));
		let sessionType = localChatSessionType;
		if (args?.provider) {
			const wanted = normalizeName(args.provider);
			const match = contributions.find(c => [c.type, c.name, c.displayName, ...(c.alternativeIds ?? [])].some(n => n && normalizeName(n) === wanted));
			if (!match && wanted !== normalizeName(localChatSessionType)) {
				return { opened: false, error: `Unknown provider "${args.provider}".`, providers };
			}
			sessionType = match?.type ?? localChatSessionType;
		}

		await viewsService.openView(ChatViewId, true);
		const tabs = getChatTabs(viewsService);
		if (!tabs) {
			return { opened: false, error: 'The Chat view is not available.' };
		}
		const model = await tabs.newTab(sessionType);
		const resource = model?.sessionResource;
		if (!resource) {
			return { opened: false, error: `Could not open a ${sessionType} session.` };
		}

		const requested = new Map<string, string>();
		for (const key of ['model', 'mode', 'effort'] as const) {
			if (args?.[key]) {
				requested.set(key, args[key]);
			}
		}
		for (const [key, value] of Object.entries(args?.options ?? {})) {
			requested.set(key, value);
		}

		const applied: Record<string, string> = {};
		if (requested.size && sessionType !== localChatSessionType) {
			await waitForOptionGroups(chatSessionsService, sessionType);
			const groups = chatSessionsService.getOptionGroupsForSessionType(sessionType) ?? [];
			const updates = new Map<string, string>();
			for (const [key, value] of requested) {
				const group = findOptionGroup(groups, key);
				if (!group) {
					problems.push(`No picker "${key}". Pickers: ${groups.map(g => `${g.id} ("${g.name}")`).join(', ') || 'none reported yet'}.`);
					continue;
				}
				const groupItems = groups.find(g => g.id === group.id)?.items ?? [];
				const candidates = findOptionItems(groupItems, value);
				if (candidates.length !== 1) {
					const listed = (candidates.length ? candidates : groupItems).slice(0, 40).map(i => i.id).join(', ');
					problems.push(candidates.length
						? `"${value}" matches ${candidates.length} options in picker "${group.id}"; be more specific: ${listed}.`
						: `No option "${value}" in picker "${group.id}". Options: ${listed}.`);
					continue;
				}
				const item = candidates[0];
				updates.set(group.id, item.id);
				applied[group.id] = item.name;
			}
			if (updates.size) {
				chatSessionsService.updateSessionOptions(resource, updates);
			}
		} else if (requested.size) {
			problems.push('The Local provider has no provider pickers; pass a provider.');
		}

		if (args?.prompt) {
			// Through the widget, so the tab shows the conversation: a request sent straight to the chat service commits the
			// untitled session to a new resource that the widget never switches to (the tab stays on the welcome screen).
			const widget = chatWidgetService.getWidgetBySessionResource(resource);
			if (widget) {
				await widget.acceptInput(args.prompt, { preserveFocus: true });
			} else {
				await chatService.sendRequest(resource, args.prompt, { agentIdSilent: sessionType });
			}
		}

		return { opened: true, provider: sessionType, session: resource.toString(), selected: applied, promptSent: !!args?.prompt, problems };
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

/** The chat command of nova-agent-bridge that saves a titled summary, clears the chat and goes on from the summary. */
const NOVA_SAVE_COMMAND = '/nova-save';

// NOVA: a button under each answer of a Nova agent (next to Copy) that runs /nova-save in that answer's chat.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.compact',
			title: localize2('nova.chat.compact', "Save and Clear Conversation (Nova Save)"),
			category: localize2('nova.chatTabs.category', "Chat"),
			icon: Codicon.foldVertical,
			f1: false,
			precondition: ChatContextKeys.requestInProgress.negate(),
			menu: [{
				id: MenuId.ChatMessageFooter,
				group: 'navigation',
				order: 2,
				when: ContextKeyExpr.and(ChatContextKeys.isResponse, ContextKeyExpr.regex(ChatContextKeys.agentSessionType.key, /^nova-/)),
			}],
		});
	}
	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const chatWidgetService = accessor.get(IChatWidgetService);
		const item = args[0];
		const widget = isResponseVM(item) ? chatWidgetService.getWidgetBySessionResource(item.sessionResource) : chatWidgetService.lastFocusedWidget;
		await widget?.acceptInput(NOVA_SAVE_COMMAND);
	}
});

// NOVA: lets nova-agent-bridge submit a message in the chat that has the focus (used to show which saved summary a new chat starts from).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.nova.sendInput',
			title: localize2('nova.chat.sendInput', "Send Message to the Focused Chat"),
			category: localize2('nova.chatTabs.category', "Chat"),
			f1: false,
		});
	}
	async run(accessor: ServicesAccessor, text?: string): Promise<void> {
		if (typeof text === 'string' && text) {
			await accessor.get(IChatWidgetService).lastFocusedWidget?.acceptInput(text);
		}
	}
});
