/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSessionPickerActionItem.css';
import { IAction, toAction } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import * as dom from '../../../../../base/browser/dom.js';
import { getActiveWindow } from '../../../../../base/browser/dom.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownOptions } from '../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ActionWidgetDropdownActionViewItem } from '../../../../../platform/actions/browser/actionWidgetDropdownActionViewItem.js';
import { IChatSessionProviderOptionGroup, IChatSessionProviderOptionItem } from '../../common/chatSessionsService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChatInputPickerOptions, withChatInputPickerMotion } from '../widget/input/chatInputPickerActionItem.js';
import { autorun } from '../../../../../base/common/observable.js';
import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IActionListItemHover } from '../../../../../platform/actionWidget/browser/actionList.js';
import { getModelHoverContent } from '../widget/input/modelPicker/modelPickerHover.js';
import { getCompactCodicon } from '../chatIcons.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';

/** NOVA: option groups with more items than this get a search box and favorites. */
const NOVA_SEARCHABLE_OPTION_COUNT = 12;


export interface IChatSessionPickerDelegate {
	readonly onDidChangeOption: Event<IChatSessionProviderOptionItem>;
	getCurrentOption(): IChatSessionProviderOptionItem | undefined;
	setOption(option: IChatSessionProviderOptionItem): void;
	getOptionGroup(): IChatSessionProviderOptionGroup | undefined;
	getSessionResource: () => URI | undefined;
}

/**
 * Action view item for making an option selection for a contributed chat session
 * These options are provided by the relevant ChatSession Provider
 */
export class ChatSessionPickerActionItem extends ActionWidgetDropdownActionViewItem {
	protected currentOption: IChatSessionProviderOptionItem | undefined;
	protected container: HTMLElement | undefined;

	constructor(
		action: IAction,
		initialState: { group: IChatSessionProviderOptionGroup; item: IChatSessionProviderOptionItem | undefined },
		protected readonly delegate: IChatSessionPickerDelegate,
		protected readonly _pickerOptions: IChatInputPickerOptions | undefined,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService protected readonly commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		const { group, item } = initialState;
		const actionWithLabel: IAction = {
			...action,
			label: item?.name || group.name,
			tooltip: item?.description ?? group.description ?? group.name,
			run: () => { }
		};

		const sessionPickerActionWidgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider: {
				getActions: () => this.getDropdownActions()
			},
			actionBarActionProvider: undefined,
			reporter: { id: group.id, name: `ChatSession:${group.name}`, includeOptions: false },
			getAnchor: () => this._getAnchorElement(),
			// NOVA: long option lists (e.g. an agent's hundreds of models) get a search box
			listOptionsProvider: {
				getListOptions: () => {
					const currentGroup = this.delegate.getOptionGroup() ?? group;
					return withChatInputPickerMotion(currentGroup.items.length > NOVA_SEARCHABLE_OPTION_COUNT ? {
						showFilter: true,
						focusFilterOnOpen: true,
						filterPlaceholder: localize('nova.chatSessionPicker.search', "Search {0}", currentGroup.name.toLowerCase()),
					} : undefined);
				}
			},
		};

		super(actionWithLabel, sessionPickerActionWidgetOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
		this.currentOption = item;

		this._register(this.delegate.onDidChangeOption(newOption => {
			this.currentOption = newOption;
			if (this.element) {
				this.renderLabel(this.element);
			}
			this.updateEnabled();
		}));

		const pickerOptions = this._pickerOptions;
		if (pickerOptions) {
			this._register(autorun(reader => {
				pickerOptions.compact.read(reader);
				if (this.element) {
					this.renderLabel(this.element);
				}
			}));
		}
	}

