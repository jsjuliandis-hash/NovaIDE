/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Single local HTTP server (127.0.0.1 only) fronting two surfaces on top of the
 *  same NovaBrowser instance:
 *    - POST /mcp        Streamable HTTP MCP endpoint (Claude Code, Gemini CLI, Codex, ...)
 *    - /v1/*            Plain JSON REST, used by bin/nova-browser.js
 *  Every request passes the same security.checkRequest gate first.
 *-------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { NovaBrowser } from '../novaBrowser';
import { buildMcpServer } from './mcp';
import { handleRest } from './rest';
import { checkRequest } from './security';

export interface INovaBridgeServer {
	readonly port: number;
	close(): Promise<void>;
}

/** Ports we try in order after the configured/default one is unavailable. */
function candidatePorts(preferred: number): number[] {
	return [preferred, 0 /* let the OS pick a free ephemeral port */];
}

export async function startBridgeServer(novaBrowser: NovaBrowser, token: string, preferredPort: number): Promise<INovaBridgeServer> {
	const mcpHandler = createMcpHandler(() => buildMcpServer(novaBrowser));
	const mcpNodeHandler = toNodeHandler(mcpHandler);

	const server = http.createServer((req, res) => {
		if (!checkRequest(req, res, token)) {
			return;
		}
		const pathname = (req.url ?? '/').split('?')[0];
		if (pathname === '/mcp') {
			void mcpNodeHandler(req, res);
		} else if (pathname.startsWith('/v1/')) {
			void handleRest(novaBrowser, req, res);
		} else {
			res.writeHead(404, { 'content-type': 'text/plain' });
			res.end('Not found. Use /mcp (MCP) or /v1/* (REST).');
		}
	});

	const port = await listen(server, candidatePorts(preferredPort));

	return {
		port,
		close: () => new Promise<void>((resolve, reject) => {
			mcpHandler.close().catch(() => { /* best effort */ });
			server.close(err => err ? reject(err) : resolve());
		}),
	};
}

function listen(server: http.Server, ports: number[]): Promise<number> {
	return new Promise((resolve, reject) => {
		let index = 0;
		const tryNext = () => {
			const port = ports[index++];
			const onError = (err: NodeJS.ErrnoException) => {
				server.removeListener('listening', onListening);
				if (err.code === 'EADDRINUSE' && index < ports.length) {
					tryNext();
				} else {
					reject(err);
				}
			};
			const onListening = () => {
				server.removeListener('error', onError);
				const address = server.address();
				resolve(typeof address === 'object' && address ? address.port : port);
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, '127.0.0.1');
		};
		tryNext();
	});
}
