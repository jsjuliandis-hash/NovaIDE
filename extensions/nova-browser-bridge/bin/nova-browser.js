#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser CLI
 *  Talks to the nova-browser-bridge extension's REST surface (/v1/*). Plain Node,
 *  no dependencies, so it works in any integrated terminal without an install step.
 *
 *  Discovery order: NOVA_BROWSER_URL/NOVA_BROWSER_TOKEN env vars (only when set by hand,
 *  e.g. for a bridge on another machine), otherwise ~/.nova-ide/bridge.json, which the
 *  extension rewrites on every activation (so the token is never stale in restored terminals).
 *-------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STATE_PATH = path.join(process.cwd(), '.nova', 'state.json');
const SCREENSHOTS_DIR = path.join(process.cwd(), '.nova', 'screenshots');

function loadConnection() {
	if (process.env.NOVA_BROWSER_URL && process.env.NOVA_BROWSER_TOKEN) {
		return { baseUrl: process.env.NOVA_BROWSER_URL, token: process.env.NOVA_BROWSER_TOKEN };
	}
	const bridgeFile = path.join(os.homedir(), '.nova-ide', 'bridge.json');
	if (fs.existsSync(bridgeFile)) {
		const info = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
		return { baseUrl: info.url, token: info.token };
	}
	throw new Error('Could not find a running Nova Browser Bridge (no NOVA_BROWSER_URL env var and no ~/.nova-ide/bridge.json). Is the Nova IDE open?');
}

function loadState() {
	try {
		return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	} catch {
		return {};
	}
}

function saveState(state) {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Parses `--flag value` / `--flag` style options out of argv, returning the remaining positionals. */
function parseArgs(argv, boolFlags) {
	const options = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const name = arg.slice(2);
			if (boolFlags && boolFlags.includes(name)) {
				options[name] = true;
			} else {
				options[name] = argv[++i];
			}
		} else if (arg === '-o') {
			options.output = argv[++i];
		} else {
			positionals.push(arg);
		}
	}
	return { options, positionals };
}

