/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Unit tests of the context accounting, with event sequences recorded from Claude Code and
 *  Codex on 2026-10-04. Run: node --test "out/test/*.test.js"
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { ConversationContext, decideAutoCompact, distinctContextValues, formatTokenCount, modelsUsed, requestProcessedTokens } from '../contextAccounting';

const claudeMeta = (model: string, totalTokens: number) => ({ quota: { model_usage: [{ model, token_count: { totalTokens } }] } });

test('Claude Code: the agent sum is used, repeated usage updates are ignored, and a compact is read from _meta', () => {
	// 27 file reads: the usage_update values repeat (120057 three times) and must not be added up.
	const reading = requestProcessedTokens({
		semantics: 'request-sum',
		usage: { inputTokens: 42, outputTokens: 4033, cachedReadTokens: 230191, cachedWriteTokens: 99501, totalTokens: 333767 },
		meta: claudeMeta('claude-haiku-4-5-20251001', 335097),
		contextUpdates: [27667, 28008, 28008, 28451, 30002, 30002, 63682, 64727, 89943, 90973, 120007, 120057, 120057, 120057]
	});
	// /compact: usage is all zero, the real cost is only in _meta.
	const compact = requestProcessedTokens({
		semantics: 'request-sum',
		usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 },
		meta: claudeMeta('claude-haiku-4-5-20251001', 124740),
		contextUpdates: [11829],
		nativeCompact: true
	});
	assert.deepStrictEqual({ reading, compact }, {
		reading: { tokens: 333767, source: 'agent-sum' },
		compact: { tokens: 124740, source: 'agent-sum' }
	});
});

test('Codex: usage is the last call, so the context of each call is added up as an estimate; its compact reports nothing', () => {
	const reading = requestProcessedTokens({
		semantics: 'last-call',
		usage: { totalTokens: 95640, inputTokens: 2693, cachedReadTokens: 92928, outputTokens: 19, thoughtTokens: 10 },
		meta: undefined,
		contextUpdates: [49687, 57490, 65646, 73848, 84299, 91279, 94178, 95640]
	});
	const compact = requestProcessedTokens({ semantics: 'last-call', usage: { totalTokens: 6960 }, meta: undefined, contextUpdates: [6960], nativeCompact: true });
	const unknownAgent = requestProcessedTokens({ semantics: undefined, usage: undefined, meta: undefined, contextUpdates: [100, 100, 250] });
	const nothing = requestProcessedTokens({ semantics: undefined, usage: undefined, meta: undefined, contextUpdates: [] });
	assert.deepStrictEqual({ reading, compact, unknownAgent, nothing }, {
		reading: { tokens: 612067, source: 'usage-updates' },
		compact: { tokens: undefined, source: 'unavailable' },
		unknownAgent: { tokens: 350, source: 'usage-updates' },
		nothing: { tokens: undefined, source: 'unavailable' }
	});
});

test('models come from _meta, repeated context values collapse', () => {
	assert.deepStrictEqual({
		models: modelsUsed({ quota: { model_usage: [{ model: 'claude-opus-5-5' }, { model: 'claude-opus-5-5' }, { model: 'claude-haiku-4-5-20251001' }] } }),
		none: modelsUsed(undefined),
		distinct: distinctContextValues([1, 1, 2, 2, 2, 1])
	}, { models: ['claude-opus-5-5', 'claude-haiku-4-5-20251001'], none: [], distinct: [1, 2, 1] });
});

test('the warning shows once when the context crosses the threshold, again at +50%, and again after a compact', () => {
	const conversation = new ConversationContext();
	const warnings: (number | undefined)[] = [];
	for (const context of [60000, 120000, 125000, 170000, 185000]) {
		conversation.record({ context, contextSize: 200000, processed: { tokens: context, source: 'agent-sum' }, userMessage: true });
		warnings.push(conversation.takeWarning(100000)?.context);
	}
	conversation.recordCompact();
	conversation.record({ context: 36000, contextSize: 200000, processed: { tokens: 36000, source: 'agent-sum' }, userMessage: true });
	warnings.push(conversation.takeWarning(100000)?.context);
	conversation.record({ context: 101000, contextSize: 200000, processed: { tokens: 101000, source: 'agent-sum' }, userMessage: true });
	warnings.push(conversation.takeWarning(100000)?.context);
	assert.deepStrictEqual({ warnings, off: conversation.takeWarning(0), total: conversation.processedTotal, approximate: conversation.approximate, messages: conversation.messages, compactions: conversation.compactions },
		{ warnings: [undefined, 120000, undefined, undefined, 185000, undefined, 101000], off: undefined, total: 797000, approximate: false, messages: 7, compactions: 1 });
});

test('two tabs keep separate totals, and an estimate marks the total as approximate', () => {
	const claude = new ConversationContext();
	const codex = new ConversationContext();
	claude.record({ context: 120132, contextSize: 200000, processed: { tokens: 120132, source: 'agent-sum' }, userMessage: true });
	codex.record({ context: 110791, contextSize: 258400, processed: { tokens: 110791, source: 'usage-updates' }, userMessage: true });
	codex.record({ context: 6960, contextSize: 258400, processed: { tokens: undefined, source: 'unavailable' }, userMessage: false });
	assert.deepStrictEqual(
		[claude.processedTotal, claude.approximate, codex.processedTotal, codex.approximate, codex.messages],
		[120132, false, 110791, true, 1]);
});

test('auto compact: off by default, per provider, above the threshold, not too soon, not when the fixed part is big', () => {
	const options = { enabled: true, threshold: 100000, minMessagesBetween: 2, providerAllowed: true };
	const conversation = new ConversationContext();
	const decisions: string[] = [];
	const decide = (override: Partial<typeof options> = {}) => {
		const decision = decideAutoCompact(conversation, { ...options, ...override });
		decisions.push(decision.compact ? 'compact' : decision.reason);
	};
	conversation.record({ context: 90000, contextSize: 200000, processed: { tokens: 1, source: 'agent-sum' }, userMessage: true });
	decide();
	conversation.record({ context: 120000, contextSize: 200000, processed: { tokens: 1, source: 'agent-sum' }, userMessage: true });
	decide({ enabled: false });
	decide({ providerAllowed: false });
	decide();
	conversation.recordCompact();
	conversation.record({ context: 110000, contextSize: 200000, processed: { tokens: 1, source: 'agent-sum' }, userMessage: true });
	decide();
	conversation.record({ context: 115000, contextSize: 200000, processed: { tokens: 1, source: 'agent-sum' }, userMessage: true });
	decide();
	assert.deepStrictEqual(decisions, ['below-threshold', 'disabled', 'provider', 'compact', 'too-soon', 'fixed-part-too-big']);
});

test('token counts are short and localized', () => {
	const format = (value: number, locale: string) => formatTokenCount(value, locale).replace(/\s/g, ' ');
	assert.deepStrictEqual([format(120132, 'en'), format(1400000, 'en'), format(120132, 'pt-BR'), format(1400000, 'pt-BR')], ['120K', '1.4M', '120 mil', '1,4 mi']);
});
