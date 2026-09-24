/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Main-process side of the donation popup: a small window over the IDE that shows the Live Pix
 *  donation widget. It opens once per application start (not on window reloads or new windows),
 *  unless `nova.donation.showOnStartup` is off, and on demand with the "Support Nova IDE" command.
 *-------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { isLinux, isWindows } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { INovaDonationService, NOVA_DONATION_HOST_SUFFIX, NOVA_DONATION_URL, NovaDonationSettingId } from '../common/novaDonation.js';

export const INovaDonationMainService = createDecorator<INovaDonationMainService>('novaDonation');

export interface INovaDonationMainService extends INovaDonationService {
	readonly _serviceBrand: undefined;
}

/** Wait after the first window is ready, so the popup does not compete with the IDE starting up. */
const STARTUP_DELAY_MS = 3000;

/** Separate session: the remote page shares no cookies or storage with the IDE. */
const DONATION_PARTITION = 'persist:nova-donation';

export class NovaDonationMainService extends Disposable implements INovaDonationMainService {

	declare readonly _serviceBrand: undefined;

	private _window: electron.BrowserWindow | undefined;

	/** True for the web contents of the donation popup (used to allow its navigation within Live Pix). */
	static isDonationWebContents(contents: electron.WebContents): boolean {
		return contents.session === electron.session.fromPartition(DONATION_PARTITION);
	}

	/** Whether the popup may navigate to `url` in place. Other URLs open in the system browser. */
	static isAllowedNavigation(url: string): boolean {
		try {
			const { protocol, hostname } = new URL(url);
			return protocol === 'https:' && (hostname === NOVA_DONATION_HOST_SUFFIX || hostname.endsWith(`.${NOVA_DONATION_HOST_SUFFIX}`));
		} catch {
			return false;
		}
	}

	constructor(
		@IWindowsMainService private readonly _windowsMainService: IWindowsMainService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
		@IThemeMainService private readonly _themeMainService: IThemeMainService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(Event.once(this._windowsMainService.onDidSignalReadyWindow)(() => {
			if (!this._shouldShowOnStartup()) {
				return;
			}
			const handle = setTimeout(() => this.show(), STARTUP_DELAY_MS);
			this._register(toDisposable(() => clearTimeout(handle)));
		}));
		this._register(toDisposable(() => this._window?.destroy()));
	}

	private _shouldShowOnStartup(): boolean {
		if (this._environmentMainService.extensionTestsLocationURI || this._environmentMainService.args['enable-smoke-test-driver']) {
			return false; // automated runs
		}
		return this._configurationService.getValue<boolean>(NovaDonationSettingId.ShowOnStartup) !== false;
	}

	async show(): Promise<void> {
		if (this._window && !this._window.isDestroyed()) {
			this._window.show();
			this._window.focus();
			return;
		}

		const parent = this._windowsMainService.getFocusedWindow()?.win ?? this._windowsMainService.getLastActiveWindow()?.win ?? undefined;
		const window = this._window = new electron.BrowserWindow({
			title: localize('nova.donation.title', "Support Nova IDE"),
			// The Live Pix widget is a QR code card of about 240×340 px
			width: 360,
			height: 460,
			useContentSize: true,
			parent,
			show: false,
			center: true,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			autoHideMenuBar: true,
			backgroundColor: this._themeMainService.getBackgroundColor(),
			icon: this._windowIcon(),
			webPreferences: {
				partition: DONATION_PARTITION,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				spellcheck: false,
				autoplayPolicy: 'user-gesture-required',
			},
		});
		window.removeMenu();

		if (parent) {
			// Center over the IDE window rather than the screen
			const parentBounds = parent.getBounds();
			const bounds = window.getBounds();
			window.setPosition(
				Math.round(parentBounds.x + (parentBounds.width - bounds.width) / 2),
				Math.round(parentBounds.y + Math.max(0, (parentBounds.height - bounds.height) / 2))
			);
		}

		// Keep our title instead of the page's
		window.on('page-title-updated', e => e.preventDefault());
		window.once('ready-to-show', () => window.show());
		window.once('closed', () => {
			if (this._window === window) {
				this._window = undefined;
			}
		});
		window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
			if (isMainFrame) {
				this._logService.warn(`[nova donation] could not load the donation page (${errorCode} ${errorDescription}), closing the popup`);
				window.destroy();
			}
		});

		this._logService.info('[nova donation] showing the donation popup');
		try {
			await window.loadURL(NOVA_DONATION_URL);
		} catch (error) {
			// Reported through did-fail-load as well
			this._logService.trace(`[nova donation] loadURL failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _windowIcon(): string | undefined {
		if (isLinux) {
			return join(this._environmentMainService.appRoot, 'resources/linux/code.png');
		}
		if (isWindows && !this._environmentMainService.isBuilt) {
			return join(this._environmentMainService.appRoot, 'resources/win32/code_150x150.png');
		}
		return undefined;
	}
}
