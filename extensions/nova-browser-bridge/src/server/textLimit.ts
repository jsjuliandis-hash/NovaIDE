/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Pure helpers that keep tool results small without breaking them: text is cut on line
 *  boundaries (never in the middle of a line or of a JSON value) and the result says what was
 *  left out and how to get it. Also measures tool results for the MCP usage log.
 *-------------------------------------------------------------------------------------------*/

export interface LineWindow {
	/** First line to return, 1-based. Default 1. */
	readonly startLine?: number;
	/** Most characters to return; whole lines only, but at least one line. No limit when omitted. */
	readonly maxChars?: number;
}

export interface LimitedText {
	readonly text: string;
	readonly truncated: boolean;
	/** 1-based, inclusive range of the lines returned (0..0 when the text is empty). */
	readonly firstLine: number;
	readonly lastLine: number;
	readonly totalLines: number;
	readonly totalChars: number;
}

/** Returns the lines of `text` that fit in the window. */
export function limitLines(text: string, window: LineWindow): LimitedText {
	const lines = text.split('\n');
	const totalLines = text ? lines.length : 0;
	const start = Math.min(Math.max(1, Math.floor(window.startLine ?? 1)), Math.max(1, totalLines));
	const maxChars = window.maxChars !== undefined && window.maxChars > 0 ? window.maxChars : Infinity;
	const picked: string[] = [];
	let size = 0;
	for (let index = start - 1; index < totalLines; index++) {
		const line = lines[index];
		const added = line.length + (picked.length ? 1 : 0);
		if (picked.length && size + added > maxChars) {
			break;
		}
		picked.push(line);
		size += added;
	}
	const lastLine = totalLines ? start + picked.length - 1 : 0;
	return {
		text: picked.join('\n'),
		truncated: start > 1 || lastLine < totalLines,
		firstLine: totalLines ? start : 0,
		lastLine,
		totalLines,
		totalChars: text.length,
	};
}

/** One line telling the agent which part it got and how to ask for the rest; empty when nothing was left out. */
export function describeLimit(limited: LimitedText, continueHint: string): string {
	if (!limited.truncated) {
		return '';
	}
	const more = limited.lastLine < limited.totalLines ? ` For the rest: ${continueHint.replace('{next}', String(limited.lastLine + 1))}` : '';
	return `… (partial: lines ${limited.firstLine}-${limited.lastLine} of ${limited.totalLines}, ${limited.text.length} of ${limited.totalChars} characters.${more})`;
}

/** Volume of one MCP tool result: characters of text and size of images, not tokens. */
export interface ToolResultVolume {
	readonly textChars: number;
	readonly images: number;
	readonly imageBytes: number;
	readonly isError: boolean;
	readonly truncated: boolean;
}

interface ToolResultLike {
	readonly content?: readonly { readonly type: string; readonly text?: string; readonly data?: string }[];
	readonly isError?: boolean;
}

export function measureToolResult(result: unknown): ToolResultVolume {
	const content = (result as ToolResultLike | undefined)?.content ?? [];
	let textChars = 0;
	let images = 0;
	let imageBytes = 0;
	let truncated = false;
	for (const item of content) {
		if (item.type === 'text' && item.text) {
			textChars += item.text.length;
			truncated ||= /… \((partial|truncated|earlier output omitted)/.test(item.text);
		} else if (item.type === 'image' && item.data) {
			images++;
			imageBytes += Math.floor(item.data.length * 3 / 4); // base64 → bytes
		}
	}
	return { textChars, images, imageBytes, isError: !!(result as ToolResultLike | undefined)?.isError, truncated };
}
