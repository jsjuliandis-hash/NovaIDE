/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  ide_* MCP tools: let agents show files, images and diffs in the IDE itself (instead of an
 *  external program or the browser), and read the Nova IDE manual.
 *-------------------------------------------------------------------------------------------*/

import { McpServer } from '@modelcontextprotocol/server';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as z from 'zod';
import { markActiveEditorOpenedByAgent } from '../agentTabs';
import { selectManualSection } from './manual';
import { registerUiTools } from './uiTools';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']);
const IMAGE_VIEWER_ID = 'imagePreview.previewEditor';

/** Reads the Nova IDE manual (SKILL.md) that ships inside this extension. */
export function readNovaIdeManual(): string {
	const extensionPath = vscode.extensions.getExtension('nova-ide.nova-browser-bridge')?.extensionPath ?? path.join(__dirname, '..', '..');
	return fs.readFileSync(path.join(extensionPath, 'media', 'nova-ide', 'SKILL.md'), 'utf8');
}

/** The viewer a file was opened with, so tool results can tell the agent what the user now sees. */
type OpenKind = 'image' | 'markdownPreview' | 'text';

function resolveUri(input: string): vscode.Uri {
	if (path.isAbsolute(input)) {
		return vscode.Uri.file(input);
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return vscode.Uri.file(path.resolve(folder ?? process.cwd(), input));
}

async function assertFileExists(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		throw new Error(`File not found: ${uri.fsPath}`);
	}
}

export function registerIdeTools(server: McpServer): void {
	registerUiTools(server);

	server.registerTool(
		'ide_open_file',
		{
			description: 'Show a file to the user inside Nova IDE. Images (png, jpg, gif, webp, bmp, ico, avif, svg) open in the IDE built-in image viewer; other files open in the editor, optionally at a line. Use this instead of any external program or browser whenever the user should see a file.',
			inputSchema: {
				path: z.string().describe('Absolute path, or path relative to the workspace folder.'),
				line: z.number().int().positive().optional().describe('1-based line to reveal (text files).'),
				column: z.number().int().positive().optional().describe('1-based column (text files).'),
				mode: z.enum(['auto', 'text', 'preview']).optional().describe('auto (default) picks the best viewer; text forces the text editor; preview renders Markdown.'),
				beside: z.boolean().optional().describe('Open in a new editor group beside the active one.'),
			},
		},
		async ({ path: input, line, column, mode, beside }) => {
			const uri = resolveUri(input);
			await assertFileExists(uri);
			const kind = await openFile(uri, { line, column, mode: mode ?? 'auto', beside: !!beside });
			markActiveEditorOpenedByAgent();
			return textResult(describeOpen(kind, uri));
		},
	);

	server.registerTool(
		'ide_show_diff',
		{
			description: 'Show two files side by side in the IDE diff editor, e.g. the original and the changed version.',
			inputSchema: {
				left: z.string().describe('Path of the original file.'),
				right: z.string().describe('Path of the changed file.'),
				title: z.string().optional().describe('Title of the diff tab.'),
			},
		},
		async ({ left, right, title }) => {
			const leftUri = resolveUri(left);
			const rightUri = resolveUri(right);
			await assertFileExists(leftUri);
			await assertFileExists(rightUri);
			await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title ?? `${path.basename(left)} ↔ ${path.basename(right)}`);
			markActiveEditorOpenedByAgent();
			return textResult(`Opened a diff of ${leftUri.fsPath} and ${rightUri.fsPath} in the IDE.`);
		},
	);

	server.registerTool(
		'ide_manual',
		{
			description: 'Read the Nova IDE manual: how to show files and images, use the integrated browser and terminals, and work with the Chat panel. Pass a topic to get just that section (much shorter than the whole manual).',
			inputSchema: { topic: z.string().optional().describe('browser, ide, chat, terminal, files, or part of a section heading.') },
		},
		async ({ topic }) => textResult(selectManualSection(readNovaIdeManual(), topic)),
	);
}

async function openFile(uri: vscode.Uri, options: { line?: number; column?: number; mode: 'auto' | 'text' | 'preview'; beside: boolean }): Promise<OpenKind> {
	const extension = path.extname(uri.fsPath).toLowerCase();
	const viewColumn = options.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;

	if (options.mode !== 'text' && IMAGE_EXTENSIONS.has(extension)) {
		await vscode.commands.executeCommand('vscode.openWith', uri, IMAGE_VIEWER_ID, { viewColumn, preview: false });
		return 'image';
	}
	if (options.mode === 'preview' && (extension === '.md' || extension === '.markdown')) {
		await vscode.commands.executeCommand(options.beside ? 'markdown.showPreviewToSide' : 'markdown.showPreview', uri);
		return 'markdownPreview';
	}
	const position = options.line ? new vscode.Position(options.line - 1, (options.column ?? 1) - 1) : undefined;
	await vscode.commands.executeCommand('vscode.open', uri, {
		viewColumn,
		preview: false,
		selection: position && new vscode.Range(position, position),
	});
	return 'text';
}

function describeOpen(kind: OpenKind, uri: vscode.Uri): string {
	switch (kind) {
		case 'image': return `Opened ${uri.fsPath} in the IDE image viewer. The user can see it now.`;
		case 'markdownPreview': return `Opened the rendered Markdown preview of ${uri.fsPath} in the IDE.`;
		default: return `Opened ${uri.fsPath} in the IDE editor.`;
	}
}

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}
