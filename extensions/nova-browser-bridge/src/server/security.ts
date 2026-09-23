/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  MVP security for the local bridge server: bind-to-loopback is enforced by the
 *  caller (httpServer.ts only ever listens on 127.0.0.1), and this module covers
 *  everything else the plan calls for: a mandatory bearer token, rejecting any
 *  request that carries a browser-style `Origin` header (a real browser tab is
 *  never a legitimate caller of this API — only CLIs/MCP clients are), a `Host`
 *  header allowlist as a second anti DNS-rebinding layer, and the "confirm once
 *  per workspace" gate for arbitrary Playwright code execution.
 *-------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function generateToken(): string {
	return crypto.randomBytes(24).toString('base64url');
}

export interface IBridgeFile {
	url: string;
	token: string;
	pid: number;
	/** Endpoint for `chromium.connectOverCDP(cdpUrl)`; carries the token in its path. */
	cdpUrl?: string;
}

const BRIDGE_DIR = path.join(os.homedir(), '.nova-ide');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json');

/** Written on every activation so out-of-terminal tooling can discover the running bridge. */
export async function writeBridgeFile(info: IBridgeFile): Promise<void> {
	await fs.mkdir(BRIDGE_DIR, { recursive: true });
	await fs.writeFile(BRIDGE_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export async function removeBridgeFile(): Promise<void> {
	await fs.rm(BRIDGE_FILE, { force: true });
}

const allowedHostHeaders = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validates the request against every MVP security rule before it reaches the
 * MCP or REST handlers. Writes the error response itself (matching the `http`
 * module's low-ceremony style used by the rest of this server) and returns
 * `false` when the request must stop here.
 */
export function checkRequest(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
	const rejection = validateRequest(req, token);
	if (rejection) {
		respond(res, rejection.status, rejection.message);
		return false;
	}
	return true;
}

/**
 * The rules behind {@link checkRequest}, without writing a response (WebSocket
 * upgrades answer differently). `pathToken` lets clients that can't set headers,
 * such as `--cdp-endpoint` style URLs, put the token in the URL instead.
 */
export function validateRequest(req: http.IncomingMessage, token: string, pathToken?: string): { status: number; message: string } | undefined {
	const hostHeader = (req.headers.host ?? '').split(':')[0];
	if (!allowedHostHeaders.has(hostHeader)) {
		return { status: 403, message: 'Forbidden: unexpected Host header' };
	}

	// A real browser tab always sends `Origin`; CLIs and MCP HTTP clients never
	// do. Rejecting any Origin — including one claiming to be localhost —
	// closes the classic "malicious page on localhost drives a local API"
	// hole without needing to reason about which origins are "safe".
	if (req.headers.origin !== undefined) {
		return { status: 403, message: 'Forbidden: browser-originated requests are not allowed' };
	}

	const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice('Bearer '.length) : undefined;
	if (!tokensMatch(bearer, token) && !tokensMatch(pathToken, token)) {
		return { status: 401, message: 'Unauthorized: missing or invalid bearer token' };
	}

	return undefined;
}

function tokensMatch(candidate: string | undefined, token: string): boolean {
	if (candidate === undefined) {
		return false;
	}
	const a = Buffer.from(candidate);
	const b = Buffer.from(token);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function respond(res: http.ServerResponse, status: number, message: string): void {
	res.writeHead(status, { 'content-type': 'text/plain' });
	res.end(message);
}

/**
 * Gates arbitrary-code execution (`runPlaywright` / the CLI's `run` command)
 * behind `nova.browserBridge.allowEvaluate`. The first time a workspace hits
 * this, the user is asked to confirm; approving persists the setting for that
 * workspace so later calls don't re-prompt. Denying throws, which the caller
 * surfaces as a tool/HTTP error.
 */
export async function ensureEvaluateAllowed(): Promise<void> {
	const config = vscode.workspace.getConfiguration('nova.browserBridge');
	if (config.get<boolean>('allowEvaluate', false)) {
		return;
	}

	const allowLabel = vscode.l10n.t('Allow');
	const allow = await vscode.window.showWarningMessage(
		vscode.l10n.t('An external agent wants to run custom Playwright code against a browser page controlled by this workspace. Allow this for the current workspace?'),
		{ modal: true },
		allowLabel,
	);
	if (allow !== allowLabel) {
		throw new Error('Denied: nova.browserBridge.allowEvaluate is disabled for this workspace.');
	}
	await config.update('allowEvaluate', true, vscode.ConfigurationTarget.Workspace);
}
