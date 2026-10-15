/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Exposes an ACP agent as a chat session type in the Chat view: the session target picker
 *  lists it next to "Local", its models/effort/mode become the input pickers, and every
 *  request is forwarded to the agent process with the answer streamed back into the chat.
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Gateway, GatewayId, GATEWAYS } from './gateways';
import { vendorIcon } from './vendors';
import { AcpAuthMethod, AcpAvailableCommand, AcpConfigOption, AcpConnection, AcpContentBlock, AcpError, AcpNewSessionResult, AcpPermissionOption, AcpPromptResult, AcpRequestHandlers, AcpSessionUpdate } from './acp';
import { ConversationContext, decideAutoCompact, formatTokenCount, modelsUsed, requestProcessedTokens, UsageSemantics } from './contextAccounting';
import { AcpToolContentItem, diffText, inlineCode, shortText, toolOutputText } from './activityLog';
import { buildSummaryRequest, chooseTitle, clampSummaryChars, cleanSummary, DEFAULT_SUMMARY_CHARS, NOVA_COMPACT_COMMAND, NOVA_LOADED_COMMAND, NOVA_SAVE_COMMAND, parseCompactCommand, splitTitle, wrapSummary } from './novaCompact';
import { formatMetrics, RecentMetrics, RequestKind, RequestMetrics } from './requestMetrics';
import { SummaryStore } from './summaryStore';

/** How much of the Nova IDE manual an agent receives with the first prompt (nova.agents.manualMode). */
type ManualMode = 'compact' | 'full' | 'off';

/** Which catalog of Nova MCP tools a new session gets (nova.agents.toolProfile); see nova-browser-bridge toolProfiles.ts. */
type ToolProfile = 'code' | 'browser' | 'full';

/**
 * Static description of an ACP agent. The chat session `type` must match a `chatSessions`
 * contribution in package.json.
 */
export interface AgentDefinition {
	readonly type: string;
	readonly label: string;
	readonly settingsSection: string;
	readonly defaultCommand: string;
	readonly defaultArgs: readonly string[];
	readonly loginHint: string;
	/** Icon id (a codicon or a `nova-logo-*` glyph) for the session items and participant. */
	readonly icon: string;
	/** Logo shown for models whose company cannot be told from their id or name. */
	readonly defaultVendor?: string;
	/** Set for the model gateways (NVIDIA, OpenRouter): OpenCode limited to that gateway, with its own API key. */
	readonly gateway?: GatewayId;
	/** What the `usage` of a prompt result means for this agent (see contextAccounting.ts); unset when not measured. */
	readonly usageSemantics?: UsageSemantics;
}

interface SessionState {
	acpSessionId: string | undefined;
	item: vscode.ChatSessionItem;
	/** Current value of each ACP config option (model, effort, mode...) as last sent to the agent. */
	appliedOptions: Map<string, string>;
	/** True once the Nova IDE manual has been handed to the agent in this session. */
	manualSent?: boolean;
	/** Context and processed tokens of this chat tab, across agent sessions. */
	readonly conversation: ConversationContext;
	/** Summary from a Nova compact, sent with the first prompt of the new agent session. */
	pendingSummary?: string;
	/** The "compacting would not help" notice was already shown in this tab. */
	fixedPartNoticeShown?: boolean;
}

/** One `session/prompt` that ran to the end: the agent's result and the text it wrote. */
interface PromptRun {
	readonly result: AcpPromptResult;
	readonly text: string;
}

/** What the activity panel of one answer has shown so far. */
interface RunActivity {
	readonly runId: string;
	readonly toolCalls: Map<string, { title: string; kind?: string; shown: boolean; done: boolean; diff?: string }>;
	/** Bumped when the agent writes text, so the next stretch of reasoning opens a new panel section. */
	thoughtSegment: number;
	planPending: number | undefined;
}

/** How long a summary queued for "the next new chat" of an agent waits for that chat before it is forgotten. */
const QUEUED_SUMMARY_MINUTES = 30;

/** ACP config options that become pickers in the chat input, in display order: each slot matches an ACP category or one of the known option ids. */
const PICKER_SLOTS: readonly { readonly category: string; readonly ids: readonly string[] }[] = [
	{ category: 'model', ids: ['model'] },
	{ category: 'mode', ids: ['mode'] },
	{ category: 'thought_level', ids: ['effort', 'reasoning_effort'] },
];

/** Permission modes (Claude Code, Codex, Gemini) that approve every tool call, and those that approve reading and editing files. */
const FULL_ACCESS_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'agent-full-access', 'full-access', 'yolo']);
const EDIT_MODES: ReadonlySet<string> = new Set(['acceptEdits', 'agent', 'autoEdit']);
const EDIT_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'edit']);

/** Option ids used for agents that report models/modes outside of config options. */
const LEGACY_MODEL_ID = 'acp.model';
const LEGACY_MODE_ID = 'acp.mode';

/** Environment variable an agent reads for each API key provider ACP reports in `authMethods[]._meta['api-key'].provider`. */
const API_KEY_ENV: Record<string, string> = { openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

/** Clears the chat that has the focus, then shows in it which saved summary the new chat starts from. */
export async function clearChatAndAnnounceSummary(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.chat.newChat');
	await announceSummary();
}

/** Sends `/nova-loaded` to the focused chat; the bridge answers it without the model (see handleRequest). */
export async function announceSummary(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 400));
	await vscode.commands.executeCommand('workbench.action.chat.nova.sendInput', `/${NOVA_LOADED_COMMAND}`);
}

