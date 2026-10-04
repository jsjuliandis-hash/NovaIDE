/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Icon of the Integrated Browser: the yellow bolt of the Nova logo in a ring. It falls back to the
 *  globe glyph; the Nova look comes from src/vs/workbench/browser/media/novaBrowserIcon.css.
 *  Web pages without a favicon (history, page lists) keep the globe: it stands for the site there.
 *-------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { localize } from '../../nls.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';

export const novaBrowserIcon = registerIcon('nova-browser', Codicon.globe, localize('nova.browserIcon', "Icon of the Integrated Browser."));
