/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Context accounting per chat tab: how big the context re-read on every model call is, how many
 *  tokens the conversation has processed so far, when to warn about it and when to compact it.
 *  Each agent reports usage with a different meaning (Claude Code sums the model calls of a
 *  request, Codex reports only the last one), so the total is built per agent and says where it
 *  came from. No vscode import, so the unit tests can run it under plain Node.
 *-------------------------------------------------------------------------------------------*/

import type { AcpPromptMeta, AcpUsage } from './acp';

/** How an agent fills the `usage` of a `session/prompt` result. */
export type UsageSemantics = 'request-sum' | 'last-call';

/** Where a processed-token count came from: the agent's own sum, an estimate from `usage_update`s, or nothing. */
export type ProcessedSource = 'agent-sum' | 'usage-updates' | 'unavailable';

export interface ProcessedTokens {
	readonly tokens: number | undefined;
	readonly source: ProcessedSource;
}

/** Sum of the per-model totals in `_meta.quota.model_usage`; the only place Claude Code reports what a `/compact` cost. */
export function modelUsageTotal(meta: AcpPromptMeta | undefined): number | undefined {
	const entries = Array.isArray(meta?.quota?.model_usage) ? meta!.quota!.model_usage! : [];
	let total = 0;
	for (const entry of entries) {
		const value = entry?.token_count?.totalTokens;
		if (typeof value === 'number' && value > 0) {
			total += value;
		}
	}
	return total > 0 ? total : undefined;
}

/** Models that answered the request, from `_meta.quota.model_usage`. */
export function modelsUsed(meta: AcpPromptMeta | undefined): string[] {
	const entries = Array.isArray(meta?.quota?.model_usage) ? meta!.quota!.model_usage! : [];
	return [...new Set(entries.map(entry => entry?.model).filter((model): model is string => typeof model === 'string' && !!model))];
}

/** `usage_update` context values with consecutive repeats removed (Claude Code sends the same value several times). */
export function distinctContextValues(values: readonly number[]): number[] {
	const result: number[] = [];
	for (const value of values) {
		if (result[result.length - 1] !== value) {
			result.push(value);
		}
	}
	return result;
}

/**
 * Tokens one request processed, following what the agent's numbers mean:
 * - `request-sum` (Claude Code): `usage.totalTokens` already adds up the request's model calls; a `/compact`
 *   reports zero there and its real cost only in `_meta`.
 * - `last-call` (Codex): `usage` is the last call, so the context of every call (`usage_update.used`) is added
 *   up instead, as an estimate. A native `/compact` reports nothing usable.
 * - unknown agents: their `usage` when filled, else the `usage_update`s, else nothing.
 */
export function requestProcessedTokens(input: {
	readonly semantics: UsageSemantics | undefined;
	readonly usage: AcpUsage | undefined;
	readonly meta: AcpPromptMeta | undefined;
	readonly contextUpdates: readonly number[];
	readonly nativeCompact?: boolean;
}): ProcessedTokens {
	const usageTotal = input.usage?.totalTokens && input.usage.totalTokens > 0 ? input.usage.totalTokens : undefined;
	const updatesTotal = distinctContextValues(input.contextUpdates).reduce((sum, value) => sum + value, 0) || undefined;
	switch (input.semantics) {
		case 'request-sum': {
			const tokens = usageTotal ?? modelUsageTotal(input.meta);
			return tokens ? { tokens, source: 'agent-sum' } : { tokens: undefined, source: 'unavailable' };
		}
		case 'last-call':
			if (input.nativeCompact) {
				return { tokens: undefined, source: 'unavailable' };
			}
			return updatesTotal ? { tokens: updatesTotal, source: 'usage-updates' } : usageTotal ? { tokens: usageTotal, source: 'usage-updates' } : { tokens: undefined, source: 'unavailable' };
		default:
			if (usageTotal) {
				return { tokens: usageTotal, source: 'agent-sum' };
			}
			return updatesTotal ? { tokens: updatesTotal, source: 'usage-updates' } : { tokens: undefined, source: 'unavailable' };
	}
}

/** What one finished request adds to its conversation. */
export interface ConversationRequest {
	/** Context of the last model call (last `usage_update.used`), re-read by the next call. */
	readonly context: number | undefined;
	readonly contextSize: number | undefined;
	readonly processed: ProcessedTokens;
	/** True for a request the user sent (not a Nova summary or compact). */
	readonly userMessage: boolean;
}

