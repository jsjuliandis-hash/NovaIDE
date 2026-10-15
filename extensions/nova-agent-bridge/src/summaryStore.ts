/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-agent-bridge
 *  The saved conversation summaries of the Nova compact: one Markdown file per summary in the extension's
 *  global storage (never in the user's folders), newest {@link KEPT_SUMMARIES} kept. Each summary has a
 *  code (1, 2, 3…) that is never reused, even after old summaries are deleted.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { parseSummaryDocument, SavedSummary, summaryDocument, summaryFileName } from './novaCompact';

/** How many saved summaries are kept on disk. */
const KEPT_SUMMARIES = 50;

const FOLDER = 'compact-summaries';
const COUNTER_FILE = 'last-code.txt';

export interface StoredSummary extends SavedSummary {
	readonly file: vscode.Uri;
}

export class SummaryStore {

	constructor(private readonly storage: vscode.Uri) { }

	private get folder(): vscode.Uri {
		return vscode.Uri.joinPath(this.storage, FOLDER);
	}

	/** Writes the summary under the next code and drops the oldest files beyond the limit. Returns the file and its code. */
	async save(input: { readonly options?: Readonly<Record<string, string>>; readonly title: string; readonly agentType: string; readonly provider: string; readonly contextBefore: number | undefined; readonly summary: string }): Promise<{ readonly file: vscode.Uri; readonly code: number }> {
		await vscode.workspace.fs.createDirectory(this.folder);
		const code = await this.nextCode();
		const date = new Date();
		const file = vscode.Uri.joinPath(this.folder, summaryFileName(code, input.title, date));
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(summaryDocument({ ...input, code, date })));
		const names = await this.names();
		for (const name of names.slice(0, Math.max(0, names.length - KEPT_SUMMARIES))) {
			await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.folder, name));
		}
		return { file, code };
	}

	/** The saved summaries, newest first. Files that are not in the current format (older compacts) are skipped. */
	async list(): Promise<StoredSummary[]> {
		const found: StoredSummary[] = [];
		for (const name of (await this.names()).reverse()) {
			const file = vscode.Uri.joinPath(this.folder, name);
			try {
				const parsed = parseSummaryDocument(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
				if (parsed) {
					found.push({ ...parsed, file });
				}
			} catch {
				// unreadable file: not listed
			}
		}
		return found;
	}

	/** The code after the last one handed out: kept in its own file, and never lower than the codes still on disk. */
	private async nextCode(): Promise<number> {
		const counterFile = vscode.Uri.joinPath(this.folder, COUNTER_FILE);
		let last = 0;
		try {
			last = Number(new TextDecoder().decode(await vscode.workspace.fs.readFile(counterFile)).trim()) || 0;
		} catch {
			// first summary
		}
		for (const { code } of await this.list()) {
			last = Math.max(last, code);
		}
		const code = last + 1;
		await vscode.workspace.fs.writeFile(counterFile, new TextEncoder().encode(String(code)));
		return code;
	}

	/** File names, oldest first (they start with the date). */
	private async names(): Promise<string[]> {
		try {
			return (await vscode.workspace.fs.readDirectory(this.folder)).map(([name]) => name).filter(name => name.endsWith('.md')).sort();
		} catch {
			return [];
		}
	}
}
