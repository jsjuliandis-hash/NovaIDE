/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Local-server URL detection in terminal output, ported from
 *  src/vs/workbench/contrib/remote/browser/urlFinder.ts (extensions can't import
 *  VS Code core modules, so the regexes and normalization logic are copied
 *  verbatim rather than reused).
 *-------------------------------------------------------------------------------------------*/

/**
 * Matches URLs like:
 *   http://localhost:3000/      - most frameworks
 *   https://127.0.0.1:5001/     - ASP.NET
 *   http://:8080                - Beego Golang
 *   http://0.0.0.0:4000         - Elixir Phoenix
 */
const localUrlRegex = /\b\w{0,20}(?::\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{2,5})[\w\-.~:/?#[\]@!$&()*+,;=]*/gim;
const extractPortRegex = /(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})/;
/** https://github.com/microsoft/vscode-remote-release/issues/3949 */
const localPythonServerRegex = /HTTP\son\s(127\.0\.0\.1|0\.0\.0\.0)\sport\s(\d+)/;

/** Strips ANSI/CSI/OSC terminal escape sequences before matching. */
function stripAnsi(data: string): string {
	return data.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

export interface IDetectedUrl {
	host: string;
	port: number;
}

/**
 * Scans a chunk of raw terminal output for the first local dev-server URL,
 * matching the same patterns (and node-inspector exclusion) as the core
 * Integrated Terminal's own detector.
 */
export function findLocalUrl(rawData: string): IDetectedUrl | undefined {
	const data = stripAnsi(rawData);
	const matches = data.match(localUrlRegex);
	if (matches) {
		for (const match of matches) {
			let parsed: URL | undefined;
			try {
				parsed = new URL(match);
			} catch {
				continue;
			}
			const portMatch = match.match(extractPortRegex);
			const port = Number.parseFloat(parsed.port || portMatch?.[2] || 'NaN');
			if (Number.isInteger(port) && port > 0 && port <= 65535) {
				let host = parsed.hostname;
				if (host !== '0.0.0.0' && host !== '127.0.0.1') {
					host = 'localhost';
				}
				// Exclude the Node.js inspector's own banner, unless it's using the default port.
				if (port !== 9229 && data.startsWith('Debugger listening on')) {
					continue;
				}
				return { host, port };
			}
		}
	}

	const pythonMatch = data.match(localPythonServerRegex);
	if (pythonMatch) {
		return { host: pythonMatch[1], port: Number(pythonMatch[2]) };
	}

	return undefined;
}