async function request(conn, method, urlPath, body) {
	const res = await fetch(`${conn.baseUrl}${urlPath}`, {
		method,
		headers: {
			'Authorization': `Bearer ${conn.token}`,
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const contentType = res.headers.get('content-type') || '';
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${text}`);
	}
	if (contentType.includes('image/png')) {
		return Buffer.from(await res.arrayBuffer());
	}
	if (contentType.includes('application/json')) {
		return res.json();
	}
	return res.text();
}

function requirePageId(options, state) {
	const id = options.page || state.currentPageId;
	if (!id) {
		throw new Error('No page id given and no current page recorded. Run "nova-browser open <url>" first, or pass --page <id>.');
	}
	return id;
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const conn = loadConnection();
	const state = loadState();

	switch (command) {
		case undefined:
		case '-h':
		case '--help':
			printHelp();
			return;

		case 'token':
			console.log(conn.token);
			return;

		// JSON headers for MCP clients that ask a helper program for them (Claude Code: headersHelper).
		case 'mcp-headers':
			console.log(JSON.stringify({ Authorization: `Bearer ${conn.token}` }));
			return;

		case 'pages': {
			const pages = await request(conn, 'GET', '/pages');
			console.log(JSON.stringify(pages, null, 2));
			return;
		}

		case 'open': {
			const { options, positionals } = parseArgs(rest, ['reuse', 'background']);
			const url = positionals[0];
			if (!url) { throw new Error('Usage: nova-browser open <url> [--reuse] [--background]'); }
			const { id } = await request(conn, 'POST', '/pages', { url, reuse: !!options.reuse, background: !!options.background });
			state.currentPageId = id;
			saveState(state);
			console.log(`Page ID: ${id}`);
			return;
		}

		case 'nav': {
			const { options, positionals } = parseArgs(rest);
			const url = positionals[0];
			if (!url) { throw new Error('Usage: nova-browser nav <url> [--page <id>]'); }
			await request(conn, 'POST', `/pages/${encodeURIComponent(requirePageId(options, state))}/navigate`, { url });
			console.log('OK');
			return;
		}

		case 'reload': {
			const { options } = parseArgs(rest);
			await request(conn, 'POST', `/pages/${encodeURIComponent(requirePageId(options, state))}/reload`);
			console.log('OK');
			return;
		}

		case 'close': {
			const { options } = parseArgs(rest);
			const id = requirePageId(options, state);
			await request(conn, 'POST', `/pages/${encodeURIComponent(id)}/close`);
			if (state.currentPageId === id) { delete state.currentPageId; saveState(state); }
			console.log('OK');
			return;
		}

		case 'snapshot': {
			const { options } = parseArgs(rest);
			const { summary } = await request(conn, 'GET', `/pages/${encodeURIComponent(requirePageId(options, state))}/snapshot`);
			console.log(summary);
			return;
		}

		case 'screenshot': {
			const { options } = parseArgs(rest, ['full-page']);
			const query = options['full-page'] ? '?fullPage=true' : '';
			const png = await request(conn, 'GET', `/pages/${encodeURIComponent(requirePageId(options, state))}/screenshot${query}`);
			const outPath = options.output || path.join(SCREENSHOTS_DIR, `${Date.now()}.png`);
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, png);
			console.log(outPath);
			return;
		}

		case 'click': {
			const { options, positionals } = parseArgs(rest);
			const target = positionals[0];
			if (!target) { throw new Error('Usage: nova-browser click <target> [--page <id>]'); }
			const { summary } = await request(conn, 'POST', `/pages/${encodeURIComponent(requirePageId(options, state))}/click`, { target });
			console.log(summary);
			return;
		}

		case 'type': {
			const { options, positionals } = parseArgs(rest);
			const [target, text] = positionals;
			if (!target || text === undefined) { throw new Error('Usage: nova-browser type <target> <text> [--page <id>]'); }
			const { summary } = await request(conn, 'POST', `/pages/${encodeURIComponent(requirePageId(options, state))}/type`, { target, text });
			console.log(summary);
			return;
		}

		case 'wait-reload': {
			const { options } = parseArgs(rest);
			const body = {};
			if (options.timeout !== undefined) { body.timeoutMs = Number(options.timeout) * 1000; }
			if (options.lookback !== undefined) { body.lookbackMs = Number(options.lookback) * 1000; }
			const outcome = await request(conn, 'POST', `/pages/${encodeURIComponent(requirePageId(options, state))}/wait-reload`, body);
			console.log(`Reload reason: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`);
			console.log(outcome.summary);
			if (outcome.reason === 'timeout') { process.exitCode = 2; }
			return;
		}

		case 'console': {
			const { options } = parseArgs(rest);
			const query = options.since ? `?sinceMs=${encodeURIComponent(options.since)}` : '';
			const logs = await request(conn, 'GET', `/pages/${encodeURIComponent(requirePageId(options, state))}/console${query}`);
			console.log(JSON.stringify(logs, null, 2));
			return;
		}

		case 'run': {
			const { options, positionals } = parseArgs(rest);
			const file = positionals[0];
			if (!file) { throw new Error('Usage: nova-browser run <file.js|-> [--page <id>]'); }
			const code = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
			const outcome = await request(conn, 'POST', `/pages/${encodeURIComponent(requirePageId(options, state))}/run`, { code });
			console.log(JSON.stringify(outcome, null, 2));
			return;
		}

		case 'dev': {
			const [sub] = rest;
			if (sub === 'status') {
				console.log(JSON.stringify(await request(conn, 'GET', '/devserver'), null, 2));
			} else if (sub === 'restart') {
				console.log(JSON.stringify(await request(conn, 'POST', '/devserver/restart'), null, 2));
			} else {
				throw new Error('Usage: nova-browser dev status|restart');
			}
			return;
		}

		default:
			console.error(`Unknown command: ${command}\n`);
			printHelp();
			process.exitCode = 1;
	}
}

function printHelp() {
	console.log(`nova-browser — control the Nova IDE Integrated Browser from the terminal

Usage:
  nova-browser pages
  nova-browser open <url> [--reuse] [--background]
  nova-browser nav <url> [--page <id>]
  nova-browser reload [--page <id>]
  nova-browser close [--page <id>]
  nova-browser snapshot [--page <id>]
  nova-browser screenshot [--page <id>] [-o <file>] [--full-page]
  nova-browser click <target> [--page <id>]
  nova-browser type <target> <text> [--page <id>]
  nova-browser wait-reload [--page <id>] [--timeout <s>] [--lookback <s>]
                             after editing code: wait for HMR/reload, print the new snapshot
  nova-browser console [--page <id>] [--since <ms>]
  nova-browser run <file.js|-> [--page <id>]
  nova-browser dev status
  nova-browser dev restart
  nova-browser token          print the bridge token (for MCP clients that need it in an env var)
  nova-browser mcp-headers    print the MCP Authorization header as JSON

Most commands default to the page opened by the last "nova-browser open" in this
directory (tracked in .nova/state.json). Pass --page <id> to target another one.`);
}

main().catch(err => {
	console.error(`Error: ${err.message}`);
	process.exitCode = 1;
});
