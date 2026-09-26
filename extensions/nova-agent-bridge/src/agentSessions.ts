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
}

interface SessionState {
	acpSessionId: string | undefined;
	item: vscode.ChatSessionItem;
	/** Current value of each ACP config option (model, effort, mode...) as last sent to the agent. */
	appliedOptions: Map<string, string>;
	/** True once the Nova IDE manual has been handed to the agent in this session. */
	manualSent?: boolean;
}

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

const TOOL_ICONS: Record<string, string> = {
	read: '$(file)',
	edit: '$(edit)',
	delete: '$(trash)',
	move: '$(arrow-right)',
	search: '$(search)',
	execute: '$(terminal)',
	think: '$(lightbulb)',
	fetch: '$(globe)',
};

/** Tool kinds whose title is a file path, safe to show in the chat; every other kind may carry raw command output. */
const FILE_TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search']);

export class AgentSessionProvider implements vscode.ChatSessionContentProvider, vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly controller: vscode.ChatSessionItemController;
	private readonly sessions = new Map<string, SessionState>();
	private connection: Promise<AcpConnection> | undefined;
	/** Config options reported by the agent for new sessions (from the first session/new). */
	private configOptions: readonly AcpConfigOption[] | undefined;
	/** A session created ahead of time to discover the config options, reused by the next new chat. */
	private spareSession: Promise<AcpNewSessionResult> | undefined;
	private readonly inputStates = new Set<vscode.ChatSessionInputState>();
	private authMethods: readonly AcpAuthMethod[] = [];
	/** Slash commands the agent reported (`available_commands_update`); they feed the `/` completion list of the chat. */
	private commands: readonly AcpAvailableCommand[] = [];
	private readonly commandsChanged = new vscode.EventEmitter<void>();

	constructor(private readonly agent: AgentDefinition, private readonly secrets: vscode.SecretStorage, private readonly log: vscode.LogOutputChannel) {
		this.controller = vscode.chat.createChatSessionItemController(agent.type, async () => {
			this.controller.items.replace([...this.sessions.values()].map(s => s.item));
		});
		this.disposables.push(this.controller);

		this.controller.newChatSessionItemHandler = async context => {
			const resource = vscode.Uri.from({ scheme: agent.type, path: `/${randomId()}` });
			return this.createSession(resource, context.request.prompt).item;
		};

		this.controller.getChatSessionInputState = async (_sessionResource, context) => {
			const state = this.controller.createChatSessionInputState(this.buildGroups(context.previousInputState));
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
		return this.commands.map(command => ({
			// `agent-builtin` marks a command without a file: the chat sends the typed `/name` to the agent as plain text.
			uri: vscode.Uri.from({ scheme: 'agent-builtin', path: `/${command.name}` }),
			type: vscode.ChatSessionCustomizationType.Prompt,
			name: command.name,
			description: [command.description, command.input?.hint].filter(Boolean).join(' — ') || undefined,
			source: 'builtin',
			userInvocable: true
		}));
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
		const state: SessionState = { acpSessionId: undefined, item, appliedOptions: new Map() };
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
		const options: Record<string, vscode.ChatSessionProviderOptionItem> = {};
		for (const group of context?.inputState.groups ?? []) {
			if (group.selected) {
				options[group.id] = group.selected;
			}
		}
		const state = this.sessions.get(resource.toString());
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
			const connection = this.readAgentEnv().then(env => AcpConnection.start(command, args, cwd, env, this.createHandlers(), this.log)).then(({ connection, authMethods }) => {
				this.authMethods = authMethods;
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

	private newAcpSession(): Promise<AcpNewSessionResult> {
		return this.withAuthentication(() => this.doNewAcpSession());
	}

	private async doNewAcpSession(): Promise<AcpNewSessionResult> {
		const connection = await this.getConnection();
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const result = await connection.request<AcpNewSessionResult>('session/new', {
			// opencode rejects backslash paths on Windows
			cwd: folder.replace(/\\/g, '/'),
			mcpServers: readNovaBrowserMcpServers()
		});
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
			this.spareSession = this.doNewAcpSession();
			this.spareSession.catch(() => this.spareSession = undefined);
		}
		await this.spareSession;
	}

	private takeSpareSession(): Promise<AcpNewSessionResult> {
		const spare = this.spareSession;
		this.spareSession = undefined;
		return spare ?? this.newAcpSession();
	}

	private setConfigOptions(options: readonly AcpConfigOption[]): void {
		this.configOptions = options;
		for (const state of this.inputStates) {
			if (!state.sessionResource || !this.sessions.get(state.sessionResource.toString())?.acpSessionId) {
				state.groups = this.buildGroups(state);
			}
		}
	}

	private buildGroups(previous: vscode.ChatSessionInputState | undefined): vscode.ChatSessionProviderOptionGroup[] {
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
			const previousSelection = previous?.groups.find(g => g.id === option.id)?.selected;
			const selected = items.find(i => i.id === previousSelection?.id) ?? items.find(i => i.default) ?? items[0];
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

		state.item.status = vscode.ChatSessionStatus.InProgress;
		state.item.timing = { created: state.item.timing?.created ?? Date.now(), lastRequestStarted: Date.now() };
		this.controller.items.add(state.item);

		const startedAt = Date.now();
		let connection: AcpConnection;
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
			await this.applyOptions(connection, state, sessionContext.inputState);
		} catch (error) {
			this.finish(state, vscode.ChatSessionStatus.Failed);
			return this.reportError(error, stream);
		}

		const acpSessionId = state.acpSessionId!;
		this.log.info(`[${this.agent.label}] request: connection and session ready after ${Date.now() - startedAt} ms (session ${acpSessionId}, first prompt: ${!state.manualSent})`);
		let firstUpdateAt: number | undefined;
		const toolCalls = new Map<string, { title: string; kind?: string }>();
		const editedFiles = new Set<string>();
		let thinking = false;
		const lastMessage = { id: undefined as string | undefined };

		const listener = connection.onDidUpdate(({ sessionId, update }) => {
			if (sessionId !== acpSessionId) {
				return;
			}
			firstUpdateAt ??= Date.now();
			if (update.sessionUpdate === 'usage_update') {
				this.log.info(`[${this.agent.label}] usage: context ${update.used ?? '?'} of ${update.size ?? '?'} tokens${update.cost ? `, cost ${update.cost.amount} ${update.cost.currency}` : ''}`);
				if (update.used !== undefined && update.size) {
					// NOVA: feeds the context usage donut of the chat input (used tokens out of the model's context window).
					stream.usage({ promptTokens: update.used, completionTokens: 0, contextWindow: update.size });
				}
			}
			this.renderUpdate(update, stream, toolCalls, editedFiles, lastMessage, () => {
				if (!thinking) {
					thinking = true;
					stream.progress(vscode.l10n.t('Thinking…'));
				}
			});
		});
		const cancel = token.onCancellationRequested(() => connection.notify('session/cancel', { sessionId: acpSessionId }));

		try {
			const prompt = toPromptBlocks(request);
			// The agent is an external process that knows nothing about Nova IDE: hand it the manual once per session.
			const manual = state.manualSent ? undefined : this.readIdeManual();
			if (manual) {
				prompt.unshift({ type: 'text', text: `<nova-ide-manual>\n${manual}\n</nova-ide-manual>` });
			}
			state.manualSent = true;
			const result = await this.withAuthentication(() => connection.request<AcpPromptResult>('session/prompt', { sessionId: acpSessionId, prompt }));
			this.log.info(`[${this.agent.label}] response: first update after ${firstUpdateAt ? firstUpdateAt - startedAt : '?'} ms, finished after ${Date.now() - startedAt} ms, stopReason ${result.stopReason}, prompt ${JSON.stringify(prompt).length} characters, result ${JSON.stringify(result)}`);
			for (const file of editedFiles) {
				stream.reference(vscode.Uri.file(file));
			}
			if (result.stopReason === 'refusal') {
				stream.markdown('\n\n' + vscode.l10n.t('_The agent refused to continue._'));
			} else if (result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests') {
				stream.markdown('\n\n' + vscode.l10n.t('_The agent stopped: limit reached ({0})._', result.stopReason));
			}
			this.finish(state, vscode.ChatSessionStatus.Completed);
			return {};
		} catch (error) {
			this.finish(state, vscode.ChatSessionStatus.Failed);
			return this.reportError(error, stream);
		} finally {
			listener.dispose();
			cancel.dispose();
		}
	}

	/** The Nova IDE manual (SKILL.md) shipped with nova-browser-bridge, or a short built-in summary if it cannot be read. */
	private readIdeManual(): string | undefined {
		if (!vscode.workspace.getConfiguration('nova.agents').get<boolean>('injectIdeManual', true)) {
			return undefined;
		}
		try {
			const extensionPath = vscode.extensions.getExtension('nova-ide.nova-browser-bridge')?.extensionPath;
			if (extensionPath) {
				const manual = fs.readFileSync(path.join(extensionPath, 'media', 'nova-ide', 'SKILL.md'), 'utf8');
				this.log.info(`[${this.agent.label}] sending the Nova IDE manual (${manual.length} characters) with the first prompt`);
				return manual;
			}
		} catch (error) {
			this.log.warn(`[${this.agent.label}] could not read the Nova IDE manual: ${error instanceof Error ? error.message : String(error)}`);
		}
		return FALLBACK_IDE_MANUAL;
	}

	private async applyOptions(connection: AcpConnection, state: SessionState, inputState: vscode.ChatSessionInputState): Promise<void> {
		for (const group of inputState.groups) {
			const value = group.selected?.id;
			if (!value || state.appliedOptions.get(group.id) === value) {
				continue;
			}
			const current = this.configOptions?.find(o => o.id === group.id)?.currentValue;
			if (state.appliedOptions.size === 0 && current === value) {
				state.appliedOptions.set(group.id, value);
				continue;
			}
			if (group.id === LEGACY_MODEL_ID) {
				await connection.request('session/set_model', { sessionId: state.acpSessionId, modelId: value });
			} else if (group.id === LEGACY_MODE_ID) {
				await connection.request('session/set_mode', { sessionId: state.acpSessionId, modeId: value });
			} else {
				try {
					await connection.request('session/set_config_option', { sessionId: state.acpSessionId, configId: group.id, value });
				} catch (error) {
					// NOVA: switching the model can drop an option (Claude Haiku has no "effort"), but the picker
					// still holds the old choice. The agent then answers "Unknown config option", which is not a failure.
					const message = error instanceof Error ? error.message : String(error);
					const details = (error as { data?: { details?: string } } | undefined)?.data?.details ?? '';
					if (!/unknown config option/i.test(`${message} ${details}`)) {
						throw error;
					}
					this.log.info(`[${this.agent.label}] the agent has no "${group.id}" option for this model; skipping it`);
				}
			}
			state.appliedOptions.set(group.id, value);
		}
	}

	private renderUpdate(update: AcpSessionUpdate, stream: vscode.ChatResponseStream, toolCalls: Map<string, { title: string; kind?: string }>, editedFiles: Set<string>, lastMessage: { id: string | undefined }, onThinking: () => void): void {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				if (update.content?.type === 'text' && update.content.text) {
					// A new agent message (e.g. after a tool call) starts a new paragraph.
					if (update.messageId && lastMessage.id && update.messageId !== lastMessage.id) {
						stream.markdown('\n\n');
					}
					lastMessage.id = update.messageId ?? lastMessage.id;
					stream.markdown(update.content.text);
				}
				break;
			case 'agent_thought_chunk':
				onThinking();
				break;
			case 'tool_call':
			case 'tool_call_update': {
				const id = update.toolCallId ?? '';
				const known = toolCalls.get(id);
				const kind = update.kind ?? known?.kind;
				const target = update.locations?.[0]?.path;
				const title = target ? `${update.title && update.title !== kind ? update.title : kind ?? ''} ${vscode.workspace.asRelativePath(target)}`.trim() : (update.title ?? known?.title ?? '');
				toolCalls.set(id, { title, kind });
				if (update.status === 'in_progress' && target) {
					// NOVA: only file tools show their path; the title of any other tool (shell command, fetch) is a raw command or log, so show "Thinking…".
						stream.progress(FILE_TOOL_KINDS.has(kind ?? '') ? `${TOOL_ICONS[kind ?? '']} ${title}` : vscode.l10n.t('Thinking…'));
				} else if (update.status === 'completed' && (kind === 'edit' || kind === 'delete' || kind === 'move')) {
					for (const location of update.locations ?? []) {
						editedFiles.add(location.path);
					}
				} else if (update.status === 'failed' && typeof update.rawOutput === 'string' && update.rawOutput.includes('<tool_use_error>')) {
					// NOVA: the agent rejected the call itself (e.g. "File has not been read yet") and the model fixes it and retries, so it is not a failure to show the user.
					this.log.info(`[${this.agent.label}] tool call rejected by the agent, not shown: ${update.rawOutput.replace(/\s+/g, ' ').slice(0, 200)}`);
				} else if (update.status === 'failed') {
					// NOVA: a failed shell command would dump the whole command line into the chat.
						stream.markdown('\n\n> ' + (FILE_TOOL_KINDS.has(kind ?? '') ? vscode.l10n.t('Tool failed: {0}', title) : vscode.l10n.t('A tool call failed.')) + '\n\n');
				}
				break;
			}
			case 'plan':
				if (update.entries?.length) {
					const pending = update.entries.filter(e => e.status !== 'completed').length;
					stream.progress(vscode.l10n.t('Plan: {0} of {1} steps left', pending, update.entries.length));
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
		const message = error instanceof Error ? error.message : String(error);
		this.log.error(message);
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

function toPromptBlocks(request: vscode.ChatRequest): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [{ type: 'text', text: request.command ? `/${request.command} ${request.prompt}` : request.prompt }];
	for (const reference of request.references) {
		const value = reference.value;
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

function localizedOptionName(id: string, fallback: string): string {
	switch (id) {
		case 'model': return vscode.l10n.t('Model');
		case 'mode': return vscode.l10n.t('Mode');
		case 'thought_level': return vscode.l10n.t('Effort');
		default: return fallback;
	}
}

/**
 * Hands the Nova browser MCP server (from nova-browser-bridge's discovery file) to the agent,
 * so it can see and drive the integrated browser.
 */
function readNovaBrowserMcpServers(): unknown[] {
	try {
		const bridge = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.nova-ide', 'bridge.json'), 'utf8')) as { url?: string; token?: string };
		if (!bridge.url || !bridge.token) {
			return [];
		}
		const mcpUrl = bridge.url.replace(/\/v1\/?$/, '/mcp');
		return [{ type: 'http', name: 'nova-browser', url: mcpUrl, headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }] }];
	} catch {
		return [];
	}
}

function randomId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
