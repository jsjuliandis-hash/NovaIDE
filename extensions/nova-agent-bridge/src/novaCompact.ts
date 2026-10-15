/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Nova compact: instead of the agent's own `/compact`, the agent writes a structured hand-off
 *  summary (like the user's /salve), and the conversation goes on in a fresh agent session that
 *  starts from that summary (like /resumo). Nova controls what survives, the same way for every
 *  agent. Prompt texts and parsing only; no vscode import, so the unit tests run under plain Node.
 *-------------------------------------------------------------------------------------------*/

/** The chat command that runs a Nova compact by hand; text after it says what to focus on. */
export const NOVA_COMPACT_COMMAND = 'nova-compact';

/** The chat command of the button under each answer: summarize, clear the chat and go on from the saved summary. */
export const NOVA_SAVE_COMMAND = 'nova-save';

/** Sent by Nova IDE itself to a new chat that starts from a saved summary; answered without calling the model. */
export const NOVA_LOADED_COMMAND = 'nova-loaded';

export const DEFAULT_SUMMARY_CHARS = 6000;
export const MIN_SUMMARY_CHARS = 1500;
export const MAX_SUMMARY_CHARS = 20000;

/** A summary shorter than this is treated as a failed compact (the agent refused or answered something else). */
const MIN_USEFUL_SUMMARY = 200;

export type CompactCommand =
	| { readonly kind: 'nova'; readonly focus: string }
	| { readonly kind: 'save'; readonly focus: string }
	| { readonly kind: 'loaded' }
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
	if (match.groups.name === NOVA_SAVE_COMMAND) {
		return { kind: 'save', focus: (match.groups.rest ?? '').trim() };
	}
	if (match.groups.name === NOVA_LOADED_COMMAND) {
		return { kind: 'loaded' };
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
		'- The first line is `TITLE: ` followed by a title of at most 60 characters that names the subject of this conversation (no quotes, no date); the template starts on the next line.',
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

const MAX_TITLE_CHARS = 60;

/** Splits the `TITLE: ...` first line the summary request asks for from the summary. The title is undefined when the agent left it out. */
export function splitTitle(text: string): { readonly title: string | undefined; readonly body: string } {
	const match = /^\s*(?:#+\s*)?\**TITLE:\**\s*(?<title>[^\n]*)\n?(?<body>[\s\S]*)$/i.exec(text);
	if (!match?.groups) {
		return { title: undefined, body: text };
	}
	return { title: cleanTitle(match.groups.title), body: match.groups.body };
}

/** One line, no markup or quotes, at most 60 characters. Undefined when nothing is left. */
export function cleanTitle(text: string | undefined): string | undefined {
	const title = (text ?? '').replace(/[`*_#"“”]/g, '').replace(/\s+/g, ' ').trim();
	if (!title) {
		return undefined;
	}
	return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title;
}

/** The title to save: the one the agent wrote, else the first line of "User request", else a generic one. */
export function chooseTitle(title: string | undefined, summary: string): string {
	const request = /^##\s*User request\s*\n+(?<line>[^\n]+)/im.exec(summary)?.groups?.line;
	return cleanTitle(title) ?? cleanTitle(request) ?? 'Conversa sem título';
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

/** The summary saved for the user: the file the "Resume Saved Conversation" command lists and loads. The code (1, 2, 3…) indexes it. */
export function summaryDocument(input: { readonly options?: Readonly<Record<string, string>>; readonly code: number; readonly title: string; readonly agentType: string; readonly provider: string; readonly date: Date; readonly contextBefore: number | undefined; readonly summary: string }): string {
	return [
		`# ${input.title}`,
		'',
		`**Código:** ${input.code}`,
		`**Agente:** ${input.provider}`,
		`**Tipo:** ${input.agentType}`,
		`**Data:** ${input.date.toISOString()}`,
		`**Contexto antes:** ${input.contextBefore ?? 'n/d'} tokens`,
		`**Opções:** ${JSON.stringify(input.options ?? {})}`,
		'',
		'---',
		'',
		input.summary,
		'',
	].join('\n');
}

export interface SavedSummary {
	readonly code: number;
	readonly title: string;
	readonly agentType: string;
	readonly provider: string;
	readonly date: Date;
	/** The model, mode and effort the saved conversation ran with (ACP option id → value); empty for older files. */
	readonly options: Readonly<Record<string, string>>;
	readonly summary: string;
}

/** Reads a file written by {@link summaryDocument}. Undefined for any other file (including the older format without a code). */
export function parseSummaryDocument(text: string): SavedSummary | undefined {
	const separator = text.indexOf('\n---\n');
	if (separator < 0) {
		return undefined;
	}
	const head = text.slice(0, separator);
	const field = (name: string) => new RegExp(`^\\*\\*${name}:\\*\\*\\s*(?<value>.+)$`, 'm').exec(head)?.groups?.value.trim();
	const title = /^#\s+(?<value>.+)$/m.exec(head)?.groups?.value.trim();
	const code = Number(field('Código'));
	const provider = field('Agente');
	const agentType = field('Tipo');
	const date = new Date(field('Data') ?? '');
	const summary = text.slice(separator + 5).trim();
	const options = parseOptions(field('Opções'));
	if (!title || !Number.isInteger(code) || code < 1 || !provider || !agentType || Number.isNaN(date.getTime()) || !summary) {
		return undefined;
	}
	return { code, title, agentType, provider, date, options, summary };
}

/** The `Opções` line: a JSON object of strings; anything else reads as no options. */
function parseOptions(text: string | undefined): Record<string, string> {
	try {
		const value: unknown = JSON.parse(text ?? '{}');
		return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
	} catch {
		return {};
	}
}

/** A file name for a saved summary: the date, the code and the title in ASCII (so it sorts by date and is valid everywhere). */
export function summaryFileName(code: number, title: string, date: Date): string {
	const slug = title.normalize('NFD').replace(new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g'), '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
	return `${date.toISOString().replace(/[:.]/g, '-')}-${code}-${slug || 'conversa'}.md`;
}
