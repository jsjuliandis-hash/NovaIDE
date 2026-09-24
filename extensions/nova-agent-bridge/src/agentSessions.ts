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
import { AcpAuthMethod, AcpConfigOption, AcpConnection, AcpContentBlock, AcpError, AcpNewSessionResult, AcpPromptResult, AcpRequestHandlers, AcpSessionUpdate } from './acp';

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
	/** Codicon id for the session items and participant. */
	readonly icon: string;
}

interface SessionState {
	acpSessionId: string | undefined;
	item: vscode.ChatSessionItem;
	/** Current value of each ACP config option (model, effort, mode...) as last sent to the agent. */
	appliedOptions: Map<string, string>;
}

/** ACP config options that become pickers in the chat input, in display order: each slot matches an ACP category or one of the known option ids. */
const PICKER_SLOTS: readonly { readonly category: string; readonly ids: readonly string[] }[] = [
	{ category: 'model', ids: ['model'] },
	{ category: 'mode', ids: ['mode'] },
	{ category: 'thought_level', ids: ['effort', 'reasoning_effort'] },
];

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

	constructor(private readonly agent: AgentDefinition, private readonly secrets: vscode.SecretStorage, private readonly log: vscode.LogOutputChannel) {
		this.controller = vscode.chat.createChatSessionItemController(agent.type, async () => {
			this.controller.items.replace([...this.sessions.values()].map(s => s.item));
		});
		this.disposables.push(this.controller);

		this.controller.newChatSessionItemHandler = async context => {
			const resource = vscode.Uri.from({ scheme: agent.type, path: `/${randomId()}` });
			const label = (context.request.prompt || agent.label).split('\n')[0].slice(0, 80);
			const item = this.controller.createChatSessionItem(resource, label);
			item.iconPath = new vscode.ThemeIcon(agent.icon);
			item.timing = { created: Date.now() };
			this.sessions.set(resource.toString(), { acpSessionId: undefined, item, appliedOptions: new Map() });
			this.controller.items.add(item);
			return item;
		};

		this.controller.getChatSessionInputState = async (_sessionResource, context) => {
			const state = this.controller.createChatSessionInputState(this.buildGroups(context.previousInputState));
			this.inputStates.add(state);
			state.onDidDispose(() => this.inputStates.delete(state));
			if (!this.configOptions) {
				// Start the agent and discover models in the background; pickers fill in when ready.
				void this.ensureConfigOptions().catch(error => this.log.warn(`could not load agent options: ${error}`));
			}
			return state;
		};

		const participant = vscode.chat.createChatParticipant(agent.type, (request, context, stream, token) => this.handleRequest(request, context, stream, token));
		participant.iconPath = new vscode.ThemeIcon(agent.icon);
		this.disposables.push(participant);
		this.disposables.push(vscode.chat.registerChatSessionContentProvider(agent.type, this, participant, { supportsInterruptions: true }));
	}

	dispose(): void {
		void this.connection?.then(c => c.dispose(), () => undefined);
		this.disposables.forEach(d => d.dispose());
	}

	provideChatSessionContent(resource: vscode.Uri, _token: vscode.CancellationToken, context: { readonly inputState: vscode.ChatSessionInputState }): vscode.ChatSession {
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
			const connection = this.readApiKeys().then(env => AcpConnection.start(command, args, cwd, env, this.createHandlers(), this.log)).then(({ connection, authMethods }) => {
				this.authMethods = authMethods;
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
		const state = resource ? this.sessions.get(resource.toString()) : undefined;
		if (!sessionContext || !state) {
			stream.markdown(vscode.l10n.t('Start a new {0} session from the session picker to talk to the agent.', this.agent.label));
			return {};
		}

		state.item.status = vscode.ChatSessionStatus.InProgress;
		state.item.timing = { created: state.item.timing?.created ?? Date.now(), lastRequestStarted: Date.now() };
		this.controller.items.add(state.item);

		let connection: AcpConnection;
		try {
			stream.progress(vscode.l10n.t('Connecting to {0}…', this.agent.label));
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
		const toolCalls = new Map<string, { title: string; kind?: string }>();
		const editedFiles = new Set<string>();
		let thinking = false;
		const lastMessage = { id: undefined as string | undefined };

		const listener = connection.onDidUpdate(({ sessionId, update }) => {
			if (sessionId !== acpSessionId) {
				return;
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
			const result = await this.withAuthentication(() => connection.request<AcpPromptResult>('session/prompt', { sessionId: acpSessionId, prompt: toPromptBlocks(request) }));
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
				await connection.request('session/set_config_option', { sessionId: state.acpSessionId, configId: group.id, value });
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
						stream.markdown('

');
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
					stream.progress(`${TOOL_ICONS[kind ?? ''] ?? '$(tools)'} ${title}`);
				} else if (update.status === 'completed' && (kind === 'edit' || kind === 'delete' || kind === 'move')) {
					for (const location of update.locations ?? []) {
						editedFiles.add(location.path);
					}
				} else if (update.status === 'failed') {
					stream.markdown('\n\n> ' + vscode.l10n.t('Tool failed: {0}', title) + '\n\n');
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

	private async readApiKeys(): Promise<Record<string, string>> {
		const env: Record<string, string> = {};
		for (const envName of new Set(Object.values(API_KEY_ENV))) {
			const value = await this.secrets.get(this.secretKey(envName));
			if (value) {
				env[envName] = value;
			}
		}
		return env;
	}

	// --- agent → client requests ---------------------------------------------------------------

	private createHandlers(): AcpRequestHandlers {
		return {
			requestPermission: async ({ toolCall, options }) => {
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
