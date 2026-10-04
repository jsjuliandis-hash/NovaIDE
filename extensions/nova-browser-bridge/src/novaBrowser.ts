/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Thin "novaBrowser" wrapper around VS Code's existing `browser` proposed API
 *  (window.openBrowserTab / window.browserTabs / BrowserTab.startCDPSession).
 *
 *  This module intentionally does NOT talk to any VS Code core service directly.
 *  Everything it does is achievable by any extension that declares
 *  `"enabledApiProposals": ["browser"]` — see docs/browser-architecture.md (Fase 3)
 *  for why this replaced the originally-planned `vscode.novaBrowser` core API:
 *  the same Chromium view the user sees is reachable over a real CDP session
 *  (`tab.startCDPSession()`), so Playwright can attach to it exactly like the
 *  internal PlaywrightService does, just from the extension host instead of the
 *  shared process.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
// playwright-core has no bundled browsers; we only ever attach to an existing
// Chromium view via connectOverCDP, never launch one.
import type { Browser, ConnectOverCDPTransport, Locator, Page } from 'playwright-core';
import { markActiveEditorOpenedByAgent } from './agentTabs';
import { FIELD_TIMEOUT_MS, fillFormFields, maskSecrets, PASSWORD_VALUES_SCRIPT, type INovaFillFormResult, type INovaFormField } from './formFill';
import { describeLimit, limitLines } from './server/textLimit';

/** Result shape mirroring the internal IInvokeFunctionResult, redefined locally since
 * extensions cannot import from `src/vs/platform/...`. */
export interface INovaRunResult {
	result?: unknown;
	error?: string;
	summary: string;
}

export interface INovaPageInfo {
	id: string;
	url: string;
	title: string;
	active: boolean;
}

export interface INovaOpenOptions {
	/** Reuse an existing page whose URL already matches, if one is found. */
	reuse?: boolean;
	/** Open without stealing focus/activating the tab. */
	background?: boolean;
}

export interface INovaConsoleEntry {
	level: string;
	text: string;
	ts: number;
}

/** A page of console entries; pass `nextCursor` back as `cursor` to get only what came after. */
export interface INovaConsolePage {
	entries: INovaConsoleEntry[];
	nextCursor: number;
	/** True when more entries after this page were held back by `limit`. */
	more: boolean;
	/** True when entries before `cursor` were already dropped from the buffer (it keeps the last 500). */
	dropped: boolean;
}

export interface INovaSnapshotOptions {
	/** Snapshot only the element matching this Playwright selector instead of the whole page. */
	rootSelector?: string;
	/** Return at most this many characters of the tree, cut on line boundaries. */
	maxChars?: number;
	/** First line of the tree to return (1-based), to continue a partial snapshot. */
	startLine?: number;
}

export interface INovaPageUpdate {
	reason: 'load' | 'hmr';
	/** The console line that signalled an HMR update, or the URL that finished loading. */
	detail: string;
	ts: number;
}

export interface INovaReloadResult {
	reason: INovaPageUpdate['reason'] | 'timeout';
	detail?: string;
	summary: string;
}

const CONSOLE_BUFFER_LIMIT = 500;
const UPDATE_HISTORY_LIMIT = 20;
/** How long to wait for network activity to settle after an action before snapshotting. */
const SETTLE_TIMEOUT_MS = 2_000;
/** Console lines printed by common dev servers' HMR clients once an update has been applied. */
const HMR_APPLIED_PATTERN = /\[vite\] hot updated|\[HMR\] (Updated modules|App is up to date)|\[Fast Refresh\] done|\[webpack-dev-server\] .*(Hot Module Replacement|App updated)/i;

/** Per-page state kept alive for as long as the underlying BrowserTab exists. */
interface IPageEntry {
	readonly id: string;
	readonly tab: vscode.BrowserTab;
	/** Lazily created on first automation call (snapshot/click/etc). */
	connection?: Promise<{ browser: Browser; page: Page }>;
	cdpSession?: vscode.BrowserCDPSession;
	consoleLog: INovaConsoleEntry[];
	/** Sequence number of each entry of `consoleLog` (same index), for cursor paging. */
	consoleSeq: number[];
	nextConsoleSeq: number;
	/** Full loads and HMR updates seen since Playwright attached, newest last. */
	updates: INovaPageUpdate[];
	readonly onDidUpdate: vscode.EventEmitter<INovaPageUpdate>;
}

