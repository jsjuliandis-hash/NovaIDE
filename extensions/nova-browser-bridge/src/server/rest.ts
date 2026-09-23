/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Small JSON REST surface under /v1/*, used by the `nova-browser` CLI. This
 *  exists alongside the MCP endpoint because a plain shell script talking raw
 *  JSON over HTTP is far simpler than embedding an MCP client in bin/nova-browser.js.
 *-------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { NovaBrowser } from '../novaBrowser';
import { ensureEvaluateAllowed } from './security';

type Handler = (novaBrowser: NovaBrowser, params: RegExpExecArray, body: unknown, query: URLSearchParams) => Promise<{ status: number; json?: unknown; png?: Uint8Array }>;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
	{
		method: 'GET', pattern: /^\/v1\/pages$/,
		handler: async (nb) => ({ status: 200, json: nb.listPages() }),
	},
	{
		method: 'POST', pattern: /^\/v1\/pages$/,
		handler: async (nb, _p, body) => {
			const { url, reuse, background } = asRecord(body);
			const id = await nb.open(String(url), { reuse: !!reuse, background: !!background });
			return { status: 200, json: { id } };
		},
	},
	{
		method: 'POST', pattern: /^\/v1\/pages\/([^/]+)\/navigate$/,
		handler: async (nb, p, body) => {
			await nb.navigate(p[1], String(asRecord(body).url));
			return { status: 200, json: { ok: true } };
		},
	},
	{
		method: 'POST', pattern: /^\/v1\/pages\/([^/]+)\/reload$/,
		handler: async (nb, p) => { await nb.reload(p[1]); return { status: 200, json: { ok: true } }; },
	},
	{
		method: 'POST', pattern: /^\/v1\/pages\/([^/]+)\/close$/,
		handler: async (nb, p) => { await nb.close(p[1]); return { status: 200, json: { ok: true } }; },
	},
	{
		method: 'GET', pattern: /^\/v1\/pages\/([^/]+)\/snapshot$/,
		handler: async (nb, p) => ({ status: 200, json: { summary: await nb.snapshot(p[1]) } }),
	},
	{
		method: 'GET', pattern: /^\/v1\/pages\/([^/]+)\/screenshot$/,
		handler: async (nb, p, _body, query) => ({ status: 200, png: await nb.screenshot(p[1], { fullPage: query.get('fullPage') === 'true' }) }),
	},
	{
		method: 'POST', pattern: /^\/v1\/pages\/([^/]+)\/click$/,
		handler: async (nb, p, body) => ({ status: 200, json: { summary: await nb.click(p[1], String(asRecord(body).target)) } }),
	},
	{
		method: 'POST', pattern: /^\/v1\/pages\/([^/]+)\/type$/,
		handler: async (nb, p, body) => {
			const { target, text } = asRecord(body);
			return { status: 200, json: { summary: await nb.type(p[1], String(target), String(text)) } };
		},
	},
	{
		method: 'GET', pattern: /^\/v1\/pages\/([^/]+)\/console$/,
		handler: async (nb, p, _body, query) => {
			const sinceMs = query.get('sinceMs');
			return { status: 200, json: nb.consoleLogs(p[1], sinceMs ? Number(sinceMs) : undefined) };
		},
	},
	{
		method: 'POST', pattern: /^\/v1\/pages\/([^/]+)\/run$/,
		handler: async (nb, p, body) => {
			await ensureEvaluateAllowed();
			return { status: 200, json: await nb.runPlaywright(p[1], String(asRecord(body).code)) };
		},
	},
];

export async function handleRest(novaBrowser: NovaBrowser, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://internal');
	const route = routes.find(r => r.method === req.method && r.pattern.test(url.pathname));
	if (!route) {
		writeJson(res, 404, { error: `No such route: ${req.method} ${url.pathname}` });
		return;
	}

	const match = route.pattern.exec(url.pathname)!;

	try {
		const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
		const result = await route.handler(novaBrowser, match, body, url.searchParams);
		if (result.png) {
			res.writeHead(result.status, { 'content-type': 'image/png', 'content-length': result.png.byteLength });
			res.end(Buffer.from(result.png));
		} else {
			writeJson(res, result.status, result.json);
		}
	} catch (error) {
		writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

function asRecord(body: unknown): Record<string, unknown> {
	return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

function writeJson(res: http.ServerResponse, status: number, json: unknown): void {
	const payload = JSON.stringify(json ?? {});
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
	res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			if (chunks.length === 0) {
				return resolve(undefined);
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				reject(new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
		req.on('error', reject);
	});
}