export interface ContextWarning {
	readonly context: number;
	readonly processedTotal: number;
	/** True when part of the total is estimated or missing: shown with "≈". */
	readonly approximate: boolean;
}

/** The running numbers of one chat tab. The total never resets, the context does on a compact or a new agent session. */
export class ConversationContext {

	lastContext: number | undefined;
	contextSize: number | undefined;
	processedTotal = 0;
	/** Some request was counted from `usage_update`s (an estimate). */
	estimated = false;
	/** Some request reported nothing. */
	incomplete = false;
	messages = 0;
	compactions = 0;
	messagesSinceCompact = 0;
	/** Context of the first request after the last compact: how small the conversation got. */
	contextAfterCompact: number | undefined;
	private awaitingContextAfterCompact = false;
	/** Context at the last warning; 0 when the next crossing of the threshold should warn. */
	private warnedAt = 0;

	record(request: ConversationRequest): void {
		if (request.context !== undefined) {
			this.lastContext = request.context;
			if (this.awaitingContextAfterCompact) {
				this.contextAfterCompact = request.context;
				this.awaitingContextAfterCompact = false;
			}
		}
		this.contextSize = request.contextSize ?? this.contextSize;
		if (request.processed.tokens !== undefined) {
			this.processedTotal += request.processed.tokens;
		}
		if (request.processed.source === 'usage-updates') {
			this.estimated = true;
		} else if (request.processed.source === 'unavailable') {
			this.incomplete = true;
		}
		if (request.userMessage) {
			this.messages++;
			this.messagesSinceCompact++;
		}
	}

	/** The conversation was compacted or moved to a new agent session: its context starts over, the total does not. */
	recordCompact(): void {
		this.compactions++;
		this.messagesSinceCompact = 0;
		this.lastContext = undefined;
		this.contextAfterCompact = undefined;
		this.awaitingContextAfterCompact = true;
		this.warnedAt = 0;
	}

	/** The agent session was lost (agent restarted): the context starts over without counting a compact. */
	resetContext(): void {
		this.lastContext = undefined;
		this.warnedAt = 0;
	}

	get approximate(): boolean {
		return this.estimated || this.incomplete;
	}

	/**
	 * A warning to show after the latest request: once when the context crosses the threshold and again each
	 * time it grows another 50%, so it does not repeat on every message. A threshold of 0 turns it off.
	 */
	takeWarning(threshold: number): ContextWarning | undefined {
		const context = this.lastContext;
		if (!threshold || threshold <= 0 || context === undefined) {
			return undefined;
		}
		if (context < threshold) {
			this.warnedAt = 0;
			return undefined;
		}
		if (this.warnedAt && context < this.warnedAt * 1.5) {
			return undefined;
		}
		this.warnedAt = context;
		return { context, processedTotal: this.processedTotal, approximate: this.approximate };
	}
}

export interface AutoCompactOptions {
	readonly enabled: boolean;
	readonly threshold: number;
	readonly minMessagesBetween: number;
	readonly providerAllowed: boolean;
}

export type AutoCompactDecision =
	| { readonly compact: true }
	| { readonly compact: false; readonly reason: 'disabled' | 'provider' | 'below-threshold' | 'too-soon' | 'fixed-part-too-big' };

/**
 * Whether to compact before sending the next user message. Never in the first messages after a compact, and
 * never when the last compact already left the context close to the threshold (the fixed part of the session
 * is that big, so compacting again would cost a call and save little).
 */
export function decideAutoCompact(conversation: ConversationContext, options: AutoCompactOptions): AutoCompactDecision {
	if (!options.enabled || options.threshold <= 0) {
		return { compact: false, reason: 'disabled' };
	}
	if (!options.providerAllowed) {
		return { compact: false, reason: 'provider' };
	}
	if (conversation.lastContext === undefined || conversation.lastContext < options.threshold) {
		return { compact: false, reason: 'below-threshold' };
	}
	if (conversation.compactions > 0 && conversation.messagesSinceCompact < options.minMessagesBetween) {
		return { compact: false, reason: 'too-soon' };
	}
	if (conversation.contextAfterCompact !== undefined && conversation.contextAfterCompact >= options.threshold * 0.8) {
		return { compact: false, reason: 'fixed-part-too-big' };
	}
	return { compact: true };
}

/** Token counts for the chat: "120 mil" / "1,4 mi" in Portuguese, "120K" / "1.4M" in English. */
export function formatTokenCount(value: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: value < 1_000_000 ? 0 : 1 }).format(value);
	} catch {
		return String(value);
	}
}
