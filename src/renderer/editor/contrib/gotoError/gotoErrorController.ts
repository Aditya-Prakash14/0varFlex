// src/renderer/editor/contrib/gotoError/gotoErrorController.ts — F8 / Shift+F8: walk the
// markers in the open file.
//
// Ported in shape from vs/editor/contrib/gotoError/browser/gotoError.ts. The choosing is in
// markerNavigation.ts and tested there; this file reveals the marker and shows its message.
//
// shortcut: a one-line banner at the bottom of the editor instead of the reference's peek
// widget, which renders a full bordered panel with related-information links and
// previous/next buttons. The banner carries the severity, the position in the list and the
// message, which is what the keystroke is actually for. Upgrade when related information exists
// to show (it needs a provider we do not have).

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../common/editor/common/core/position.js';
import { URI } from '../../../../common/base/common/uri.js';
import { addDisposableListener, append, $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IMarker, MarkerService, MarkerSeverity } from '../../../workbench/services/markers/browser/markerService.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';
import { describeMarker, findMarkerNear, indexOfMarker, sortedForNavigation } from './markerNavigation.js';

export class GotoErrorController extends Disposable {

	private readonly _banner: HTMLElement;
	private _visible = false;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _markers: MarkerService,
		private readonly _getResource: () => URI | undefined,
		container: HTMLElement
	) {
		super();
		this._banner = append(container, $('.editor-marker-banner'));
		this._banner.style.display = 'none';
		this._banner.setAttribute('role', 'status');

		// the banner describes ONE marker at ONE position; any edit invalidates both
		const model = this._editor.getModel();
		if (model) {
			this._register(model.onDidChangeContent(() => this.hide()));
		}
		this._register(addDisposableListener(this._banner, 'click', () => this.hide()));
	}

	/** @returns the marker moved to, for the tests and the dev hook */
	move(direction: 'next' | 'previous'): IMarker | null {
		const markers = this._markersForFile();
		if (markers.length === 0) {
			this._show('No problems in this file', MarkerSeverity.Info);
			return null;
		}

		// search from the selection's START, not the cursor. `move` selects the whole marker range,
		// which leaves the cursor at the range END — searching from there made Shift+F8 find the
		// marker you were already standing on and go nowhere. Found by driving the real app; the
		// unit tests searched from a bare position and so could not see it.
		const position = this._editor.getSelection().getStartPosition();
		const marker = findMarkerNear(markers, position, direction);
		if (!marker) {
			return null;
		}

		// select the marker's range, so the problem is visible and not just scrolled to
		const { startLineNumber, startColumn, endLineNumber, endColumn } = marker.range;
		this._editor.setSelection(new Selection(startLineNumber, startColumn, endLineNumber, endColumn));
		// centred, because a problem revealed at the very bottom of the viewport has no context
		this._editor.revealPosition(new Position(startLineNumber, startColumn), 'center');
		this._show(describeMarker(marker, indexOfMarker(markers, marker), markers.length), marker.severity);
		return marker;
	}

	hide(): void {
		if (this._visible) {
			this._visible = false;
			this._banner.style.display = 'none';
		}
	}

	isVisible(): boolean {
		return this._visible;
	}

	private _markersForFile(): readonly IMarker[] {
		const resource = this._getResource();
		if (!resource) {
			return [];
		}
		return sortedForNavigation(this._markers.read({ resource }));
	}

	private _show(text: string, severity: MarkerSeverity): void {
		this._banner.textContent = text;
		this._banner.className = `editor-marker-banner ${MarkerSeverity.toString(severity).toLowerCase()}`;
		this._banner.style.display = '';
		this._visible = true;
	}
}

// ---- the per-widget lookup, the same shape the other contribs use

const controllers = new WeakMap<EditorWidget, GotoErrorController>();

export function registerGotoErrorController(widget: EditorWidget, controller: GotoErrorController): void {
	controllers.set(widget, controller);
}

export function gotoErrorControllerFor(widget: EditorWidget | null): GotoErrorController | null {
	return widget ? controllers.get(widget) ?? null : null;
}

/** the real ids from the reference's gotoError.ts */
export const GOTO_ERROR_IDS = {
	NextMarker: 'editor.action.marker.next',
	PreviousMarker: 'editor.action.marker.prev'
} as const;

export function registerGotoErrorCommands(getActiveController: () => GotoErrorController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const when = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (id: string, title: string, direction: 'next' | 'previous', primary: number): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			getActiveController()?.move(direction);
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Navigation' }));
		disposables.push(KeybindingsRegistry.registerKeybindingRule({
			id,
			weight: KeybindingWeight.EditorCore,
			when: when as never,
			primary
		}));
	};

	register(GOTO_ERROR_IDS.NextMarker, 'Go to Next Problem', 'next', KeyCode.F8);
	register(GOTO_ERROR_IDS.PreviousMarker, 'Go to Previous Problem', 'previous', KeyMod.Shift | KeyCode.F8);

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
