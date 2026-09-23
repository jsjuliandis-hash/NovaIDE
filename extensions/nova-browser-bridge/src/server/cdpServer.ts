/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Chrome-DevTools-style endpoint so external CDP clients (Playwright's
 *  chromium.connectOverCDP, @playwright/mcp --cdp-endpoint, ...) drive the same
 *  Integrated Browser view the user sees:
 *    GET  [/t/<token>]/json/version              → webSocketDebuggerUrl for the active page
 *    GET  [/t/<token>]/json/list                 → one entry per open page
 *    WS   [/t/<token>]/devtools/browser/<id>     → 1:1 relay to tab.startCDPSession()
 *  Each session is browser-level but scoped to a single view, which is exactly
 *  what connectOverCDP expects. Same loopback/Host/Origin/token rules as the
 *  MCP/REST server, and CDP access counts as arbitrary code execution, so the
 *  first connection per workspace needs the allowEvaluate confirmation.
 *-------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { NovaBrowser } from '../novaBrowser';
import { candidatePorts, INovaBridgeServer, listen } from './httpServer';
import { ensureEvaluateAllowed, validateRequest } from './security';

const ACTIVE_PAGE = 'active';

export interface INovaCdpServer extends INovaBridgeServer {
	/** Base URL to hand to connectOverCDP; includes the token as a path prefix. */
	readonly endpointUrl: string;
}

export async function startCdpServer(novaBrowser: NovaBrowser, token: string, preferredPort: number, onAuthenticatedRequest: () => void): Promise<INovaCdpServer> {
	const wss = new WebSocketServer({ noServer: true });
	let port = 0;

	const wsUrl = (pathToken: string | undefined, pageId: string) =>
		`ws://127.0.0.1:${port}${pathToken ? `/t/${pathToken}` : ''}/devtools/browser/${encodeURIComponent(pageId)}`;

	const server = http.createServer((req, res) => {
		const { pathToken, pathname } = splitPath(req.url);
		const rejection = validateRequest(req, token, pathToken);
		if (rejection) {
			writeJson(res, rejection.status, { error: rejection.message });
			return;
		}
		onAuthenticatedRequest();

		if (req.method === 'GET' && /^\/json\/version\/?$/.test(pathname)) {
			writeJson(res, 200, {
				'Browser': 'Nova IDE Integrated Browser',
				'Protocol-Version': '1.3',
				'webSocketDebuggerUrl': wsUrl(pathToken, ACTIVE_PAGE),
			});
		} else if (req.method === 'GET' && /^\/json(\/list)?\/?$/.test(pathname)) {
			writeJson(res, 200, novaBrowser.listPages().map(page => ({
				id: page.id,
				type: 'page',
				title: page.title,
				url: page.url,
				webSocketDebuggerUrl: wsUrl(pathToken, page.id),
			})));
		} else {
			writeJson(res, 404, { error: 'Not found. Use /json/version, /json/list or /devtools/browser/<page id|active>.' });
		}
	});

	server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
		void (async () => {
			const { pathToken, pathname } = splitPath(req.url);
			const rejection = validateRequest(req, token, pathToken);
			if (rejection) {
				return rejectUpgrade(socket, rejection.status, rejection.message);
			}
			const match = /^\/devtools\/browser\/([^/]+)$/.exec(pathname);
			if (!match) {
				return rejectUpgrade(socket, 404, 'Not found');
			}
			onAuthenticatedRequest();

			const pageId = decodeURIComponent(match[1]);
			let session;
			try {
				await ensureEvaluateAllowed();
				session = await novaBrowser.startExternalCDPSession(pageId === ACTIVE_PAGE ? undefined : pageId);
			} catch (error) {
				return rejectUpgrade(socket, 403, error instanceof Error ? error.message : String(error));
			}

			wss.handleUpgrade(req, socket, head, ws => {
				const received = session.onDidReceiveMessage(message => {
					onAuthenticatedRequest();
					ws.send(JSON.stringify(message));
				});
				const closed = session.onDidClose(() => ws.close());
				ws.on('message', data => {
					try {
						void session.sendMessage(JSON.parse(data.toString()));
					} catch {
						ws.close(1007, 'Invalid JSON');
					}
				});
				ws.on('close', () => {
					received.dispose();
					closed.dispose();
					void session.close();
				});
			});
		})();
	});

	port = await listen(server, candidatePorts(preferredPort));

	return {
		port,
		endpointUrl: `http://127.0.0.1:${port}/t/${token}`,
		close: () => new Promise<void>((resolve, reject) => {
			for (const client of wss.clients) {
				client.close();
			}
			wss.close();
			server.close(err => err ? reject(err) : resolve());
		}),
	};
}

/** Strips an optional `/t/<token>` prefix, returning the token and the remaining path. */
function splitPath(url: string | undefined): { pathToken?: string; pathname: string } {
	const pathname = (url ?? '/').split('?')[0];
	const match = /^\/t\/([^/]+)(\/.*)?$/.exec(pathname);
	return match ? { pathToken: decodeURIComponent(match[1]), pathname: match[2] ?? '/' } : { pathname };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${message}`);
}

function writeJson(res: http.ServerResponse, status: number, json: unknown): void {
	const payload = JSON.stringify(json);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
	res.end(payload);
}
