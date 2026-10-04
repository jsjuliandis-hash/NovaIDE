/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Per-request metrics: what one chat message cost, as far as the ACP agent tells us.
 *  It records sizes and counts only (never prompt text, file contents or keys), counts each tool
 *  call once by its id, and keeps the agent's own usage numbers as reported, without adding
 *  subsets together or guessing how many model calls happened. No vscode import, so the unit
 *  tests can run it under plain Node.
 *-------------------------------------------------------------------------------------------*/

import type { AcpSessionUpdate, AcpUsage } from './acp';
import type { ProcessedSource } from './contextAccounting';

export const METRICS_SCHEMA_VERSION = 2;

/** What a request was: a message from the user, the Nova compact summary, or the agent's own `/compact`. */
export type RequestKind = 'message' | 'nova-compact' | 'native-compact';

/** One finished request (one message the user sent), ready for the log or a JSON export. */
export interface RequestMetricsReport {
	readonly schema: number;
	readonly requestId: string;
	readonly kind: RequestKind;
	readonly provider: string;
	/** Local ACP session id, to tell chat tabs apart. */
	readonly session: string;
	readonly startedAt: string;
	readonly durationMs: number;
	/** `session/prompt` requests sent; a second one only after signing in again. */
	readonly promptAttempts: number;
	readonly authRetries: number;
	/** Characters typed by the user, and of the Nova IDE manual sent with this prompt (0 after the first prompt). */
	readonly messageChars: number;
	readonly manualChars: number;
	/** Characters of the Nova compact summary sent with this prompt (first prompt of the new agent session). */
	readonly summaryChars?: number;
	/** Files and images attached to the message. */
	readonly attachments: number;
	/** Distinct tool calls (by id); repeated updates of one call count once. */
	readonly toolCalls: number;
	readonly toolCallsFailed: number;
	readonly toolKinds: Readonly<Record<string, number>>;
	/** `usage_update` notifications received. Some agents send one per model response, others fewer: not a model call count. */
	readonly usageUpdates: number;
	/** Context window state from the first and last `usage_update` (tokens in the window, not tokens processed). */
	readonly contextStart?: number;
	readonly contextEnd?: number;
	readonly contextSize?: number;
	readonly cost?: { readonly amount: number; readonly currency: string };
	/** Token usage exactly as the agent reported it in the `session/prompt` result, with where it came from. */
	readonly usage?: AcpUsage;
	readonly usageSource?: 'acp.prompt.usage';
	/** Models that answered, from the agent's `_meta.quota.model_usage`. */
	readonly models?: readonly string[];
	/** The model picker changed since the previous request of this tab ("a → b"). */
	readonly modelChange?: string;
	/** Tokens this request processed, counted the way the agent's numbers allow (see contextAccounting.ts). */
	readonly processedTokens?: number;
	readonly processedSource?: ProcessedSource;
	/** Running total of the chat tab after this request; never reset by a compact. */
	readonly processedTotal?: number;
	/** Model calls are never inferred from tools or usage updates; no ACP agent reports them today. */
	readonly modelCalls: 'unavailable';
	readonly stopReason?: string;
	readonly failed: boolean;
}

interface PromptShape {
	readonly messageChars: number;
	readonly manualChars: number;
	readonly summaryChars?: number;
	readonly attachments: number;
}

/** Collects the metrics of one request while it runs. */
export class RequestMetrics {

	private readonly startedAt: number;
	private promptAttempts = 0;
	private authRetries = 0;
	private prompt: PromptShape = { messageChars: 0, manualChars: 0, attachments: 0 };
	private readonly tools = new Map<string, { kind: string; failed: boolean }>();
	private usageUpdates = 0;
	private contextStart: number | undefined;
	private contextEnd: number | undefined;
	private contextSize: number | undefined;
	private cost: { amount: number; currency: string } | undefined;
	private readonly contextValues: number[] = [];

	constructor(private readonly requestId: string, private readonly provider: string, private readonly session: string, private readonly now: () => number = Date.now, private readonly kind: RequestKind = 'message') {
		this.startedAt = now();
	}

	recordPrompt(shape: PromptShape): void {
		this.prompt = shape;
	}

	/** Call before each `session/prompt` attempt; `retry` marks the one sent again after signing in. */
	recordAttempt(retry: boolean): void {
		this.promptAttempts++;
		if (retry) {
			this.authRetries++;
		}
	}

	/** Feed every `session/update` of this request's session. */
	observe(update: AcpSessionUpdate): void {
		switch (update.sessionUpdate) {
			case 'tool_call':
			case 'tool_call_update': {
				const id = update.toolCallId;
				if (!id) {
					return;
				}
				const known = this.tools.get(id);
				const tool = known ?? { kind: update.kind ?? 'other', failed: false };
				if (update.kind && tool.kind === 'other') {
					tool.kind = update.kind;
				}
				if (update.status === 'failed') {
					tool.failed = true;
				}
				this.tools.set(id, tool);
				break;
			}
			case 'usage_update':
				this.usageUpdates++;
				if (update.used !== undefined) {
					this.contextStart ??= update.used;
					this.contextEnd = update.used;
					this.contextValues.push(update.used);
				}
				this.contextSize = update.size ?? this.contextSize;
				this.cost = update.cost ? { ...update.cost } : this.cost;
				break;
		}
	}

