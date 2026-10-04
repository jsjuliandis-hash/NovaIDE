/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  Text for the activity panel of an answer (the chat's collapsible thinking box): what each
 *  agent tool call did, its command output or the lines it changed. These parts only live in
 *  the local chat history; the agent keeps its own history and never receives them back. No
 *  vscode import, so the unit tests can run it under plain Node.
 *-------------------------------------------------------------------------------------------*/

/** Longest tool output or diff shown when an activity item is expanded. */
export const MAX_ACTIVITY_DETAIL = 3000;
/** Longest title (path, command) in one activity line. */
export const MAX_ACTIVITY_TITLE = 160;

/** The `content` items of an ACP tool call that carry something to show. */
export interface AcpToolContentItem {
	readonly type?: string;
	readonly content?: { readonly type?: string; readonly text?: string };
	readonly path?: string;
	readonly oldText?: string | null;
	readonly newText?: string;
}

/** One line of text: whitespace collapsed, cut with "…" at `max` characters. */
export function shortText(text: string, max = MAX_ACTIVITY_TITLE): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Inline code that survives backticks inside the text. */
export function inlineCode(text: string): string {
	const fence = text.includes('`') ? '``' : '`';
	const pad = fence === '``' ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** The end of a long text, which is where command results usually are. */
export function tail(text: string, max = MAX_ACTIVITY_DETAIL): string {
	const trimmed = text.replace(/\s+$/, '');
	return trimmed.length > max ? `…\n${trimmed.slice(trimmed.length - max)}` : trimmed;
}

/** Text output of a finished tool call: its text content items, else a string raw output. */
export function toolOutputText(content: readonly AcpToolContentItem[] | undefined, rawOutput: unknown): string | undefined {
	const texts = (content ?? []).filter(item => item?.type === 'content' && item.content?.type === 'text' && item.content.text).map(item => item.content!.text!);
	let text = texts.length ? texts.join('\n') : typeof rawOutput === 'string' ? rawOutput : undefined;
	// Some agents (Claude Code) wrap the output in a Markdown code fence; the panel already shows it as code.
	text = text?.trim().replace(/^```[\w-]*\r?\n(?<body>[\s\S]*?)\r?\n?```$/, '$<body>');
	return text?.trim() ? tail(text) : undefined;
}

/** The lines an edit removed ("- ") and added ("+ "), from the ACP `diff` content items. */
export function diffText(content: readonly AcpToolContentItem[] | undefined): string | undefined {
	const lines: string[] = [];
	for (const item of content ?? []) {
		if (item?.type !== 'diff' || typeof item.newText !== 'string') {
			continue;
		}
		const before = item.oldText ? item.oldText.split(/\r?\n/) : [];
		const after = item.newText.split(/\r?\n/);
		// Keep only the changed middle: drop the lines both versions share at the start and the end.
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) {
			start++;
		}
		let end = 0;
		while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
			end++;
		}
		if (item.path) {
			lines.push(`@@ ${item.path}`);
		}
		lines.push(...before.slice(start, before.length - end).map(line => `- ${line}`));
		lines.push(...after.slice(start, after.length - end).map(line => `+ ${line}`));
	}
	if (!lines.length) {
		return undefined;
	}
	const text = lines.join('\n');
	return text.length > MAX_ACTIVITY_DETAIL ? `${text.slice(0, MAX_ACTIVITY_DETAIL)}\n…` : text;
}