/**
 * Owns the mapping between our own stable string ids and the `vscode.BrowserTab`
 * instances handed out by the `browser` proposal (which does not expose an id
 * itself), plus the lazy Playwright connection used for automation calls.
 */
export class NovaBrowser implements vscode.Disposable {
	private readonly _pagesByTab = new WeakMap<vscode.BrowserTab, IPageEntry>();
	private readonly _pagesById = new Map<string, IPageEntry>();
	private _nextId = 1;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor() {
		// Pick up pages opened by the user or by other extensions too, not just
		// the ones we open ourselves, matching the plan's "list every open page".
		for (const tab of vscode.window.browserTabs) {
			this._track(tab);
		}
		this._disposables.push(
			vscode.window.onDidOpenBrowserTab(tab => this._track(tab)),
			vscode.window.onDidCloseBrowserTab(tab => this._untrack(tab)),
		);
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose();
		}
		for (const entry of this._pagesById.values()) {
			entry.cdpSession?.close();
			entry.onDidUpdate.dispose();
		}
		this._pagesById.clear();
	}

	// #region Page lifecycle

	listPages(): INovaPageInfo[] {
		const active = vscode.window.activeBrowserTab;
		return [...this._pagesById.values()].map(entry => ({
			id: entry.id,
			url: entry.tab.url,
			title: entry.tab.title,
			active: entry.tab === active,
		}));
	}

	async open(url: string, opts?: INovaOpenOptions): Promise<string> {
		assertHostAllowed(url);

		if (opts?.reuse) {
			const existing = [...this._pagesById.values()].find(entry => sameHost(entry.tab.url, url));
			if (existing) {
				return existing.id;
			}
		}

		const tab = await vscode.window.openBrowserTab(url, { background: opts?.background });
		// onDidOpenBrowserTab may not have fired synchronously yet in all cases;
		// _track is idempotent so calling it again here is safe.
		const entry = this._track(tab);
		if (!opts?.background) {
			markActiveEditorOpenedByAgent(); // the new page is the active editor now
		}
		return entry.id;
	}

	async close(pageId: string): Promise<void> {
		const entry = this._require(pageId);
		await entry.tab.close();
	}

	async navigate(pageId: string, url: string): Promise<void> {
		assertHostAllowed(url);
		const { page } = await this._connect(pageId);
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await settle(page);
	}

	async reload(pageId: string): Promise<void> {
		const { page } = await this._connect(pageId);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await settle(page);
	}

	/**
	 * A fresh browser-level CDP session over one page's view (the given page, else
	 * the active one), for external CDP clients such as `chromium.connectOverCDP`.
	 */
	async startExternalCDPSession(pageId?: string): Promise<vscode.BrowserCDPSession> {
		const tab = pageId ? this._require(pageId).tab : (vscode.window.activeBrowserTab ?? [...this._pagesById.values()][0]?.tab);
		if (!tab) {
			throw new Error('No Integrated Browser page is open. Open one first (browser_open / nova-browser open).');
		}
		return tab.startCDPSession();
	}

	/** Attaches Playwright now, so reloads/HMR updates are recorded before anyone asks for them. */
	async attach(pageId: string): Promise<void> {
		await this._connect(pageId);
	}

	/**
	 * Resolves once the page has picked up a code change: a full load or an HMR
	 * update. An update seen within the last `lookbackMs` also counts, since the
	 * dev server often applies it before the caller gets around to asking.
	 */
	async waitForReload(pageId: string, opts?: { timeoutMs?: number; lookbackMs?: number; includeSnapshot?: boolean }): Promise<INovaReloadResult> {
		const entry = this._require(pageId);
		const { page } = await this._connect(pageId);
		const since = Date.now() - (opts?.lookbackMs ?? 3_000);
		let update: INovaPageUpdate | undefined = [...entry.updates].reverse().find(u => u.ts >= since);
		if (!update) {
			update = await new Promise<INovaPageUpdate | undefined>(resolve => {
				const timer = setTimeout(() => {
					sub.dispose();
					resolve(undefined);
				}, opts?.timeoutMs ?? 30_000);
				const sub = entry.onDidUpdate.event(u => {
					clearTimeout(timer);
					sub.dispose();
					resolve(u);
				});
			});
		}
		await settle(page);
		const summary = opts?.includeSnapshot === false ? await this.pageHeader(page) : await this.snapshot(pageId);
		return { reason: update?.reason ?? 'timeout', detail: update?.detail, summary };
	}

	// #endregion

	// #region Automation (all via Playwright over the tab's own CDP session)

	/**
	 * Title, URL and ARIA tree of the page. Without options the whole page is returned, as before;
	 * `rootSelector` narrows it to one region and `maxChars`/`startLine` return part of it.
	 */
	async snapshot(pageId: string, opts?: INovaSnapshotOptions): Promise<string> {
		this._require(pageId); // throws a clear error if the page id is unknown
		const { page } = await this._connect(pageId);
		const [rawSnapshot, header, secrets] = await Promise.all([
			// A missing region is an error worth reporting; the whole page falls back to <empty> as before.
			opts?.rootSelector ? this._locator(page, opts.rootSelector).ariaSnapshot({ timeout: FIELD_TIMEOUT_MS }) : page.ariaSnapshot().catch(() => ''),
			this.pageHeader(page),
			page.evaluate(PASSWORD_VALUES_SCRIPT).then(values => values as string[], () => []),
		]);
		// NOVA: the ARIA tree shows the value of password fields too; never hand a password to the model.
		const snapshot = maskSecrets(rawSnapshot, secrets);
		const lines = [header, opts?.rootSelector ? `Snapshot of ${opts.rootSelector}:` : 'Snapshot:'];
		if (opts?.maxChars === undefined && opts?.startLine === undefined) {
			lines.push(snapshot || '<empty>');
		} else {
			const limited = limitLines(snapshot, opts);
			lines.push(limited.text || '<empty>');
			const footer = describeLimit(limited, 'call browser_snapshot again with startLine: {next} (and the same rootSelector), or narrow it with rootSelector.');
			if (footer) {
				lines.push(footer);
			}
		}
		return lines.join('\n');
	}

	/** Just the title and URL, for results that do not need the tree. */
	private async pageHeader(page: Page): Promise<string> {
		const title = await page.title().catch(() => '');
		return `Page Title: ${title}\nURL: ${page.url()}`;
	}

	async screenshot(pageId: string, opts?: { fullPage?: boolean }): Promise<Uint8Array> {
		const { page } = await this._connect(pageId);
		const buffer = await page.screenshot({ type: 'png', fullPage: !!opts?.fullPage });
		return new Uint8Array(buffer);
	}

	async click(pageId: string, target: string): Promise<string> {
		const { page } = await this._connect(pageId);
		await this._locator(page, target).click();
		await settle(page);
		return this.snapshot(pageId);
	}

	async type(pageId: string, target: string, text: string): Promise<string> {
		const { page } = await this._connect(pageId);
		await this._locator(page, target).fill(text);
		await settle(page);
		return this.snapshot(pageId);
	}

	/**
	 * Fills several form fields with one final snapshot, instead of one browser_type (and one
	 * full snapshot) per field. See fillFormFields for the rules (no submit, stop at first error).
	 */
	async fillForm(pageId: string, fields: readonly INovaFormField[], opts?: { includeSnapshot?: boolean }): Promise<INovaFillFormResult> {
		const { page } = await this._connect(pageId);
		const result = await fillFormFields(target => this._locator(page, target), fields);
		if (result.filled > 0) {
			await settle(page);
		}
		if (opts?.includeSnapshot !== false) {
			result.summary = await this.snapshot(pageId);
		}
		return result;
	}

	async runPlaywright(pageId: string, code: string, opts?: { includeSnapshot?: boolean }): Promise<INovaRunResult> {
		const { page } = await this._connect(pageId);
		// NOVA: a query such as "return page.url()" already answers the question; the whole tree on top of it only costs context.
		const summarize = () => opts?.includeSnapshot === false ? this.pageHeader(page) : this.snapshot(pageId);
		try {
			const fn = new Function(`return (${code})`)() as (page: Page) => unknown;
			const result = await fn(page);
			return { result, summary: await summarize() };
		} catch (err) {
			return {
				error: err instanceof Error ? err.message : String(err),
				summary: await summarize().catch(() => ''),
			};
		}
	}

	consoleLogs(pageId: string, sinceMs?: number): INovaConsoleEntry[] {
		const entry = this._require(pageId);
		if (sinceMs === undefined) {
			return entry.consoleLog.slice();
		}
		return entry.consoleLog.filter(e => e.ts >= sinceMs);
	}

	/**
	 * Console entries after `cursor` (a sequence number, so entries with the same timestamp are
	 * neither repeated nor lost), at most `limit` of them, oldest first.
	 */
	consoleLogsPage(pageId: string, opts: { cursor?: number; limit?: number; sinceMs?: number }): INovaConsolePage {
		const entry = this._require(pageId);
		const cursor = opts.cursor ?? 0;
		const matching: number[] = [];
		entry.consoleLog.forEach((log, index) => {
			if (entry.consoleSeq[index] > cursor && (opts.sinceMs === undefined || log.ts >= opts.sinceMs)) {
				matching.push(index);
			}
		});
		const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : matching.length;
		const selected = matching.slice(0, limit);
		const lastSeq = selected.length ? entry.consoleSeq[selected[selected.length - 1]] : Math.max(cursor, entry.nextConsoleSeq - 1);
		return {
			entries: selected.map(index => entry.consoleLog[index]),
			nextCursor: lastSeq,
			more: matching.length > selected.length,
			dropped: opts.cursor !== undefined && entry.consoleSeq.length > 0 && entry.consoleSeq[0] > cursor + 1,
		};
	}

	// #endregion

	// #region Internal: tab tracking

	private _track(tab: vscode.BrowserTab): IPageEntry {
		const existing = this._pagesByTab.get(tab);
		if (existing) {
			return existing;
		}
		const entry: IPageEntry = { id: `page-${this._nextId++}`, tab, consoleLog: [], consoleSeq: [], nextConsoleSeq: 1, updates: [], onDidUpdate: new vscode.EventEmitter<INovaPageUpdate>() };
		this._pagesByTab.set(tab, entry);
		this._pagesById.set(entry.id, entry);
		return entry;
	}

	private _untrack(tab: vscode.BrowserTab): void {
		const entry = this._pagesByTab.get(tab);
		if (!entry) {
			return;
		}
		entry.cdpSession?.close();
		entry.onDidUpdate.dispose();
		this._pagesById.delete(entry.id);
		this._pagesByTab.delete(tab);
	}

	private _require(pageId: string): IPageEntry {
		const entry = this._pagesById.get(pageId);
		if (!entry) {
			throw new Error(`Nova browser page not found: ${pageId}. Call listPages() or open() first.`);
		}
		return entry;
	}

	// #endregion

	// #region Internal: lazy Playwright connection over the tab's CDP session

	/**
	 * Connects Playwright to this page's own WebContentsView the first time it's
	 * needed, reusing the connection afterwards. Mirrors, at the extension-host
	 * level, exactly what `platform/browserView/node/playwrightService.ts` does
	 * in the shared process: a `connectOverCDP` transport whose `send`/`onmessage`
	 * are backed by a message channel — here, `vscode.BrowserCDPSession` instead
	 * of the internal `IBrowserViewGroupRemoteService`.
	 */
	private _connect(pageId: string): Promise<{ browser: Browser; page: Page }> {
		const entry = this._require(pageId);
		if (!entry.connection) {
			entry.connection = this._connectNow(entry);
		}
		return entry.connection;
	}

	private async _connectNow(entry: IPageEntry): Promise<{ browser: Browser; page: Page }> {
		const playwright = await import('playwright-core');
		const cdpSession = await entry.tab.startCDPSession();
		entry.cdpSession = cdpSession;

		const disposables: vscode.Disposable[] = [];
		const transport: ConnectOverCDPTransport = {
			close() {
				for (const d of disposables) {
					d.dispose();
				}
			},
			send: (message) => {
				void cdpSession.sendMessage(message);
			},
		};
		disposables.push(
			cdpSession.onDidReceiveMessage(message => transport.onmessage?.(message as never)),
			cdpSession.onDidClose(() => transport.onclose?.()),
		);

		const browser = await playwright.chromium.connectOverCDP(transport);
		const page = await this._waitForPage(browser);

		page.on('console', message => {
			const text = message.text();
			this._recordConsole(entry, message.type(), text);
			if (HMR_APPLIED_PATTERN.test(text)) {
				this._recordUpdate(entry, 'hmr', text);
			}
		});
		page.on('pageerror', error => this._recordConsole(entry, 'error', error.stack ?? error.message));
		page.on('load', () => this._recordUpdate(entry, 'load', page.url()));

		browser.on('disconnected', () => {
			entry.connection = undefined;
		});

		return { browser, page };
	}

	/**
	 * A `startCDPSession()` group is scoped to exactly one browser view, so
	 * there is exactly one target/page to discover — just not necessarily
	 * synchronously available the instant `connectOverCDP` resolves.
	 */
	private async _waitForPage(browser: Browser): Promise<Page> {
		for (const context of browser.contexts()) {
			const [page] = context.pages();
			if (page) {
				return page;
			}
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timed out waiting for the browser page to become available.')), 10_000);
			browser.on('disconnected', () => {
				clearTimeout(timeout);
				reject(new Error('Browser disconnected before its page became available.'));
			});
			const onContext = (context: import('playwright-core').BrowserContext) => {
				context.once('page', page => {
					clearTimeout(timeout);
					resolve(page);
				});
			};
			browser.contexts().forEach(onContext);
			browser.on('context', onContext as never);
		});
	}

	private _recordConsole(entry: IPageEntry, level: string, text: string): void {
		entry.consoleLog.push({ level, text, ts: Date.now() });
		entry.consoleSeq.push(entry.nextConsoleSeq++);
		if (entry.consoleLog.length > CONSOLE_BUFFER_LIMIT) {
			entry.consoleLog.splice(0, entry.consoleLog.length - CONSOLE_BUFFER_LIMIT);
			entry.consoleSeq.splice(0, entry.consoleSeq.length - CONSOLE_BUFFER_LIMIT);
		}
	}

	private _recordUpdate(entry: IPageEntry, reason: INovaPageUpdate['reason'], detail: string): void {
		const update: INovaPageUpdate = { reason, detail, ts: Date.now() };
		entry.updates.push(update);
		if (entry.updates.length > UPDATE_HISTORY_LIMIT) {
			entry.updates.splice(0, entry.updates.length - UPDATE_HISTORY_LIMIT);
		}
		entry.onDidUpdate.fire(update);
	}

	/** Resolves a target: `label=<text>`, `placeholder=<text>`, `aria-ref=...` refs from a snapshot, or a raw Playwright selector. */
	private _locator(page: Page, target: string): Locator {
		if (target.startsWith('label=')) {
			return page.getByLabel(target.slice('label='.length));
		}
		if (target.startsWith('placeholder=')) {
			return page.getByPlaceholder(target.slice('placeholder='.length));
		}
		return page.locator(target);
	}

	// #endregion
}

