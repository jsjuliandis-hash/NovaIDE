/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Remembers which editor tabs an AI agent opened, so the tab strip can show the blue dot
 *  (the same one the chat tabs show for "finished") until the user sees the tab.
 *-------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../editor/common/editorService.js';

export const INovaAgentTabsService = createDecorator<INovaAgentTabsService>('novaAgentTabsService');

export interface INovaAgentTabsService {
	readonly _serviceBrand: undefined;

	/** Fires with the editor whose mark changed. */
	readonly onDidChange: Event<EditorInput>;

	isMarked(editor: EditorInput): boolean;

	/** Marks an editor an agent just opened. */
	mark(editor: EditorInput): void;

	/** The user saw the editor. */
	clear(editor: EditorInput): void;
}

/** Activation events right after the mark still belong to the agent's own open. */
const GRACE_PERIOD_MS = 1000;

class NovaAgentTabsService extends Disposable implements INovaAgentTabsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<EditorInput>());
	readonly onDidChange = this._onDidChange.event;

	private readonly marked = new WeakMap<EditorInput, number>();

	constructor(@IEditorService editorService: IEditorService) {
		super();

		// Showing the tab again later (Ctrl+Tab, switching groups) counts as seeing it.
		this._register(editorService.onDidActiveEditorChange(() => {
			const editor = editorService.activeEditor;
			const markedAt = editor && this.marked.get(editor);
			if (editor && markedAt !== undefined && Date.now() - markedAt > GRACE_PERIOD_MS) {
				this.clear(editor);
			}
		}));
	}

	isMarked(editor: EditorInput): boolean {
		return this.marked.has(editor);
	}

	mark(editor: EditorInput): void {
		this.marked.set(editor, Date.now());
		this._onDidChange.fire(editor);
	}

	clear(editor: EditorInput): void {
		if (this.marked.delete(editor)) {
			this._onDidChange.fire(editor);
		}
	}
}

registerSingleton(INovaAgentTabsService, NovaAgentTabsService, InstantiationType.Delayed);