	/**
	 * Returns the actions to show in the dropdown. Can be overridden by subclasses.
	 */
	protected getDropdownActions(): IActionWidgetDropdownAction[] {
		// if locked, show the current option only
		const currentOption = this.delegate.getCurrentOption();
		if (currentOption?.locked) {
			return [this.createLockedOptionAction(currentOption)];
		}

		const group = this.delegate.getOptionGroup();
		if (!group) {
			return [];
		}

		// NOVA: long lists get favorites, pinned to the top in their own section
		const withFavorites = group.items.length > NOVA_SEARCHABLE_OPTION_COUNT;
		const favorites = withFavorites ? this._getFavorites(group.id) : [];
		const items = withFavorites
			? [...group.items.filter(i => favorites.includes(i.id)), ...group.items.filter(i => !favorites.includes(i.id))]
			: group.items;

		const actions: IActionWidgetDropdownAction[] = items.map(optionItem => {
			const isCurrent = optionItem.id === currentOption?.id;
			const isFavorite = favorites.includes(optionItem.id);
			return {
				id: optionItem.id,
				enabled: !optionItem.locked,
				icon: optionItem.icon,
				checked: isCurrent,
				class: undefined,
				// NOVA: a company logo takes the checkmark's place, so mark the current item on the row instead
				className: isCurrent && isNovaLogo(optionItem.icon) ? 'nova-option-current' : undefined,
				description: optionItem.description,
				tooltip: optionItem.description ?? optionItem.name,
				label: optionItem.name,
				hover: this._buildOptionHover(optionItem),
				category: withFavorites && favorites.length
					? (isFavorite
						? { label: localize('nova.chatSessionPicker.favorites', "Favorites"), order: 0, showHeader: true }
						: { label: localize('nova.chatSessionPicker.all', "All"), order: 1, showHeader: true })
					: undefined,
				toolbarActions: withFavorites ? [toAction({
					id: `nova.favorite.${optionItem.id}`,
					label: isFavorite
						? localize('nova.chatSessionPicker.removeFavorite', "Remove from Favorites")
						: localize('nova.chatSessionPicker.addFavorite', "Add to Favorites"),
					class: ThemeIcon.asClassName(isFavorite ? Codicon.starFull : Codicon.starEmpty),
					run: () => this._toggleFavorite(group.id, optionItem.id),
				})] : undefined,
				run: () => {
					this.delegate.setOption(optionItem);
				}
			} satisfies IActionWidgetDropdownAction;
		});

		// Add commands at the end in a separate section (only if there are options)
		if (group.commands?.length) {
			const addSeparator = actions.length > 0;
			for (const command of group.commands) {
				const args = command.arguments ? [...command.arguments] : [];
				const sessionResource = this.delegate.getSessionResource();
				if (sessionResource) {
					args.unshift(sessionResource);
				}
				actions.push({
					id: command.command,
					enabled: true,
					checked: false,
					class: undefined,
					description: undefined,
					tooltip: command.tooltip ?? command.title,
					label: command.title,
					// Use category to create a separator before commands (only if there are options)
					category: addSeparator ? { label: '', order: Number.MAX_SAFE_INTEGER } : undefined,
					run: () => {
						this.commandService.executeCommand(command.command, ...args);
					}
				} satisfies IActionWidgetDropdownAction);
			}
		}

		return actions;
	}

	// NOVA: favorites are stored per option group id (e.g. "model") in the user profile.
	private _getFavorites(groupId: string): string[] {
		try {
			const value = JSON.parse(this.storageService.get(`nova.chatSessionPicker.favorites.${groupId}`, StorageScope.PROFILE, '[]'));
			return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
		} catch {
			return [];
		}
	}

	private _toggleFavorite(groupId: string, optionId: string): void {
		const favorites = this._getFavorites(groupId);
		const next = favorites.includes(optionId) ? favorites.filter(id => id !== optionId) : [...favorites, optionId];
		this.storageService.store(`nova.chatSessionPicker.favorites.${groupId}`, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.USER);
		// Reopen so the list is rebuilt with the new favorites section.
		this.hide();
		setTimeout(() => this.show(), 0);
	}