	/** Every `usage_update.used` of the request, in order (repeats included). */
	get contextUpdates(): readonly number[] {
		return this.contextValues;
	}

	get lastContext(): number | undefined {
		return this.contextEnd;
	}

	get lastContextSize(): number | undefined {
		return this.contextSize;
	}

	finish(outcome: { stopReason?: string; usage?: AcpUsage; failed?: boolean; models?: readonly string[]; modelChange?: string; processedTokens?: number; processedSource?: ProcessedSource; processedTotal?: number }): RequestMetricsReport {
		const toolKinds: Record<string, number> = {};
		let toolCallsFailed = 0;
		for (const tool of this.tools.values()) {
			toolKinds[tool.kind] = (toolKinds[tool.kind] ?? 0) + 1;
			if (tool.failed) {
				toolCallsFailed++;
			}
		}
		return {
			schema: METRICS_SCHEMA_VERSION,
			requestId: this.requestId,
			kind: this.kind,
			provider: this.provider,
			session: this.session,
			startedAt: new Date(this.startedAt).toISOString(),
			durationMs: this.now() - this.startedAt,
			promptAttempts: this.promptAttempts,
			authRetries: this.authRetries,
			...this.prompt,
			toolCalls: this.tools.size,
			toolCallsFailed,
			toolKinds,
			usageUpdates: this.usageUpdates,
			contextStart: this.contextStart,
			contextEnd: this.contextEnd,
			contextSize: this.contextSize,
			cost: this.cost,
			usage: outcome.usage ? { ...outcome.usage } : undefined,
			usageSource: outcome.usage ? 'acp.prompt.usage' : undefined,
			// Optional fields only when known, so the export stays short.
			...(outcome.models?.length ? { models: [...outcome.models] } : {}),
			...(outcome.modelChange ? { modelChange: outcome.modelChange } : {}),
			...(outcome.processedSource ? { processedTokens: outcome.processedTokens, processedSource: outcome.processedSource, processedTotal: outcome.processedTotal } : {}),
			modelCalls: 'unavailable',
			stopReason: outcome.stopReason,
			failed: !!outcome.failed,
		};
	}
}

/** The latest reports of every provider, kept in memory for the optional JSON export. */
export class RecentMetrics {

	private readonly reports: RequestMetricsReport[] = [];

	constructor(private readonly limit = 200) { }

	add(report: RequestMetricsReport): void {
		this.reports.push(report);
		if (this.reports.length > this.limit) {
			this.reports.splice(0, this.reports.length - this.limit);
		}
	}

	get size(): number {
		return this.reports.length;
	}

	/** The export file: schema version, when it was made, and the reports (oldest first). */
	toExport(now: Date = new Date()): { schema: number; exportedAt: string; note: string; reports: readonly RequestMetricsReport[] } {
		return {
			schema: METRICS_SCHEMA_VERSION,
			exportedAt: now.toISOString(),
			note: 'usage holds the token counts exactly as each agent reported them (Claude Code sums the model calls of a request, Codex reports the last call). processedTokens follows that: agent-sum is the agent\'s own sum, usage-updates adds up the context of each model call (an estimate). usageUpdates is not a model call count.',
			reports: [...this.reports],
		};
	}
}

/** One line for the "Nova Agents" log. Missing numbers read "n/a", never 0. */
export function formatMetrics(report: RequestMetricsReport): string {
	const na = (value: number | undefined) => value === undefined ? 'n/a' : String(value);
	const kinds = Object.entries(report.toolKinds).map(([kind, count]) => `${kind} ${count}`).join(', ');
	const usage = report.usage
		? `input ${na(report.usage.inputTokens)}, cache read ${na(report.usage.cachedReadTokens)}, cache write ${na(report.usage.cachedWriteTokens)}, output ${na(report.usage.outputTokens)}, thought ${na(report.usage.thoughtTokens)}, total ${na(report.usage.totalTokens)}`
		: 'n/a';
	const processed = report.processedSource === undefined ? undefined
		: `processed ${report.processedSource === 'usage-updates' ? '≈' : ''}${na(report.processedTokens)} (${report.processedSource}), conversation ${na(report.processedTotal)}`;
	return [
		`metrics ${report.requestId}${report.kind === 'message' ? '' : ` (${report.kind})`}: ${report.durationMs} ms`,
		`attempts ${report.promptAttempts}${report.authRetries ? ` (${report.authRetries} after sign-in)` : ''}`,
		`message ${report.messageChars} chars, manual ${report.manualChars} chars${report.summaryChars ? `, summary ${report.summaryChars} chars` : ''}, attachments ${report.attachments}`,
		`tools ${report.toolCalls}${report.toolCallsFailed ? ` (${report.toolCallsFailed} failed)` : ''}${kinds ? ` [${kinds}]` : ''}`,
		`usage updates ${report.usageUpdates}`,
		`context ${na(report.contextStart)} → ${na(report.contextEnd)} of ${na(report.contextSize)}`,
		`tokens as reported by the agent: ${usage}`,
		...(processed ? [processed] : []),
		...(report.models?.length ? [`models ${report.models.join(', ')}`] : []),
		...(report.modelChange ? [`model ${report.modelChange}`] : []),
		'model calls n/a',
		`stop ${report.stopReason ?? (report.failed ? 'error' : 'n/a')}`,
	].join(' | ');
}
