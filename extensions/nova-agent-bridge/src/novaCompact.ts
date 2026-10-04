/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Nova compact: instead of the agent's own `/compact`, the agent writes a structured hand-off
 *  summary (like the user's /salve), and the conversation goes on in a fresh agent session that
 *  starts from that summary (like /resumo). Nova controls what survives, the same way for every
 *  agent. Prompt texts and parsing only; no vscode import, so the unit tests run under plain Node.
 *-------------------------------------------------------------------------------------------*/

/** The chat command that runs a Nova compact by hand; text after it says what to focus on. */
export const NOVA_COMPACT_COMMAND = 'nova-compact';

export const DEFAULT_SUMMARY_CHARS = 6000;
export const MIN_SUMMARY_CHARS = 1500;
export const MAX_SUMMARY_CHARS = 20000;

/** A summary shorter than this is treated as a failed compact (the agent refused or answered something else). */
const MIN_USEFUL_SUMMARY = 200;

export type CompactCommand =
	| { readonly kind: 'nova'; readonly focus: string }
	| { readonly kind: 'native' };

/** `/nova-compact [focus]` runs the Nova compact; `/compact [...]` is the agent's own. */
export function parseCompactCommand(text: string): CompactCommand | undefined {
	const match = /^\s*\/(?<name>[\w-]+)(?:\s+(?<rest>[\s\S]*))?$/.exec(text);
	if (!match?.groups) {
		return undefined;
	}
	if (match.groups.name === NOVA_COMPACT_COMMAND) {
		return { kind: 'nova', focus: (match.groups.rest ?? '').trim() };
	}
	if (match.groups.name === 'compact') {
		return { kind: 'native' };
	}
	return undefined;
}

export function clampSummaryChars(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_SUMMARY_CHARS;
	}
	return Math.min(MAX_SUMMARY_CHARS, Math.max(MIN_SUMMARY_CHARS, Math.round(value)));
}

/** The prompt sent to the current agent session to get the hand-off summary. */
export function buildSummaryRequest(maxChars: number, focus: string): string {
	return [
		'<nova-compact-request>',
		'Nova IDE is about to continue this conversation in a fresh agent session to save context. Write the hand-off summary that the new session will receive in place of the whole history. The new session will not have any earlier message or file content, and the next questions of the user may be about any detail of this conversation, including the contents of the files that were read.',
		'',
		'Rules:',
		`- Reply with the summary only, written in the language the user writes in, in at most ${maxChars} characters.`,
		'- Do not call tools and do not read files: use only what is already in this conversation.',
		'- Never invent anything. If something is uncertain, say so.',
		'- Copy names, paths, values, commands and error messages literally; they are what a new session cannot guess.',
		'- Use the space you have when there are many details; a short summary that drops details is a failed summary.',
		'',
		'Use exactly this template, with every section present and in this order:',
		'## User request',
		'The goal, in the words of the user where they matter, and the preferences and constraints of the user.',
		'## Done so far',
		'What was done and how it was verified.',
		'## Files',
		'One block for every file that was read, created or changed and still matters:',
		'### <path>',
		'- Purpose: one line.',
		'- Names: classes with their methods, functions with their parameters, exported types.',
		'- Values: constants, limits and settings, each with its exact value.',
		'## Key facts',
		'Exact names, values, commands, decisions and their reasons that are not under Files.',
		'## Pending',
		'Open tasks, the next step, and questions waiting for the user.',
		...(focus ? ['', `The user asked the summary to focus on: ${focus}`] : []),
		'</nova-compact-request>',
	].join('\n');
}

/** Cleans the agent's answer: trims it and removes a code fence around the whole summary. Undefined when unusable. */
export function cleanSummary(text: string): string | undefined {
	let summary = text.trim();
	const fenced = /^```[\w-]*\n(?<body>[\s\S]*?)\n```$/.exec(summary);
	if (fenced?.groups) {
		summary = fenced.groups.body.trim();
	}
	return summary.length >= MIN_USEFUL_SUMMARY ? summary : undefined;
}

/** The first prompt block of the new agent session. */
export function wrapSummary(summary: string): string {
	return [
		'<nova-conversation-summary>',
		'This conversation continues from an earlier agent session that Nova IDE summarized to save context. The summary below replaces the earlier messages. Read files again only when you need details that are not here.',
		'',
		summary,
		'</nova-conversation-summary>',
	].join('\n');
}

/** The summary saved for the user, in the shape of their /salve summaries. */
export function summaryDocument(input: { readonly provider: string; readonly date: Date; readonly contextBefore: number | undefined; readonly summary: string }): string {
	return [
		`# Nova compact — ${input.provider}`,
		'',
		`**Data:** ${input.date.toISOString().slice(0, 16).replace('T', ' ')}`,
		`**Contexto antes:** ${input.contextBefore ?? 'n/d'} tokens`,
		'',
		input.summary,
		'',
	].join('\n');
}
