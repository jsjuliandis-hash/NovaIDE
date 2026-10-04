/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Single local HTTP server (127.0.0.1 only) fronting two surfaces on top of the
 *  same NovaBrowser instance:
 *    - POST /mcp        Streamable HTTP MCP endpoint (Claude Code, Gemini CLI, Codex, ...)
 *      POST /mcp/code, /mcp/browser, /mcp/full: the same server with a smaller tool catalog
 *    - /v1/*            Plain JSON REST, used by bin/nova-browser.js
 *  Every request passes the same security.checkRequest gate first.
 *-------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { DevServerManager } from '../devServer/devServerManager';
import { NovaBrowser } from '../novaBrowser';
import { buildMcpServer, type McpToolCallRecord } from './mcp';
import { handleRest } from './rest';
import { checkRequest } from './security';
import { profileFromPath, type ToolProfile } from './toolProfiles';

export interface INovaBridgeServer {
	readonly port: number;
	close(): Promise<void>;
}

/** Ports we try in order after the configured/default one is unavailable. */
export function candidatePorts(preferred: number): number[] {
	return [preferred, 0 /* let the OS pick a free ephemeral port */];
}

const PROFILES: readonly ToolProfile[] = ['code', 'browser', 'full'];

export async function startBridgeServer(novaBrowser: NovaBrowser, devServerManager: DevServerManager, token: string, preferredPort: number, onAuthenticatedRequest: () => void, onToolCall?: (record: McpToolCallRecord) => void): Promise<INovaBridgeServer> {
	// One handler per profile: each builds a fresh server per request with its own fixed catalog, so tools/list and tools/call always agree.
	const mcpHandlers = new Map<ToolProfile, McpHttpHandler>(PROFILES.map(profile => [profile, createMcpHandler(() => buildMcpServer(novaBrowser, devServerManager, profile, onToolCall))]));
	const mcpNodeHandlers = new Map([...mcpHandlers].map(([profile, handler]) => [profile, toNodeHandler(handler)]));

	const server = http.createServer((req, res) => {
		if (!checkRequest(req, res, token)) {
			return;
		}
		onAuthenticatedRequest();
		const pathname = (req.url ?? '/').split('?')[0];
		const profile = profileFromPath(pathname);
		if (profile) {
			void mcpNodeHandlers.get(profile)!(req, res);
		} else if (pathname.startsWith('/v1/')) {
			void handleRest(novaBrowser, devServerManager, req, res);
		} else {
			res.writeHead(404, { 'content-type': 'text/plain' });
			res.end('Not found. Use /mcp (MCP; /mcp/code and /mcp/browser for smaller catalogs) or /v1/* (REST).');
		}
	});

	const port = await listen(server, candidatePorts(preferredPort));

	return {
		port,
		close: () => new Promise<void>((resolve, reject) => {
			for (const handler of mcpHandlers.values()) {
				handler.close().catch(() => { /* best effort */ });
			}
			server.close(err => err ? reject(err) : resolve());
		}),
	};
}

export function listen(server: http.Server, ports: number[]): Promise<number> {
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
