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
import { AcpConfigOption, AcpConnection, AcpContentBlock, AcpError, AcpNewSessionResult, AcpPromptResult, AcpRequestHandlers, AcpSessionUpdate } from './acp';

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
}

interface SessionState {
	acpSessionId: string | undefined;
	item: vscode.ChatSessionItem;
	/** Current value of each ACP config option (model, effort, mode...) as last sent to the agent. */
	appliedOptions: Map<string, string>;
}

/** ACP config option ids that become pickers in the chat input, in display order (max 2 groups are rendered by the editor; mode is appended when there is room). */
const PICKER_OPTION_IDS = ['model', 'mode', 'effort'];

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

	constructor(private readonly agent: AgentDefinition, private readonly log: vscode.LogOutputChannel) {
		this.controller = vscode.chat.createChatSessionItemController(agent.type, async () => {
			this.controller.items.replace([...this.sessions.values()].map(s => s.item));
		});
		this.disposables.push(this.controller);

		this.controller.newChatSessionItemHandler = async context => {
			const resource = vscode.Uri.from({ scheme: agent.type, path: `/${randomId()}` });
			const label = (context.request.prompt || agent.label).split('\n')[0].slice(0, 80);
			const item = this.controller.createChatSessionItem(resource, label);
			item.iconPath = new vscode.ThemeIcon('sparkle');
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
		participant.iconPath = new vscode.ThemeIcon('sparkle');
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
			this.log.info(`starting ${command} ${args.join(' ')}`);
			const connection = AcpConnection.start(command, args, cwd, this.createHandlers(), this.log).then(({ connection }) => {
				connection.onDidExit(() => {
					// Sessions live inside the process; forget them so the next request starts over.
					this.connection = undefined;
					this.spareSession = undefined;
					for (const state of this.sessions.values()) {
						state.acpSessionId = undefined;
						state.appliedOptions.clear();
					}
				});
				return connection;
			});
			this.connection = connection;
			connection.catch(() => this.connection = undefined);
		}
		return this.connection;
	}

	private async newAcpSession(): Promise<AcpNewSessionResult> {
		const connection = await this.getConnection();
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const result = await connection.request<AcpNewSessionResult>('session/new', {
			// opencode rejects backslash paths on Windows
			cwd: folder.replace(/\\/g, '/'),
			mcpServers: readNovaBrowserMcpServers()
		});
		if (result.configOptions) {
			this.setConfigOptions(result.configOptions);
		}
		return result;
	}

	private async ensureConfigOptions(): Promise<void> {
		if (!this.spareSession) {
			this.spareSession = this.newAcpSession();
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
		for (const id of PICKER_OPTION_IDS) {
			const option = this.configOptions?.find(o => o.id === id && o.type === 'select' && o.options?.length);
			if (!option) {
				continue;
			}
			const items: vscode.ChatSessionProviderOptionItem[] = option.options!.map(o => ({
				id: o.value,
				name: o.name,
				description: o.description,
				default: o.value === option.currentValue
			}));
			const previousSelection = previous?.groups.find(g => g.id === id)?.selected;
			const selected = items.find(i => i.id === previousSelection?.id) ?? items.find(i => i.default) ?? items[0];
			groups.push({ id, name: localizedOptionName(id, option.name), items, selected });
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

		const listener = connection.onDidUpdate(({ sessionId, update }) => {
			if (sessionId !== acpSessionId) {
				return;
			}
			this.renderUpdate(update, stream, toolCalls, editedFiles, () => {
				if (!thinking) {
					thinking = true;
					stream.progress(vscode.l10n.t('Thinking…'));
				}
			});
		});
		const cancel = token.onCancellationRequested(() => connection.notify('session/cancel', { sessionId: acpSessionId }));

		try {
			const result = await connection.request<AcpPromptResult>('session/prompt', { sessionId: acpSessionId, prompt: toPromptBlocks(request) });
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
			await connection.request('session/set_config_option', { sessionId: state.acpSessionId, configId: group.id, value });
			state.appliedOptions.set(group.id, value);
		}
	}

	private renderUpdate(update: AcpSessionUpdate, stream: vscode.ChatResponseStream, toolCalls: Map<string, { title: string; kind?: string }>, editedFiles: Set<string>, onThinking: () => void): void {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				if (update.content?.type === 'text' && update.content.text) {
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
		const isAuth = error instanceof AcpError && (error.code === -32000 || /auth/i.test(message));
		if (isAuth) {
			stream.markdown(vscode.l10n.t('{0} is not signed in. Run `{1}` in a terminal and try again.', this.agent.label, this.agent.loginHint));
		} else if (/ENOENT|not recognized|não é reconhecido/i.test(message)) {
			stream.markdown(vscode.l10n.t('Could not start `{0}`. Install it or set `{1}.command` in the settings.', this.agent.defaultCommand, this.agent.settingsSection));
		}
		return { errorDetails: { message } };
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
		case 'effort': return vscode.l10n.t('Effort');
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