	private _buildOptionHover(optionItem: IChatSessionProviderOptionItem): IActionListItemHover | undefined {
		if (optionItem.modelMetadata) {
			const isUBB = !!this.chatEntitlementService.quotas.usageBasedBilling;
			const syntheticModel = {
				identifier: optionItem.id,
				metadata: {
					extension: new ExtensionIdentifier(''),
					name: optionItem.modelMetadata.name,
					id: optionItem.modelMetadata.id,
					vendor: optionItem.modelMetadata.vendor ?? '',
					version: optionItem.modelMetadata.version ?? '',
					family: optionItem.modelMetadata.family ?? '',
					tooltip: optionItem.modelMetadata.tooltip,
					pricing: optionItem.modelMetadata.pricing,
					multiplierNumeric: optionItem.modelMetadata.multiplierNumeric,
					inputCost: optionItem.modelMetadata.inputCost,
					outputCost: optionItem.modelMetadata.outputCost,
					cacheCost: optionItem.modelMetadata.cacheCost,
					cacheWriteCost: optionItem.modelMetadata.cacheWriteCost,
					longContextInputCost: optionItem.modelMetadata.longContextInputCost,
					longContextOutputCost: optionItem.modelMetadata.longContextOutputCost,
					longContextCacheCost: optionItem.modelMetadata.longContextCacheCost,
					longContextCacheWriteCost: optionItem.modelMetadata.longContextCacheWriteCost,
					priceCategory: optionItem.modelMetadata.priceCategory,
					promo: optionItem.modelMetadata.promo,
					maxInputTokens: optionItem.modelMetadata.maxInputTokens ?? 0,
					maxOutputTokens: optionItem.modelMetadata.maxOutputTokens ?? 0,
					maxContextWindowTokens: optionItem.modelMetadata.maxContextWindowTokens,
					capabilities: optionItem.modelMetadata.capabilities ? {
						vision: optionItem.modelMetadata.capabilities.vision,
						toolCalling: optionItem.modelMetadata.capabilities.toolCalling,
					} : undefined,
					isDefaultForLocation: {},
				},
			};
			const hover = getModelHoverContent(syntheticModel, isUBB, undefined, this.openerService);
			if (hover) {
				return { content: hover.element, disposable: hover.disposable };
			}
		}
		if (optionItem.tooltip) {
			return { content: optionItem.tooltip };
		}
		return undefined;
	}

	/**
	 * Creates a disabled action for a locked option.
	 */
	protected createLockedOptionAction(option: IChatSessionProviderOptionItem): IActionWidgetDropdownAction {
		return {
			id: option.id,
			enabled: false,
			icon: option.icon,
			checked: true,
			class: undefined,
			description: option.description,
			tooltip: option.description ?? option.name,
			label: option.name,
			run: () => { }
		};
	}

	/**
	 * Returns the anchor element for the dropdown.
	 * Falls back to the overflow anchor if this element is not in the DOM.
	 */
	private _getAnchorElement(): HTMLElement {
		if (this.element && getActiveWindow().document.contains(this.element)) {
			return this.element;
		}
		return this._pickerOptions?.getOverflowAnchor?.() ?? this.element!;
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const domChildren = [];
		element.classList.add('chat-session-option-picker');
		const group = this.delegate.getOptionGroup();
		const compact = this._pickerOptions?.compact.get() ?? false;
		element.classList.toggle('compact', compact);
		const label = this.currentOption?.name ?? group?.description ?? localize('chat.sessionPicker.label', "Pick Option");
		// If the current option is the default and has an icon, collapse the text and show only the icon
		// NOVA: except for company logos, which go next to the model name
		const hasLogo = isNovaLogo(this.currentOption?.icon);
		const isDefaultWithIcon = this.currentOption?.default && this.currentOption?.icon && !hasLogo;
		element.classList.toggle('icon-only', compact && !!this.currentOption?.icon && !hasLogo);

		if (this.currentOption?.icon) {
			domChildren.push(renderIcon(getCompactCodicon(this.currentOption.icon)));
		}

		if (!isDefaultWithIcon && (!compact || !this.currentOption?.icon || hasLogo)) {
			domChildren.push(dom.$('span.chat-session-option-label', undefined, label));
		}

		dom.reset(element, ...domChildren);
		this.setAriaLabelAttributes(element);
		element.ariaLabel = label;
		return null;
	}

	override render(container: HTMLElement): void {
		this.container = container;
		super.render(container);
		container.classList.add(this.getContainerClass());

		// Set initial locked state on container
		if (this.currentOption?.locked) {
			container.classList.add('locked');
		}
	}

	/**
	 * Returns the CSS class to add to the container. Can be overridden by subclasses.
	 */
	protected getContainerClass(): string {
		return 'chat-sessionPicker-item';
	}

	protected override updateEnabled(): void {
		const originalEnabled = this.action.enabled;
		if (this.currentOption?.locked) {
			this.action.enabled = false;
		}
		super.updateEnabled();
		this.action.enabled = originalEnabled;
		if (this.container) {
			this.container.classList.toggle('locked', !!this.currentOption?.locked);
		}
	}
}

/** NOVA: company logos from the nova-logos icon font (see nova-agent-bridge). */
function isNovaLogo(icon: ThemeIcon | undefined): boolean {
	return !!icon?.id.startsWith('nova-logo-');
}