/**
 * Enforces `nova.browserBridge.allowedHosts` / `allowExternalHosts` on any URL an
 * external caller asks the bridge to open or navigate to. Internal, user-driven
 * navigation inside the IDE is untouched — this only gates the bridge's own API.
 */
function assertHostAllowed(url: string): void {
	const config = vscode.workspace.getConfiguration('nova.browserBridge');
	if (config.get<boolean>('allowExternalHosts', true)) {
		return;
	}
	const allowed = config.get<string[]>('allowedHosts', ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}
	// data:/about:/blob: URLs carry no network host to restrict; they're inline
	// content, not a request to some remote origin, so the allowlist doesn't apply.
	if (hostname === '') {
		return;
	}
	if (!allowed.includes(hostname)) {
		throw new Error(
			`Host "${hostname}" is not in nova.browserBridge.allowedHosts (${allowed.join(', ')}). ` +
			`Enable nova.browserBridge.allowExternalHosts to allow any host.`
		);
	}
}

/**
 * Gives in-flight requests (and, after HMR, the framework's re-render) a moment
 * to finish so the snapshot reflects the result of the action. A page that never
 * goes idle (polling, long-lived streams) just costs the timeout.
 */
async function settle(page: Page): Promise<void> {
	await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => { });
	await new Promise(resolve => setTimeout(resolve, 100));
}

function sameHost(a: string, b: string): boolean {
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		return ua.host === ub.host;
	} catch {
		return a === b;
	}
}
