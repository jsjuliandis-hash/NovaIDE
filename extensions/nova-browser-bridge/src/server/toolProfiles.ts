/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Tool profiles of the MCP server: smaller catalogs for sessions that do not need every tool.
 *  Every tool description is sent to the model on every call, so a coding session that never
 *  drives the browser or the IDE interface saves that context by connecting to /mcp/code.
 *  A profile is not a security boundary; it only shortens the catalog.
 *-------------------------------------------------------------------------------------------*/

export type ToolProfile = 'code' | 'browser' | 'full';

/** Showing files and diffs, the manual and the semantic IDE operations. */
const CODE_TOOLS: ReadonlySet<string> = new Set(['ide_manual', 'ide_open_file', 'ide_show_diff', 'ide_chat_new_tab', 'ide_run_command']);

/** True when `tool` is part of the catalog of `profile`. */
export function isToolInProfile(tool: string, profile: ToolProfile): boolean {
	switch (profile) {
		case 'full': return true;
		case 'browser': return CODE_TOOLS.has(tool) || tool.startsWith('browser_') || tool.startsWith('devserver_');
		default: return CODE_TOOLS.has(tool);
	}
}

/** Maps a request path to its profile: /mcp stays the full catalog for existing clients. */
export function profileFromPath(pathname: string): ToolProfile | undefined {
	switch (pathname.replace(/\/+$/, '')) {
		case '/mcp':
		case '/mcp/full': return 'full';
		case '/mcp/browser': return 'browser';
		case '/mcp/code': return 'code';
		default: return undefined;
	}
}

/** Short server instructions that only mention the tools of the profile. */
export function mcpInstructions(profile: ToolProfile): string {
	const lines = [
		'These tools control Nova IDE, the editor the user is looking at.',
		'To show a file or an IMAGE to the user, call ide_open_file (images open in the built-in image viewer); never use start/open/xdg-open or a browser with file:// for that.',
		'Use ide_show_diff for changes and call ide_manual (optionally with a topic) for the full guide.',
	];
	if (profile !== 'code') {
		lines.push('Use browser_* for web pages: actions return the updated snapshot, so reuse it instead of calling browser_snapshot again; fill several fields at once with browser_fill_form.');
	}
	if (profile === 'full') {
		lines.push('To act on the IDE itself use ide_ui_snapshot once, then ide_ui_click, ide_ui_type and ide_ui_key (each returns the updated snapshot), ide_ui_screenshot and ide_run_command; to run commands use ide_terminal_run.');
	}
	return lines.join(' ');
}
