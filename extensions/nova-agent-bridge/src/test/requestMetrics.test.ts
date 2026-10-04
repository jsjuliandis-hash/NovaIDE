/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Unit tests of the per-request metrics. Run: node --test out/test
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import type { AcpSessionUpdate } from '../acp';
import { formatMetrics, RecentMetrics, RequestMetrics } from '../requestMetrics';

function clock(...times: number[]): () => number {
	return () => times.shift() ?? 0;
}

test('two tools in the same round and repeated updates count as two tool calls, never as model calls', () => {
	const metrics = new RequestMetrics('r1', 'Codex CLI', 's1', clock(1000, 4000));
	metrics.recordPrompt({ messageChars: 40, manualChars: 1400, attachments: 1 });
	metrics.recordAttempt(false);
	const updates: AcpSessionUpdate[] = [
		{ sessionUpdate: 'usage_update', used: 20000, size: 258400 },
		{ sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'read', status: 'pending' },
		{ sessionUpdate: 'tool_call', toolCallId: 'b', kind: 'search', status: 'pending' },
		{ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress' },
		{ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' },
		{ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed' },
		{ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed' },
		{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pronto' } },
		{ sessionUpdate: 'usage_update', used: 23500, size: 258400 },
	];
	updates.forEach(update => metrics.observe(update));
	const report = metrics.finish({ stopReason: 'end_turn', usage: { inputTokens: 1774, cachedReadTokens: 30080, outputTokens: 733, totalTokens: 32587 } });
	assert.deepStrictEqual(report, {
		schema: 2, requestId: 'r1', kind: 'message', provider: 'Codex CLI', session: 's1', startedAt: new Date(1000).toISOString(), durationMs: 3000,
		promptAttempts: 1, authRetries: 0, messageChars: 40, manualChars: 1400, attachments: 1,
		toolCalls: 2, toolCallsFailed: 1, toolKinds: { read: 1, search: 1 },
		usageUpdates: 2, contextStart: 20000, contextEnd: 23500, contextSize: 258400, cost: undefined,
		usage: { inputTokens: 1774, cachedReadTokens: 30080, outputTokens: 733, totalTokens: 32587 }, usageSource: 'acp.prompt.usage',
		modelCalls: 'unavailable', stopReason: 'end_turn', failed: false,
	});
});

test('a retry after signing in is a second attempt of the same request, not a new message', () => {
	const metrics = new RequestMetrics('r2', 'Gemini CLI', 's2', clock(0, 10));
	metrics.recordAttempt(false);
	metrics.recordAttempt(true);
	const report = metrics.finish({ failed: true });
	assert.deepStrictEqual([report.promptAttempts, report.authRetries, report.failed, report.usage, report.usageSource], [2, 1, true, undefined, undefined]);
});

test('two chat tabs keep separate metrics', () => {
	const tabA = new RequestMetrics('a', 'Claude Code', 'session-a');
	const tabB = new RequestMetrics('b', 'Claude Code', 'session-b');
	// The bridge feeds each collector only with the updates of its own session id.
	const stream: { sessionId: string; update: AcpSessionUpdate }[] = [
		{ sessionId: 'session-a', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit' } },
		{ sessionId: 'session-b', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read' } },
		{ sessionId: 'session-b', update: { sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'read' } },
	];
	for (const { sessionId, update } of stream) {
		(sessionId === 'session-a' ? tabA : tabB).observe(update);
	}
	assert.deepStrictEqual([tabA.finish({}).toolKinds, tabB.finish({}).toolKinds], [{ edit: 1 }, { read: 2 }]);
});

test('the log line shows missing numbers as n/a, never 0, and never the message text', () => {
	const metrics = new RequestMetrics('r3', 'OpenCode', 's3', clock(0, 5));
	metrics.recordPrompt({ messageChars: 12, manualChars: 0, attachments: 0 });
	const line = formatMetrics(metrics.finish({ stopReason: 'end_turn', usage: { totalTokens: 900 } }));
	assert.ok(line.includes('input n/a') && line.includes('total 900') && line.includes('model calls n/a') && line.includes('context n/a → n/a'), line);
});

test('recent metrics keep the newest reports up to the limit', () => {
	const recent = new RecentMetrics(2);
	for (const id of ['1', '2', '3']) {
		recent.add(new RequestMetrics(id, 'OpenCode', 's').finish({}));
	}
	const exported = recent.toExport(new Date(0));
	assert.deepStrictEqual([exported.schema, exported.exportedAt, exported.reports.map(r => r.requestId)], [2, new Date(0).toISOString(), ['2', '3']]);
});
