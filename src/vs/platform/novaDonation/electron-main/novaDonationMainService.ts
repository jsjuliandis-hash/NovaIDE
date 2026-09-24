/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Main-process side of the donation popup: a frameless window over the IDE with the Nova IDE
 *  donation page (./media/donation.html), which embeds the Live Pix QR code widget. It opens once
 *  per application start (not on window reloads or new windows), unless
 *  `nova.donation.showOnStartup` is off, and on demand with the "Support Nova IDE" command.
 *-------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { isLinux, isWindows } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { INovaDonationService, NovaDonationSettingId } from '../common/novaDonation.js';

export const INovaDonationMainService = createDecorator<INovaDonationMainService>('novaDonation');

export interface INovaDonationMainService extends INovaDonationService {
	readonly _serviceBrand: undefined;
}

/** Wait after the first window is ready, so the popup does not compete with the IDE starting up. */
const STARTUP_DELAY_MS = 3000;

/** Separate session: the page and the embedded Live Pix widget share no cookies or storage with the IDE. */
const DONATION_PARTITION = 'persist:nova-donation';

/** Background of the page, shown until it paints. */
const DONATION_BACKGROUND = '#0e262e';

export class NovaDonationMainService extends Disposable implements INovaDonationMainService {

	declare readonly _serviceBrand: undefined;

	private _window: electron.BrowserWindow | undefined;

	/** True for the web contents of the donation popup. Its links open in the system browser. */
	static isDonationWebContents(contents: electron.WebContents): boolean {
		return contents.session === electron.session.fromPartition(DONATION_PARTITION);
	}

	constructor(
		@IWindowsMainService private readonly _windowsMainService: IWindowsMainService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
		@IProductService private readonly _productService: IProductService,
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
			width: 920,
			height: 740,
			useContentSize: true,
			parent,
			show: false,
			frame: false, // the page draws its own title bar and close button
			center: true,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			backgroundColor: DONATION_BACKGROUND,
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
			// Center over the IDE window rather than the screen, without leaving the screen
			const parentBounds = parent.getBounds();
			const bounds = window.getBounds();
			const workArea = electron.screen.getDisplayMatching(parentBounds).workArea;
			const x = Math.round(parentBounds.x + (parentBounds.width - bounds.width) / 2);
			const y = Math.round(parentBounds.y + (parentBounds.height - bounds.height) / 2);
			window.setPosition(
				Math.min(Math.max(x, workArea.x), workArea.x + Math.max(0, workArea.width - bounds.width)),
				Math.min(Math.max(y, workArea.y), workArea.y + Math.max(0, workArea.height - bounds.height))
			);
		}

		window.once('ready-to-show', () => window.show());
		window.once('closed', () => {
			if (this._window === window) {
				this._window = undefined;
			}
		});

		this._logService.info('[nova donation] showing the donation popup');
		try {
			const page = FileAccess.asFileUri('vs/platform/novaDonation/electron-main/media/donation.html').fsPath;
			await window.loadFile(page, { query: { version: this._productService.version } });
		} catch (error) {
			this._logService.error(`[nova donation] could not load the donation page: ${error instanceof Error ? error.message : String(error)}`);
			window.destroy();
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