export class AgentSessionProvider implements vscode.ChatSessionContentProvider, vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly controller: vscode.ChatSessionItemController;
	private readonly sessions = new Map<string, SessionState>();
	private connection: Promise<AcpConnection> | undefined;
	/** Config options reported by the agent for new sessions (from the first session/new). */
	private configOptions: readonly AcpConfigOption[] | undefined;
	/** A session created ahead of time to discover the config options, reused by the next new chat (if the tool profile still matches). */
	private spareSession: { readonly result: Promise<AcpNewSessionResult>; readonly toolProfile: ToolProfile } | undefined;
	private readonly inputStates = new Set<vscode.ChatSessionInputState>();
	/** Input states rebuilt from a session's applied options because the chat had lost them; pushed back so the picker shows them. */
	private readonly restoredInputStates = new WeakSet<vscode.ChatSessionInputState>();
	private authMethods: readonly AcpAuthMethod[] = [];
	/** Whether the agent accepts images in a prompt (ACP promptCapabilities.image). */
	private imagePrompts = false;
	/** Slash commands the agent reported (`available_commands_update`); they feed the `/` completion list of the chat. */
	private commands: readonly AcpAvailableCommand[] = [];
	private readonly commandsChanged = new vscode.EventEmitter<void>();
	/** A saved summary that the next new chat of this agent starts from (set by `/nova-save` and "Resume Saved Conversation"). */
	private queuedSummary: { readonly summary: string; readonly queuedAt: number; readonly options: ReadonlyMap<string, string>; readonly code: number; readonly title: string } | undefined;

	constructor(private readonly agent: AgentDefinition, private readonly secrets: vscode.SecretStorage, private readonly log: vscode.LogOutputChannel, private readonly metrics: RecentMetrics, private readonly store: SummaryStore) {
		this.controller = vscode.chat.createChatSessionItemController(agent.type, async () => {
			this.controller.items.replace([...this.sessions.values()].map(s => s.item));
		});
		this.disposables.push(this.controller);

		this.controller.newChatSessionItemHandler = async context => {
			const resource = vscode.Uri.from({ scheme: agent.type, path: `/${randomId()}` });
			return this.createSession(resource, context.request.prompt).item;
		};

		this.controller.getChatSessionInputState = async (sessionResource, context) => {
			// NOVA: without a previous state (proxy commands, refreshes) a session that already talks to the agent keeps
			// the options it runs with, instead of falling back to the agent's default model.
			const known = sessionResource && !context.previousInputState ? this.sessions.get(sessionResource.toString()) : undefined;
			const restored = !!known?.acpSessionId && known.appliedOptions.size > 0;
			// NOVA: the first chat after a Nova save starts with the model, mode and effort of the tab that was saved, not the agent default.
			const queuedOptions = !restored && !known?.acpSessionId ? this.freshQueuedSummary()?.options : undefined;
			const state = this.controller.createChatSessionInputState(this.buildGroups(context.previousInputState, restored ? known!.appliedOptions : queuedOptions));
			if (restored) {
				this.restoredInputStates.add(state);
			}
			this.inputStates.add(state);
			state.onDidDispose(() => this.inputStates.delete(state));
			// NOVA: this runs for every provider when the IDE opens, so it must not start the agent (see provideChatSessionContent).
			return state;
		};

		const participant = vscode.chat.createChatParticipant(agent.type, (request, context, stream, token) => this.handleRequest(request, context, stream, token));
		participant.iconPath = new vscode.ThemeIcon(agent.icon);
		this.disposables.push(participant);
		this.disposables.push(vscode.chat.registerChatSessionContentProvider(agent.type, this, participant, { supportsInterruptions: true }));

		// NOVA: the chat only lists `/commands` it can find itself (prompt files, skills). The agent knows its own commands
		// (skills, `~/.claude/commands`, plugins...), so report them as built-in prompts to make them show up in the `/` list.
		this.disposables.push(this.commandsChanged);
		this.disposables.push(vscode.chat.registerChatSessionCustomizationProvider(agent.type,
			{ label: agent.label, iconId: agent.icon, supportedTypes: [vscode.ChatSessionCustomizationType.Prompt] },
			{
				onDidChange: this.commandsChanged.event,
				provideChatSessionCustomizations: () => this.provideSlashCommands()
			}));
	}

	private provideSlashCommands(): vscode.ChatSessionCustomizationItem[] {
		// NOVA: this is asked for every provider when the IDE opens. Starting the agent here would launch all of them at once,
		// so the list stays empty until the user opens a chat of this provider, which starts the agent and fills it in.
		// The Nova compact is handled here, not by the agent, so it is always listed.
		const novaCompact: vscode.ChatSessionCustomizationItem = {
			uri: vscode.Uri.from({ scheme: 'agent-builtin', path: `/${NOVA_COMPACT_COMMAND}` }),
			type: vscode.ChatSessionCustomizationType.Prompt,
			name: NOVA_COMPACT_COMMAND,
			description: vscode.l10n.t('Summarize the conversation and go on in a new agent session (Nova compact) — optional focus'),
			source: 'builtin',
			userInvocable: true
		};
		const novaSave: vscode.ChatSessionCustomizationItem = {
			uri: vscode.Uri.from({ scheme: 'agent-builtin', path: `/${NOVA_SAVE_COMMAND}` }),
			type: vscode.ChatSessionCustomizationType.Prompt,
			name: NOVA_SAVE_COMMAND,
			description: vscode.l10n.t('Save a summary of the conversation, clear the chat and go on from the summary (Nova save) — optional focus'),
			source: 'builtin',
			userInvocable: true
		};
		return [novaCompact, novaSave, ...this.commands.filter(command => command.name !== NOVA_COMPACT_COMMAND && command.name !== NOVA_SAVE_COMMAND).map((command): vscode.ChatSessionCustomizationItem => ({
			// `agent-builtin` marks a command without a file: the chat sends the typed `/name` to the agent as plain text.
			uri: vscode.Uri.from({ scheme: 'agent-builtin', path: `/${command.name}` }),
			type: vscode.ChatSessionCustomizationType.Prompt,
			name: command.name,
			description: [command.description, command.input?.hint].filter(Boolean).join(' — ') || undefined,
			source: 'builtin',
			userInvocable: true
		}))];
	}

	private setCommands(commands: readonly AcpAvailableCommand[]): void {
		this.commands = commands;
		this.log.info(`[${this.agent.label}] ${commands.length} slash commands available`);
		this.commandsChanged.fire();
	}

	private createSession(resource: vscode.Uri, prompt: string): SessionState {
		const label = (prompt || this.agent.label).split('\n')[0].slice(0, 80);
		const item = this.controller.createChatSessionItem(resource, label);
		item.iconPath = new vscode.ThemeIcon(this.agent.icon);
		item.timing = { created: Date.now() };
		const state: SessionState = { acpSessionId: undefined, item, appliedOptions: new Map(), conversation: new ConversationContext() };
		this.sessions.set(resource.toString(), state);
		this.controller.items.add(item);
		return state;
	}

	dispose(): void {
		void this.connection?.then(c => c.dispose(), () => undefined);
		this.disposables.forEach(d => d.dispose());
	}

	provideChatSessionContent(resource: vscode.Uri, _token: vscode.CancellationToken, context: { readonly inputState: vscode.ChatSessionInputState }): vscode.ChatSession {
		// NOVA: a session of this provider is being opened, the first sign that the user wants it. Start the agent and discover
		// its models in the background (pickers fill in when ready) instead of launching every agent when the IDE opens.
		void this.warmUp();
		const state = this.sessions.get(resource.toString());
		// NOVA: the chat forgets the options of a tab when it recreates the tab's session data (e.g. switching tabs), and the
		// picker then falls back to the agent's default model, which the next message would switch to. A session that
		// already talks to the agent keeps the options it runs with.
		const restore = !!state?.acpSessionId && state.appliedOptions.size > 0;
		const groups = restore ? this.buildGroups(undefined, state!.appliedOptions) : context?.inputState.groups ?? [];
		const options: Record<string, vscode.ChatSessionProviderOptionItem> = {};
		for (const group of groups) {
			if (group.selected) {
				options[group.id] = group.selected;
			}
		}
		if (restore) {
			this.log.info(`[${this.agent.label}] reopened session ${state!.acpSessionId}; keeping its options (${Object.entries(options).map(([id, item]) => `${id} ${item.id}`).join(', ')})`);
		}
		return { title: state?.item.label, history: [], options, requestHandler: undefined };
	}

	// --- agent process -------------------------------------------------------------------

	private getConnection(): Promise<AcpConnection> {
		if (!this.connection) {
			const config = vscode.workspace.getConfiguration(this.agent.settingsSection);
			const command = config.get<string>('command') || this.agent.defaultCommand;
			const args = config.get<string[]>('args') ?? [...this.agent.defaultArgs];
			const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			this.log.info(`[${this.agent.label}] starting ${command} ${args.join(' ')}`);
			const connection = this.readAgentEnv().then(env => AcpConnection.start(command, args, cwd, env, this.createHandlers(), this.log)).then(({ connection, authMethods, imagePrompts }) => {
				this.authMethods = authMethods;
				this.imagePrompts = imagePrompts;
				connection.onDidUpdate(({ update }) => {
					if (update.sessionUpdate === 'available_commands_update' && update.availableCommands) {
						this.setCommands(update.availableCommands);
					}
				});
				connection.onDidExit(() => {
					// Sessions live inside the process; forget them so the next request starts over.
					if (this.connection === pending) {
						this.restart();
					}
				});
				return connection;
			});
			const pending = connection;
			this.connection = pending;
			pending.catch(() => {
				if (this.connection === pending) {
					this.connection = undefined;
				}
			});
		}
		return this.connection;
	}

	private newAcpSession(toolProfile: ToolProfile): Promise<AcpNewSessionResult> {
		return this.withAuthentication(() => this.doNewAcpSession(toolProfile));
	}

	private async doNewAcpSession(toolProfile: ToolProfile): Promise<AcpNewSessionResult> {
		const connection = await this.getConnection();
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const result = await connection.request<AcpNewSessionResult>('session/new', {
			// opencode rejects backslash paths on Windows
			cwd: folder.replace(/\\/g, '/'),
			mcpServers: readNovaBrowserMcpServers(toolProfile)
		});
		this.log.info(`[${this.agent.label}] new session ${result.sessionId} with the "${toolProfile}" Nova tool profile`);
		const options = [...(result.configOptions ?? [])];
		// Agents that predate config options (e.g. Gemini CLI) report models and modes separately.
		if (!options.some(o => o.category === 'model' || o.id === 'model') && result.models?.availableModels?.length) {
			options.push({ id: LEGACY_MODEL_ID, name: 'Model', category: 'model', type: 'select', currentValue: result.models.currentModelId, options: result.models.availableModels.map(m => ({ value: m.modelId, name: m.name, description: m.description })) });
		}
		if (!options.some(o => o.category === 'mode' || o.id === 'mode') && result.modes?.availableModes?.length) {
			options.push({ id: LEGACY_MODE_ID, name: 'Mode', category: 'mode', type: 'select', currentValue: result.modes.currentModeId, options: result.modes.availableModes.map(m => ({ value: m.id, name: m.name, description: m.description })) });
		}
		if (options.length) {
			this.setConfigOptions(options);
		}
		return result;
	}

	private async warmUp(): Promise<void> {
		if (this.configOptions) {
			return;
		}
		try {
			if (await this.ensureGatewayKey()) {
				await this.ensureConfigOptions();
			}
		} catch (error) {
			this.log.warn(`could not load agent options: ${error}`);
		}
	}

	private async ensureConfigOptions(): Promise<void> {
		if (!this.spareSession) {
			// Background warm-up: never prompt for sign-in here, only when the user sends a request.
			const toolProfile = readToolProfile();
			const spare = { result: this.doNewAcpSession(toolProfile), toolProfile };
			this.spareSession = spare;
			spare.result.catch(() => {
				if (this.spareSession === spare) {
					this.spareSession = undefined;
				}
			});
		}
		await this.spareSession.result;
	}

	private takeSpareSession(): Promise<AcpNewSessionResult> {
		const spare = this.spareSession;
		this.spareSession = undefined;
		const toolProfile = readToolProfile();
		// The catalog is fixed when the session is created, so a spare made before the setting changed is not reused.
		return spare && spare.toolProfile === toolProfile ? spare.result : this.newAcpSession(toolProfile);
	}

	private setConfigOptions(options: readonly AcpConfigOption[]): void {
		this.configOptions = options;
		for (const state of this.inputStates) {
			if (!state.sessionResource || !this.sessions.get(state.sessionResource.toString())?.acpSessionId) {
				state.groups = this.buildGroups(state);
			}
		}
	}

	/** Picker groups from the agent's options; the selection comes from `applied` (what a session runs with), else `previous`, else the agent default. */
	private buildGroups(previous: vscode.ChatSessionInputState | undefined, applied?: ReadonlyMap<string, string>): vscode.ChatSessionProviderOptionGroup[] {
		const groups: vscode.ChatSessionProviderOptionGroup[] = [];
		for (const slot of PICKER_SLOTS) {
			const option = this.configOptions?.find(o => o.type === 'select' && o.options?.length && (o.category === slot.category || slot.ids.includes(o.id)));
			if (!option) {
				continue;
			}
			const items: vscode.ChatSessionProviderOptionItem[] = option.options!.map(o => ({
				id: o.value,
				name: o.name,
				description: o.description,
				icon: slot.category === 'model' ? vendorIcon(o.value, o.name, this.agent.defaultVendor) : undefined,
				default: o.value === option.currentValue
			}));
			const appliedValue = applied?.get(option.id);
			const previousSelection = previous?.groups.find(g => g.id === option.id)?.selected;
			const selected = items.find(i => i.id === appliedValue) ?? items.find(i => i.id === previousSelection?.id) ?? items.find(i => i.default) ?? items[0];
			groups.push({ id: option.id, name: localizedOptionName(slot.category, option.name), items, selected });
		}
		return groups;
	}

	// --- requests ----------------------------------------------------------------------------

	private async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const sessionContext = context.chatSessionContext;
		const resource = sessionContext?.chatSessionItem.resource;
		let state = resource ? this.sessions.get(resource.toString()) : undefined;
		if (sessionContext && resource && !state && !sessionContext.isUntitled) {
			// A session from before the window reloaded (e.g. a restored chat tab): the agent process no longer
			// knows it, so the conversation continues in a new agent session.
			state = this.createSession(resource, request.prompt);
			stream.markdown(vscode.l10n.t('_This session was opened before the window reloaded, so {0} starts without its earlier messages._', this.agent.label) + '\n\n');
		}
		if (!sessionContext || !state) {
			stream.markdown(vscode.l10n.t('Start a new {0} session from the session picker to talk to the agent.', this.agent.label));
			return {};
		}

		if (parseCompactCommand(request.command ? `/${request.command} ${request.prompt}` : request.prompt)?.kind === 'loaded') {
			// NOVA: Nova IDE sends this to the chat it just cleared; it only says which saved summary the chat starts from, so no agent or model is involved.
			const queued = this.freshQueuedSummary();
			stream.markdown(queued
				? vscode.l10n.t('_Summary #{0} "{1}" is now in the context of this conversation. It goes to {2} together with your first message._', queued.code, queued.title, this.agent.label)
				: vscode.l10n.t('_No saved summary is waiting for this conversation._'));
			return {};
		}

		state.item.status = vscode.ChatSessionStatus.InProgress;
		state.item.timing = { created: state.item.timing?.created ?? Date.now(), lastRequestStarted: Date.now() };
		this.controller.items.add(state.item);

		const startedAt = Date.now();
		let connection: AcpConnection;
		let modelChange: string | undefined;
		try {
			if (!await this.ensureGatewayKey()) {
				throw new Error(vscode.l10n.t('{0} needs an API key. Run "Nova Agents: Set API Key" to add it.', this.agent.label));
			}
			// NOVA: the agent process and its session outlive the request, so later messages have nothing to connect to.
			if (!this.connection || !state.acpSessionId) {
				stream.progress(vscode.l10n.t('Connecting to {0}…', this.agent.label));
			}
			connection = await this.getConnection();
			if (!state.acpSessionId) {
				state.acpSessionId = (await this.takeSpareSession()).sessionId;
			}
			modelChange = await this.applyOptions(connection, state, sessionContext.inputState);
			if (this.restoredInputStates.has(sessionContext.inputState)) {
				// NOVA: the chat had no options for this tab; hand them back so its pickers show what the session runs with.
				this.log.info(`[${this.agent.label}] session ${state.acpSessionId}: the chat had lost the options of this tab; keeping ${[...state.appliedOptions].map(([id, value]) => `${id} ${value}`).join(', ')}`);
				sessionContext.inputState.groups = [...sessionContext.inputState.groups];
			}
		} catch (error) {
			this.finish(state, vscode.ChatSessionStatus.Failed);
			return this.reportError(error, stream);
		}

		this.log.info(`[${this.agent.label}] request: connection and session ready after ${Date.now() - startedAt} ms (session ${state.acpSessionId}, first prompt: ${!state.manualSent})`);
		if (modelChange) {
			// NOVA: a model switch changes the price of every following call, so it never happens silently.
			stream.markdown(vscode.l10n.t('_Model changed: {0}._', modelChange) + '\n\n');
		}

		try {
			const command = parseCompactCommand(request.command ? `/${request.command} ${request.prompt}` : request.prompt);
			if (command?.kind === 'nova') {
				await this.novaCompact(connection, state, stream, token, command.focus, modelChange);
				this.finish(state, vscode.ChatSessionStatus.Completed);
				return {};
			}
			if (command?.kind === 'save') {
				const saved = await this.novaSave(connection, state, stream, token, command.focus, modelChange);
				this.finish(state, vscode.ChatSessionStatus.Completed);
				if (saved) {
					// NOVA: the chat clears itself after this request ends; the next message of the new chat starts from the summary.
					setTimeout(() => void clearChatAndAnnounceSummary(), 300);
				}
				return {};
			}
			if (!command) {
				await this.autoCompact(connection, state, stream, token);
				if (token.isCancellationRequested) {
					this.finish(state, vscode.ChatSessionStatus.Completed);
					return {};
				}
			}

			const prompt = await toPromptBlocks(request, this.imagePrompts);
			const attachments = prompt.length - 1;
			// The agent is an external process that knows nothing about Nova IDE: hand it the manual once per session.
			// The mode is read here, at the first prompt, so changing it never re-sends the manual in the middle of a conversation.
			const manual = state.manualSent ? undefined : await this.readIdeManual();
			if (!state.pendingSummary && !state.manualSent) {
				state.pendingSummary = this.takeQueuedSummary();
			}
			const summary = state.pendingSummary;
			if (summary) {
				prompt.unshift({ type: 'text', text: wrapSummary(summary) });
			}
			if (manual) {
				prompt.unshift({ type: 'text', text: `<nova-ide-manual>\n${manual}\n</nova-ide-manual>` });
			}
			state.manualSent = true;
			const kind: RequestKind = command?.kind === 'native' ? 'native-compact' : 'message';
			await this.runPrompt(connection, state, prompt, stream, token, {
				kind,
				render: true,
				shape: { messageChars: request.prompt.length, manualChars: manual?.length ?? 0, summaryChars: summary?.length ?? 0, attachments },
				modelChange
			});
			state.pendingSummary = undefined;
			if (kind === 'native-compact') {
				// The manual sat in the history the agent just summarized away: send it again with the next prompt.
				state.manualSent = false;
				state.conversation.recordCompact();
			} else {
				this.showContextNotes(state, stream);
			}
			this.finish(state, vscode.ChatSessionStatus.Completed);
			return {};
		} catch (error) {
			this.finish(state, vscode.ChatSessionStatus.Failed);
			return this.reportError(error, stream);
		}
	}

	/**
	 * Sends one prompt to the tab's agent session and waits for the end of the turn. With `render`, the answer is
	 * streamed into the chat; without it (summaries, compacts) the agent's text is only collected. Every run is
	 * measured and added to the tab's context accounting, even when it fails.
	 */
	private async runPrompt(connection: AcpConnection, state: SessionState, prompt: AcpContentBlock[], stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options: {
		readonly kind: RequestKind;
		readonly render: boolean;
		readonly shape: { readonly messageChars: number; readonly manualChars: number; readonly summaryChars?: number; readonly attachments: number };
		readonly modelChange?: string;
	}): Promise<PromptRun> {
		const acpSessionId = state.acpSessionId!;
		const startedAt = Date.now();
		let firstUpdateAt: number | undefined;
		const editedFiles = new Set<string>();
		let text = '';
		const lastMessage = { id: undefined as string | undefined };
		// NOVA: one collector per request, fed only by this session's updates, so chat tabs running at the same time never mix.
		const metrics = new RequestMetrics(randomId(), this.agent.label, acpSessionId, Date.now, options.kind);
		const activity: RunActivity = { runId: randomId(), toolCalls: new Map(), thoughtSegment: 0, planPending: undefined };
		metrics.recordPrompt(options.shape);

		const listener = connection.onDidUpdate(({ sessionId, update }) => {
			if (sessionId !== acpSessionId) {
				return;
			}
			firstUpdateAt ??= Date.now();
			metrics.observe(update);
			if (update.sessionUpdate === 'usage_update') {
				this.log.info(`[${this.agent.label}] usage: context ${update.used ?? '?'} of ${update.size ?? '?'} tokens${update.cost ? `, cost ${update.cost.amount} ${update.cost.currency}` : ''}`);
				if (options.render && update.used !== undefined && update.size) {
					// NOVA: feeds the context usage donut of the chat input (used tokens out of the model's context window).
					stream.usage({ promptTokens: update.used, completionTokens: 0, contextWindow: update.size, ...processedUsage(state.conversation) });
				}
			}
			if (!options.render) {
				if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
					if (update.messageId && lastMessage.id && update.messageId !== lastMessage.id) {
						text += '\n\n';
					}
					lastMessage.id = update.messageId ?? lastMessage.id;
					text += update.content.text;
				} else if (update.sessionUpdate === 'config_option_update' && update.configOptions) {
					this.configOptions = update.configOptions;
				}
				return;
			}
			this.renderUpdate(update, stream, activity, editedFiles, lastMessage);
		});
		const cancel = token.onCancellationRequested(() => connection.notify('session/cancel', { sessionId: acpSessionId }));

		let result: AcpPromptResult | undefined;
		try {
			let attempt = 0;
			result = await this.withAuthentication(() => {
				metrics.recordAttempt(attempt++ > 0);
				return connection.request<AcpPromptResult>('session/prompt', { sessionId: acpSessionId, prompt });
			});
			this.log.info(`[${this.agent.label}] response${options.kind === 'message' ? '' : ` (${options.kind})`}: first update after ${firstUpdateAt ? firstUpdateAt - startedAt : '?'} ms, finished after ${Date.now() - startedAt} ms, stopReason ${result.stopReason}, prompt ${JSON.stringify(prompt).length} characters, result ${JSON.stringify(result)}`);
			if (options.render) {
				for (const file of editedFiles) {
					stream.reference(vscode.Uri.file(file));
				}
				if (result.stopReason === 'refusal') {
					stream.markdown('\n\n' + vscode.l10n.t('_The agent refused to continue._'));
				} else if (result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests') {
					stream.markdown('\n\n' + vscode.l10n.t('_The agent stopped: limit reached ({0})._', result.stopReason));
				}
			}
			return { result, text };
		} finally {
			listener.dispose();
			cancel.dispose();
			const processed = requestProcessedTokens({
				semantics: this.agent.usageSemantics,
				usage: result?.usage,
				meta: result?._meta,
				contextUpdates: metrics.contextUpdates,
				nativeCompact: options.kind === 'native-compact'
			});
			state.conversation.record({ context: metrics.lastContext, contextSize: metrics.lastContextSize, processed, userMessage: options.kind === 'message' });
			if (options.render && metrics.lastContext !== undefined && metrics.lastContextSize) {
				// NOVA: the donut gets the conversation total including this request.
				stream.usage({ promptTokens: metrics.lastContext, completionTokens: 0, contextWindow: metrics.lastContextSize, ...processedUsage(state.conversation) });
			}
			if (vscode.workspace.getConfiguration('nova.agents').get<boolean>('requestMetrics', true)) {
				const report = metrics.finish({
					stopReason: result?.stopReason,
					usage: result?.usage,
					failed: !result,
					models: modelsUsed(result?._meta),
					modelChange: options.modelChange,
					processedTokens: processed.tokens,
					processedSource: processed.source,
					processedTotal: state.conversation.processedTotal
				});
				this.metrics.add(report);
				this.log.info(`[${this.agent.label}] ${formatMetrics(report)}`);
			}
		}
	}

	/** The warning about a large context and, when enabled, the running total, at the end of an answer. */
	private showContextNotes(state: SessionState, stream: vscode.ChatResponseStream): void {
		const config = vscode.workspace.getConfiguration('nova.agents');
		const conversation = state.conversation;
		const locale = vscode.env.language;
		const total = () => conversation.processedTotal > 0 ? `${conversation.approximate ? '≈ ' : ''}${formatTokenCount(conversation.processedTotal, locale)}` : vscode.l10n.t('n/a');
		const warning = conversation.takeWarning(config.get<number>('contextWarning.threshold', 100000));
		if (warning) {
			const context = formatTokenCount(warning.context, locale);
			const auto = this.autoCompactOptions();
			stream.markdown('\n\n' + (auto.enabled && auto.providerAllowed
				? vscode.l10n.t('_Context: {0} tokens re-read on every model call · this conversation has processed {1} tokens so far. It will be summarized before a message once it passes the auto compact limit._', context, total())
				: vscode.l10n.t('_Context: {0} tokens re-read on every model call · this conversation has processed {1} tokens so far. Run /nova-compact to go on from a summary in a new agent session, or start a new tab._', context, total())));
		} else if (config.get<boolean>('contextWarning.showProcessedTotal', false)) {
			const context = conversation.lastContext === undefined ? vscode.l10n.t('n/a') : formatTokenCount(conversation.lastContext, locale);
			stream.markdown('\n\n' + vscode.l10n.t('_Conversation: {0} tokens processed · context {1}._', total(), context));
		}
	}

	private autoCompactOptions(): { enabled: boolean; threshold: number; minMessagesBetween: number; providerAllowed: boolean; mode: 'nova' | 'native' } {
		const config = vscode.workspace.getConfiguration('nova.agents.autoCompact');
		const providers = config.get<string[]>('providers', []);
		const id = this.agent.settingsSection.split('.').pop() ?? this.agent.type;
		return {
			enabled: config.get<boolean>('enabled', false),
			threshold: config.get<number>('threshold', 100000),
			minMessagesBetween: config.get<number>('minMessagesBetween', 5),
			providerAllowed: !providers.length || providers.includes(id),
			mode: config.get<string>('mode', 'nova') === 'native' ? 'native' : 'nova'
		};
	}

	/** Compacts the conversation before the user's message when it passed the configured limit (off by default). */
	private async autoCompact(connection: AcpConnection, state: SessionState, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const options = this.autoCompactOptions();
		const decision = decideAutoCompact(state.conversation, options);
		if (!decision.compact) {
			if (decision.reason === 'too-soon' || decision.reason === 'fixed-part-too-big') {
				this.log.info(`[${this.agent.label}] auto compact skipped (${decision.reason}): context ${state.conversation.lastContext}, ${state.conversation.messagesSinceCompact} messages since the last compact`);
			}
			if (decision.reason === 'fixed-part-too-big' && !state.fixedPartNoticeShown) {
				state.fixedPartNoticeShown = true;
				stream.markdown(vscode.l10n.t('_The last compact already left {0} tokens of context, close to the auto compact limit, so compacting again would save little. Start a new tab to reduce it._', formatTokenCount(state.conversation.contextAfterCompact ?? 0, vscode.env.language)) + '\n\n');
			}
			return;
		}
		this.log.info(`[${this.agent.label}] auto compact (${options.mode}): context ${state.conversation.lastContext} ≥ ${options.threshold}`);
		if (options.mode === 'native') {
			await this.nativeCompact(connection, state, stream, token);
		} else {
			await this.novaCompact(connection, state, stream, token, '', undefined);
		}
	}

	/**
	 * Asks the agent, in the current session, for the hand-off summary of the conversation (not shown in the chat).
	 * Undefined when there is nothing to summarize or the agent did not return a usable summary; the user is told why.
	 */
	private async summarize(connection: AcpConnection, state: SessionState, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, focus: string, modelChange: string | undefined, progress: string, failure: string): Promise<{ readonly summary: string; readonly title: string; readonly maxChars: number } | undefined> {
		if (!state.manualSent) {
			stream.markdown(vscode.l10n.t('_There is nothing to summarize yet in this conversation._') + '\n\n');
			return undefined;
		}
		stream.progress(progress);
		const maxChars = clampSummaryChars(vscode.workspace.getConfiguration('nova.agents.compact').get<number>('maxSummaryChars', DEFAULT_SUMMARY_CHARS));
		const request = buildSummaryRequest(maxChars, focus);
		let run: PromptRun;
		try {
			run = await this.runPrompt(connection, state, [{ type: 'text', text: request }], stream, token, {
				kind: 'nova-compact',
				render: false,
				shape: { messageChars: request.length, manualChars: 0, attachments: 0 },
				modelChange
			});
		} catch (error) {
			this.log.warn(`[${this.agent.label}] nova compact failed: ${error instanceof Error ? error.message : String(error)}`);
			stream.markdown(vscode.l10n.t('_Could not summarize the conversation, so {0}._', failure) + '\n\n');
			return undefined;
		}
		if (token.isCancellationRequested || run.result.stopReason === 'cancelled') {
			return undefined;
		}
		const { title, body } = splitTitle(run.text);
		const summary = cleanSummary(body);
		if (!summary) {
			this.log.warn(`[${this.agent.label}] nova compact: the agent returned ${run.text.length} characters, not a usable summary`);
			stream.markdown(vscode.l10n.t('_The agent did not return a usable summary, so {0}._', failure) + '\n\n');
			return undefined;
		}
		return { summary, title: chooseTitle(title, summary), maxChars };
	}

	/**
	 * Nova compact: the agent writes a hand-off summary of the conversation (not shown in the chat), and the tab
	 * goes on in a new agent session with the same options, whose first prompt carries the manual and the summary.
	 * The visible chat history stays as it is. On any failure the conversation stays in the current session.
	 */
	private async novaCompact(connection: AcpConnection, state: SessionState, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, focus: string, modelChange: string | undefined): Promise<boolean> {
		const contextBefore = state.conversation.lastContext;
		const failure = vscode.l10n.t('the conversation goes on in the same session');
		const summarized = await this.summarize(connection, state, stream, token, focus, modelChange, vscode.l10n.t('Summarizing the conversation to go on in a new {0} session…', this.agent.label), failure);
		if (!summarized) {
			return false;
		}
		const { summary, title, maxChars } = summarized;

		let newSessionId: string;
		try {
			newSessionId = (await this.takeSpareSession()).sessionId;
			await this.restoreOptions(connection, newSessionId, state.appliedOptions);
		} catch (error) {
			this.log.warn(`[${this.agent.label}] nova compact: could not start the new session: ${error instanceof Error ? error.message : String(error)}`);
			stream.markdown(vscode.l10n.t('_Could not start a new {0} session, so the conversation goes on in the same one._', this.agent.label) + '\n\n');
			return false;
		}
		const previousSessionId = state.acpSessionId;
		state.acpSessionId = newSessionId;
		state.manualSent = false;
		state.pendingSummary = summary;
		state.conversation.recordCompact();
		this.log.info(`[${this.agent.label}] nova compact: session ${previousSessionId} → ${newSessionId}, summary ${summary.length} characters (asked for at most ${maxChars}), context before ${contextBefore ?? 'n/a'}`);

		const saved = await this.saveSummary(title, summary, contextBefore, state.appliedOptions);
		const locale = vscode.env.language;
		stream.markdown(vscode.l10n.t('_Conversation summarized in {0} characters (≈ {1} tokens) in place of {2} tokens of context. The next message goes to a new {3} session that starts from the summary._',
			summary.length, formatTokenCount(Math.round(summary.length / 4), locale), contextBefore === undefined ? vscode.l10n.t('n/a') : formatTokenCount(contextBefore, locale), this.agent.label));
		if (saved) {
			stream.markdown(' ');
			stream.anchor(saved.file, vscode.l10n.t('View the summary'));
		}
		stream.markdown('\n\n');
		return true;
	}

	/**
	 * Nova save (the button under each answer): the agent writes the summary with a title, which is saved; the caller then
	 * clears the chat, and the first message of the new chat carries the summary. Nothing is switched here, so on any
	 * failure the conversation stays as it is. The model is only used for the summary: loading it again costs no model call.
	 */
	private async novaSave(connection: AcpConnection, state: SessionState, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, focus: string, modelChange: string | undefined): Promise<boolean> {
		const contextBefore = state.conversation.lastContext;
		const failure = vscode.l10n.t('the chat stays as it is');
		const summarized = await this.summarize(connection, state, stream, token, focus, modelChange, vscode.l10n.t('Summarizing and saving the conversation…'), failure);
		if (!summarized) {
			return false;
		}
		const { summary, title } = summarized;
		const saved = await this.saveSummary(title, summary, contextBefore, state.appliedOptions);
		if (!saved) {
			stream.markdown(vscode.l10n.t('_Could not save the summary, so the chat stays as it is._') + '\n\n');
			return false;
		}
		this.queueSummary(summary, { code: saved.code, title }, state.appliedOptions);
		this.log.info(`[${this.agent.label}] nova save: #${saved.code} "${title}", summary ${summary.length} characters, context before ${contextBefore ?? 'n/a'}; clearing the chat`);
		stream.markdown(vscode.l10n.t('_Saved as #{0} "{1}". The chat is cleared now, and your next message starts from the summary._', saved.code, title) + '\n\n');
		void vscode.window.setStatusBarMessage(vscode.l10n.t('Conversation saved as #{0} "{1}". Run "Nova: Resume Saved Conversation" to go back to it.', saved.code, title), 15000);
		return true;
	}

	/**
	 * The next new chat of this agent starts from this summary, sent with its first message (no model call to load it).
	 * `options` (model, mode, effort) are what that chat's pickers start with; empty means the agent default.
	 */
	queueSummary(summary: string, saved: { readonly code: number; readonly title: string }, options: ReadonlyMap<string, string> = new Map()): void {
		this.queuedSummary = { summary, queuedAt: Date.now(), options: new Map(options), code: saved.code, title: saved.title };
	}

	private freshQueuedSummary(): { readonly summary: string; readonly options: ReadonlyMap<string, string>; readonly code: number; readonly title: string } | undefined {
		const queued = this.queuedSummary;
		return queued && Date.now() - queued.queuedAt <= QUEUED_SUMMARY_MINUTES * 60_000 ? queued : undefined;
	}

	private takeQueuedSummary(): string | undefined {
		const queued = this.freshQueuedSummary();
		this.queuedSummary = undefined;
		if (!queued) {
			return undefined;
		}
		this.log.info(`[${this.agent.label}] the first message of this chat starts from a saved summary (${queued.summary.length} characters)`);
		return queued.summary;
	}

	/** The agent's own `/compact` (auto compact in `native` mode), when the agent offers it. */
	private async nativeCompact(connection: AcpConnection, state: SessionState, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<boolean> {
		if (!this.commands.some(command => command.name === 'compact')) {
			this.log.info(`[${this.agent.label}] auto compact skipped: the agent does not offer /compact`);
			return false;
		}
		const contextBefore = state.conversation.lastContext;
		stream.progress(vscode.l10n.t('Compacting the conversation with the /compact of {0}…', this.agent.label));
		try {
			const run = await this.runPrompt(connection, state, [{ type: 'text', text: '/compact' }], stream, token, {
				kind: 'native-compact',
				render: false,
				shape: { messageChars: '/compact'.length, manualChars: 0, attachments: 0 }
			});
			if (token.isCancellationRequested || run.result.stopReason === 'cancelled') {
				return false;
			}
		} catch (error) {
			this.log.warn(`[${this.agent.label}] native compact failed: ${error instanceof Error ? error.message : String(error)}`);
			stream.markdown(vscode.l10n.t('_Could not compact the conversation, so it goes on as it was._') + '\n\n');
			return false;
		}
		state.manualSent = false;
		state.conversation.recordCompact();
		stream.markdown(vscode.l10n.t('_Conversation compacted by {0} (the context was {1} tokens)._', this.agent.label, contextBefore === undefined ? vscode.l10n.t('n/a') : formatTokenCount(contextBefore, vscode.env.language)) + '\n\n');
		return true;
	}

	/** Keeps the summary for the user (see {@link SummaryStore}); never written to the user's folders. */
	private async saveSummary(title: string, summary: string, contextBefore: number | undefined, options: ReadonlyMap<string, string>): Promise<{ readonly file: vscode.Uri; readonly code: number } | undefined> {
		try {
			return await this.store.save({ title, agentType: this.agent.type, provider: this.agent.label, contextBefore, options: Object.fromEntries(options), summary });
		} catch (error) {
			this.log.warn(`[${this.agent.label}] could not save the compact summary: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * The Nova IDE manual for the first prompt, in the configured mode: the short quick rules
	 * (default), the whole SKILL.md of nova-browser-bridge, or nothing. Falls back to a short
	 * built-in summary if nova-browser-bridge cannot provide it.
	 */
	private async readIdeManual(): Promise<string | undefined> {
		const config = vscode.workspace.getConfiguration('nova.agents');
		const mode = config.get<ManualMode>('manualMode', 'compact');
		if (!config.get<boolean>('injectIdeManual', true) || mode === 'off') {
			return undefined;
		}
		let manual: string | undefined;
		try {
			// nova-browser-bridge owns the manual and knows how to cut its compact part.
			manual = await vscode.commands.executeCommand<string | undefined>('novaBrowserBridge.ideManual', mode);
		} catch (error) {
			this.log.warn(`[${this.agent.label}] could not get the Nova IDE manual: ${error instanceof Error ? error.message : String(error)}`);
		}
		manual ||= FALLBACK_IDE_MANUAL;
		this.log.info(`[${this.agent.label}] sending the Nova IDE manual (${mode}, ${manual.length} characters) with the first prompt`);
		return manual;
	}

	/** Sends the picker choices that changed to the agent; returns "old → new" when the model changed. */
	private async applyOptions(connection: AcpConnection, state: SessionState, inputState: vscode.ChatSessionInputState): Promise<string | undefined> {
		let modelChange: string | undefined;
		for (const group of inputState.groups) {
			const value = group.selected?.id;
			const previous = state.appliedOptions.get(group.id);
			if (!value || previous === value) {
				continue;
			}
			const current = this.configOptions?.find(o => o.id === group.id)?.currentValue;
			if (state.appliedOptions.size === 0 && current === value) {
				state.appliedOptions.set(group.id, value);
				continue;
			}
			this.log.info(`[${this.agent.label}] session ${state.acpSessionId}: option "${group.id}" ${previous ?? '(agent default)'} → ${value}`);
			await this.setOption(connection, state.acpSessionId!, group.id, value);
			if (previous !== undefined && this.isModelOption(group.id)) {
				const name = (id: string) => group.items.find(item => item.id === id)?.name ?? id;
				modelChange = `${name(previous)} → ${name(value)}`;
			}
			state.appliedOptions.set(group.id, value);
		}
		return modelChange;
	}

	/** Gives a new agent session the options the tab ran with (after a Nova compact). */
	private async restoreOptions(connection: AcpConnection, acpSessionId: string, applied: ReadonlyMap<string, string>): Promise<void> {
		for (const [id, value] of applied) {
			await this.setOption(connection, acpSessionId, id, value);
		}
	}

	private async setOption(connection: AcpConnection, acpSessionId: string, id: string, value: string): Promise<void> {
		if (id === LEGACY_MODEL_ID) {
			await connection.request('session/set_model', { sessionId: acpSessionId, modelId: value });
		} else if (id === LEGACY_MODE_ID) {
			await connection.request('session/set_mode', { sessionId: acpSessionId, modeId: value });
		} else {
			try {
				await connection.request('session/set_config_option', { sessionId: acpSessionId, configId: id, value });
			} catch (error) {
				// NOVA: switching the model can drop an option (Claude Haiku has no "effort"), but the picker
				// still holds the old choice. The agent then answers "Unknown config option", which is not a failure.
				const message = error instanceof Error ? error.message : String(error);
				const details = (error as { data?: { details?: string } } | undefined)?.data?.details ?? '';
				if (!/unknown config option/i.test(`${message} ${details}`)) {
					throw error;
				}
				this.log.info(`[${this.agent.label}] the agent has no "${id}" option for this model; skipping it`);
			}
		}
	}

	private isModelOption(id: string): boolean {
		if (id === LEGACY_MODEL_ID || id === 'model') {
			return true;
		}
		return this.configOptions?.find(o => o.id === id)?.category === 'model';
	}

	private renderUpdate(update: AcpSessionUpdate, stream: vscode.ChatResponseStream, activity: RunActivity, editedFiles: Set<string>, lastMessage: { id: string | undefined }): void {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				if (update.content?.type === 'text' && update.content.text) {
					// A new agent message (e.g. after a tool call) starts a new paragraph.
					if (update.messageId && lastMessage.id && update.messageId !== lastMessage.id) {
						stream.markdown('\n\n');
					}
					lastMessage.id = update.messageId ?? lastMessage.id;
					stream.markdown(update.content.text);
					activity.thoughtSegment++;
				}
				break;
			case 'agent_thought_chunk':
				// NOVA: the reasoning goes into the chat's collapsible activity panel (one per stretch of thinking), never as a new "Thinking…" line per event.
				if (update.content?.type === 'text' && update.content.text) {
					stream.thinkingProgress({ id: `${activity.runId}-thought-${activity.thoughtSegment}`, text: update.content.text });
				}
				break;
			case 'tool_call':
			case 'tool_call_update': {
				const id = update.toolCallId ?? '';
				const known = activity.toolCalls.get(id);
				const kind = update.kind ?? known?.kind;
				const target = update.locations?.[0]?.path;
				const title = target ? vscode.workspace.asRelativePath(target) : shortText(update.title || known?.title || '');
				const call = known ?? { title, kind, shown: false, done: false };
				call.title = title || call.title;
				call.kind = kind;
				activity.toolCalls.set(id, call);
				// ACP sends the content of a tool call (output text, file diffs) as an array, unlike message chunks.
				// The diff of an edit usually comes before the call completes, so it is kept until then.
				const content = Array.isArray(update.content) ? update.content as readonly AcpToolContentItem[] : undefined;
				call.diff = diffText(content) ?? call.diff;
				const rejected = update.status === 'failed' && typeof update.rawOutput === 'string' && update.rawOutput.includes('<tool_use_error>');
				if (rejected) {
					// NOVA: the agent rejected the call itself (e.g. "File has not been read yet") and the model fixes it and retries, so it is not a failure to show the user.
					this.log.info(`[${this.agent.label}] tool call rejected by the agent, not shown: ${(update.rawOutput as string).replace(/\s+/g, ' ').slice(0, 200)}`);
				}
				// NOVA: each tool call becomes one line of the activity panel ("Reading x", then "Read x"), which the chat collapses when the answer ends.
				if (!call.shown && !rejected) {
					call.shown = true;
					const part = new vscode.ChatToolInvocationPart(toolName(kind), id);
					part.enablePartialUpdate = true;
					part.isComplete = false;
					part.invocationMessage = new vscode.MarkdownString(describeToolCall(kind, call.title, 'running'));
					stream.push(part);
				}
				if (call.shown && !call.done && (update.status === 'completed' || update.status === 'failed')) {
					call.done = true;
					const failed = update.status === 'failed';
					const part = new vscode.ChatToolInvocationPart(toolName(kind), id);
					part.enablePartialUpdate = true;
					part.isComplete = true;
					part.pastTenseMessage = new vscode.MarkdownString(describeToolCall(kind, call.title, failed ? 'failed' : 'done'));
					const detail = kind === 'edit' ? call.diff : kind === 'execute' || failed ? toolOutputText(content, update.rawOutput) : undefined;
					if (detail) {
						part.toolSpecificData = { input: call.title, output: detail };
					}
					stream.push(part);
				}
				if (update.status === 'completed' && (kind === 'edit' || kind === 'delete' || kind === 'move')) {
					for (const location of update.locations ?? []) {
						editedFiles.add(location.path);
					}
				}
				break;
			}
			case 'plan':
				if (update.entries?.length) {
					const pending = update.entries.filter(e => e.status !== 'completed').length;
					if (pending !== activity.planPending) {
						activity.planPending = pending;
						stream.thinkingProgress({ id: `${activity.runId}-thought-${activity.thoughtSegment}`, text: '\n' + vscode.l10n.t('Plan: {0} of {1} steps left', pending, update.entries.length) + '\n' });
					}
				}
				break;
			case 'config_option_update':
				if (update.configOptions) {
					this.configOptions = update.configOptions;
				}
				break;
		}
	}

	private finish(state: SessionState, status: vscode.ChatSessionStatus): void {
		state.item.status = status;
		state.item.timing = { created: state.item.timing?.created ?? Date.now(), lastRequestStarted: state.item.timing?.lastRequestStarted, lastRequestEnded: Date.now() };
		this.controller.items.add(state.item);
	}

	private reportError(error: unknown, stream: vscode.ChatResponseStream): vscode.ChatResult {
		let message = error instanceof Error ? error.message : String(error);
		// NOVA: the agent's reason usually sits in error.data (the message alone is just "Internal error").
		const data = (error as { data?: unknown } | undefined)?.data;
		this.log.error(data === undefined ? message : `${message}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
		const details = (data as { details?: unknown } | undefined)?.details;
		if (typeof details === 'string' && details && !message.includes(details)) {
			message = `${message}: ${details}`; // e.g. Gemini: "Cannot enable privileged approval modes in an untrusted folder."
		}
		const isAuth = isAuthError(error);
		if (isAuth) {
			stream.markdown(vscode.l10n.t('{0} is not signed in. Run `{1}` in a terminal and try again.', this.agent.label, this.agent.loginHint));
		} else if (/ENOENT|not recognized|não é reconhecido/i.test(message)) {
			stream.markdown(vscode.l10n.t('Could not start `{0}`. Install it or set `{1}.command` in the settings.', this.agent.defaultCommand, this.agent.settingsSection));
		}
		return { errorDetails: { message } };
	}

	// --- authentication ----------------------------------------------------------------------

	/** Runs an agent call; when the agent reports it is not signed in, signs in and retries once. */
	private async withAuthentication<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (!isAuthError(error) || !this.authMethods.length) {
				throw error;
			}
			this.log.info(`[${this.agent.label}] authentication required: ${error instanceof Error ? error.message : error}`);
			if (!await this.authenticate()) {
				throw error;
			}
			return call();
		}
	}

	private async authenticate(): Promise<boolean> {
		const methods = this.authMethods;
		const picked = methods.length === 1 ? methods[0] : (await vscode.window.showQuickPick(
			methods.map(method => ({ label: method.name, detail: method.description, method })),
			{ title: vscode.l10n.t('Sign in to {0}', this.agent.label), placeHolder: vscode.l10n.t('Choose how {0} should authenticate', this.agent.label), ignoreFocusOut: true }
		))?.method;
		if (!picked) {
			return false;
		}

		const provider = picked._meta?.['api-key']?.provider;
		if (provider) {
			const envName = API_KEY_ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`;
			const key = await vscode.window.showInputBox({
				title: vscode.l10n.t('{0}: {1}', this.agent.label, picked.name),
				prompt: vscode.l10n.t('The key is kept in the secure storage of Nova IDE and passed to {0} as {1}.', this.agent.label, envName),
				password: true,
				ignoreFocusOut: true
			});
			if (!key) {
				return false;
			}
			await this.secrets.store(this.secretKey(envName), key);
			this.restart(); // the agent reads the key from its environment at startup
		}

		const connection = await this.getConnection();
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Signing in to {0}… finish in the browser if it opens.', this.agent.label),
			cancellable: false
		}, () => connection.request('authenticate', { methodId: picked.id }));
		this.log.info(`[${this.agent.label}] authenticated with ${picked.id}`);
		return true;
	}

	private restart(): void {
		void this.connection?.then(c => c.dispose(), () => undefined);
		this.connection = undefined;
		this.spareSession = undefined;
		for (const state of this.sessions.values()) {
			state.acpSessionId = undefined;
			state.appliedOptions.clear();
			state.manualSent = false;
			state.conversation.resetContext();
		}
	}

	private secretKey(envName: string): string {
		return `nova.agents.${this.agent.type}.${envName}`;
	}

	get label(): string {
		return this.agent.label;
	}

	private get gateway(): Gateway | undefined {
		return this.agent.gateway && GATEWAYS[this.agent.gateway];
	}

	/** The environment the agent process starts with: stored API keys and, for a gateway, the OpenCode setup for it. */
	private async readAgentEnv(): Promise<Record<string, string>> {
		const env = await this.readApiKeys();
		const gateway = this.gateway;
		if (gateway) {
			if (!env[gateway.envName]) {
				throw new Error(vscode.l10n.t('{0} needs an API key.', gateway.label));
			}
			env.OPENCODE_CONFIG_CONTENT = JSON.stringify(await gateway.buildConfig());
		}
		return env;
	}

	/** True when this provider has what it needs to start; a gateway without a stored key asks for it first. */
	async ensureGatewayKey(): Promise<boolean> {
		const gateway = this.gateway;
		if (!gateway || await this.secrets.get(this.secretKey(gateway.envName))) {
			return true;
		}
		return this.askGatewayKey();
	}

	/** Asks for the API key of this gateway, stores it and restarts the agent so it picks the key up. */
	async askGatewayKey(): Promise<boolean> {
		const gateway = this.gateway;
		if (!gateway) {
			return false;
		}
		const key = await vscode.window.showInputBox({
			title: vscode.l10n.t('{0} API Key', gateway.label),
			prompt: vscode.l10n.t('Paste your {0} API key. It is kept in the secure storage of Nova IDE. Create one at {1}', gateway.label, gateway.keyUrl),
			password: true,
			ignoreFocusOut: true
		});
		if (!key) {
			return false;
		}
		await this.secrets.store(this.secretKey(gateway.envName), key.trim());
		this.restart();
		return true;
	}

	private async readApiKeys(): Promise<Record<string, string>> {
		const env: Record<string, string> = {};
		const envNames = new Set(Object.values(API_KEY_ENV));
		if (this.gateway) {
			envNames.add(this.gateway.envName);
		}
		for (const envName of envNames) {
			const value = await this.secrets.get(this.secretKey(envName));
			if (value) {
				env[envName] = value;
			}
		}
		return env;
	}

	// --- agent → client requests ---------------------------------------------------------------

	/** The "allow once" (or else "allow always") option to answer with when the mode picked for the session already approves this kind of tool call. */
	private autoApprove(acpSessionId: string, kind: string | undefined, title: string | undefined, options: readonly AcpPermissionOption[]): AcpPermissionOption | undefined {
		// The tools of the Nova IDE MCP server (ide_ui_*, ide_terminal_*, browser_*...) ask the user themselves when it matters, so asking here too doubles every dialog.
		if (title && /nova-browser/.test(title)) {
			return options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind === 'allow_always');
		}
		let mode: string | undefined;
		for (const state of this.sessions.values()) {
			if (state.acpSessionId === acpSessionId) {
				mode = state.appliedOptions.get('mode') ?? state.appliedOptions.get(LEGACY_MODE_ID);
			}
		}
		const approvesAll = mode !== undefined && FULL_ACCESS_MODES.has(mode);
		const approvesEdits = mode !== undefined && EDIT_MODES.has(mode);
		// Agents without a permission mode (OpenCode) only ask about paths outside the project, which the user opens on purpose.
		const noModeAgent = mode === 'build';
		if (!approvesAll && !((approvesEdits || noModeAgent) && kind !== undefined && EDIT_KINDS.has(kind))) {
			return undefined;
		}
		return options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind === 'allow_always');
	}

	private createHandlers(): AcpRequestHandlers {
		return {
			requestPermission: async ({ sessionId, toolCall, options }) => {
				// NOVA: the agents only auto-approve inside the folder they were started in, so a mode such as
				// "Accept edits" still asked for every file elsewhere; honor the mode the user picked here instead.
				const auto = this.autoApprove(sessionId, toolCall.kind, toolCall.title, options);
				if (auto) {
					return { outcome: { outcome: 'selected', optionId: auto.optionId } };
				}
				const title = toolCall.title ?? toolCall.kind ?? '';
				const target = toolCall.locations?.[0]?.path;
				const detail = target ? vscode.workspace.asRelativePath(target) : undefined;
				const choice = await vscode.window.showWarningMessage(
					vscode.l10n.t('{0} wants to run: {1}', this.agent.label, title),
					{ modal: true, detail },
					...options.map(o => o.name)
				);
				const selected = options.find(o => o.name === choice);
				return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } };
			},
			readTextFile: async ({ path: file, line, limit }) => {
				const uri = vscode.Uri.file(file);
				// Prefer the editor buffer so the agent sees unsaved changes.
				const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
				let content = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
				if (line !== undefined || limit !== undefined) {
					const lines = content.split(/\r?\n/);
					const start = Math.max(0, (line ?? 1) - 1);
					content = lines.slice(start, limit !== undefined ? start + limit : undefined).join('\n');
				}
				return { content };
			},
			writeTextFile: async ({ path: file, content }) => {
				await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(content));
				return null;
			}
		};
	}
}

function isAuthError(error: unknown): boolean {
	if (!(error instanceof AcpError)) {
		return false;
	}
	return error.code === -32000 || /auth|api key|log ?in|sign ?in|credential|not configured/i.test(error.message);
}

async function toPromptBlocks(request: vscode.ChatRequest, imagePrompts: boolean): Promise<AcpContentBlock[]> {
	const blocks: AcpContentBlock[] = [{ type: 'text', text: request.command ? `/${request.command} ${request.prompt}` : request.prompt }];
	for (const reference of request.references) {
		const value = reference.value;
		if (value instanceof vscode.ChatReferenceBinaryData) {
			// NOVA: an image attached to the chat (dropped, pasted or picked) goes to the agent as an image block.
			if (imagePrompts && value.mimeType.startsWith('image/')) {
				blocks.push({ type: 'image', mimeType: value.mimeType, data: Buffer.from(await value.data()).toString('base64') });
			}
			continue;
		}
		const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
		if (uri?.scheme === 'file') {
			blocks.push({ type: 'resource_link', uri: uri.toString(), name: path.basename(uri.fsPath) });
		}
	}
	return blocks;
}

/** Used only when the full manual cannot be read. */
const FALLBACK_IDE_MANUAL = [
	'You are running inside Nova IDE (a VS Code based IDE); the user talks to you through its Chat panel.',
	'To show a file or an image to the user call the MCP tool ide_open_file (images open in the built-in image viewer).',
	'Never open files with start/open/xdg-open, an external browser, or a browser with a file:// URL.',
	'Use ide_show_diff to show changes and the browser_* tools for web pages in the Integrated Browser.',
	'Call the ide_manual tool for the full guide.',
].join('\n');

/** The conversation total for the context usage donut ("Processed in Conversation"); nothing until something was counted. */
function processedUsage(conversation: ConversationContext): { processedTokens?: number; processedTokensApproximate?: boolean } {
	return conversation.processedTotal > 0 ? { processedTokens: conversation.processedTotal, processedTokensApproximate: conversation.approximate } : {};
}

/** Tool id shown to the chat; it picks the item icon (the chat matches words such as "read" or "search" in it). */
function toolName(kind: string | undefined): string {
	return `nova.${kind ?? 'tool'}`;
}

/** One line of the activity panel for a tool call: running ("Reading x"), done ("Read x") or failed. */
function describeToolCall(kind: string | undefined, title: string, phase: 'running' | 'done' | 'failed'): string {
	const target = title ? inlineCode(title) : '';
	if (phase === 'failed') {
		return target ? vscode.l10n.t('Failed: {0}', target) : vscode.l10n.t('A tool call failed');
	}
	const running = phase === 'running';
	switch (kind) {
		case 'read': return running ? vscode.l10n.t('Reading {0}', target) : vscode.l10n.t('Read {0}', target);
		case 'edit': return running ? vscode.l10n.t('Editing {0}', target) : vscode.l10n.t('Edited {0}', target);
		case 'delete': return running ? vscode.l10n.t('Deleting {0}', target) : vscode.l10n.t('Deleted {0}', target);
		case 'move': return running ? vscode.l10n.t('Moving {0}', target) : vscode.l10n.t('Moved {0}', target);
		case 'search': return running ? vscode.l10n.t('Searching {0}', target) : vscode.l10n.t('Searched {0}', target);
		case 'execute': return running ? vscode.l10n.t('Running {0}', target) : vscode.l10n.t('Ran {0}', target);
		case 'fetch': return running ? vscode.l10n.t('Fetching {0}', target) : vscode.l10n.t('Fetched {0}', target);
		case 'think': return title || vscode.l10n.t('Thinking');
		default: return running ? vscode.l10n.t('Using {0}', target) : vscode.l10n.t('Used {0}', target);
	}
}

function localizedOptionName(id: string, fallback: string): string {
	switch (id) {
		case 'model': return vscode.l10n.t('Model');
		case 'mode': return vscode.l10n.t('Mode');
		case 'thought_level': return vscode.l10n.t('Effort');
		default: return fallback;
	}
}

function readToolProfile(): ToolProfile {
	const profile = vscode.workspace.getConfiguration('nova.agents').get<string>('toolProfile', 'full');
	return profile === 'code' || profile === 'browser' ? profile : 'full';
}

/**
 * Hands the Nova browser MCP server (from nova-browser-bridge's discovery file) to the agent,
 * so it can see and drive the integrated browser. The profile picks the endpoint: /mcp keeps
 * every tool, /mcp/code and /mcp/browser list fewer (each tool description costs context on
 * every model call).
 */
function readNovaBrowserMcpServers(toolProfile: ToolProfile): unknown[] {
	try {
		const bridge = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.nova-ide', 'bridge.json'), 'utf8')) as { url?: string; token?: string };
		if (!bridge.url || !bridge.token) {
			return [];
		}
		const mcpUrl = bridge.url.replace(/\/v1\/?$/, toolProfile === 'full' ? '/mcp' : `/mcp/${toolProfile}`);
		return [{ type: 'http', name: 'nova-browser', url: mcpUrl, headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }] }];
	} catch {
		return [];
	}
}

function randomId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
