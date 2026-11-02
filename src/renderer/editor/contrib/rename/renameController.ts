// src/renderer/editor/contrib/rename/renameController.ts — F2: a small inline input over the
// symbol, Enter applies the provider's workspace edit, Escape cancels.
//
// Ported in shape from vs/editor/contrib/rename/browser/rename.ts (RenameAction + RenameSkeleton)
// and renameWidget.ts. The deciding is pure and lives elsewhere: renameValidation.ts seeds the box
// and vets the name, workspaceEdit.ts groups and validates the edit. This file is the input, the
// provider calls and the edit-stack brackets.
//
// shortcut: no rename preview ("Ctrl+Enter" in the reference), no rename suggestions list, and a
// cross-file rename only reaches files whose model the workbench already has open — the reference
// opens each file through the bulk edit service. A rename reaching an unopened file is refused
// whole rather than applied by halves. Upgrade when a text model service can open a resource.

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import type { TextModel } from '../../../../common/editor/common/model/textModel.js';
import { renameLocationAt, RenameLocation, validateNewName, validateRenameResult } from '../../../../common/editor/common/model/renameValidation.js';
import { IWorkspaceTextEdit, prepareWorkspaceEdit } from '../../../../common/editor/common/model/workspaceEdit.js';
import type { IWireRenameLocation, IWireWorkspaceEdit, IWireUri } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { addDisposableListener, append, $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { toEditorRange, type ILanguageFeaturesService, type IEditorPosition, type IRenameProviderAdapter } from '../../../workbench/api/common/mainThreadLanguageFeatures.js';
import type { EditorWidget } from '../../browser/editorWidget.js';

// ---- the pure parts (tested in tests/renameController.test.ts)

/** the one scheme this build's providers speak; parse keeps anything else from becoming file:// */
export function resourceFromWire(wire: IWireUri): URI {
	return wire.scheme === 'file' ? URI.file(wire.path) : URI.parse(`${wire.scheme}:${wire.path}`);
}

export type WireEditsResult =
	| { readonly ok: true; readonly edits: readonly IWorkspaceTextEdit[] }
	| { readonly ok: false; readonly rejectReason: string };

/**
 * A wire WorkspaceEdit to the flat 1-based edit list workspaceEdit.ts groups. Range's constructor
 * throws on a start-after-end range, so a provider answering nonsense is reported, not thrown.
 */
export function toWorkspaceTextEdits(wire: IWireWorkspaceEdit): WireEditsResult {
	const edits: IWorkspaceTextEdit[] = [];
	for (const entry of wire.edits) {
		const range = toEditorRange(entry.textEdit.range);
		try {
			edits.push({
				resource: resourceFromWire(entry.resource),
				range: new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
				text: entry.textEdit.newText
			});
		} catch (error) {
			return { ok: false, rejectReason: error instanceof Error ? error.message : String(error) };
		}
	}
	return { ok: true, edits };
}

/**
 * What the box opens with: the provider's prepareRename answer when it gave one (its range is 0-based
 * wire), else the word under the cursor.
 */
export function renameSeed(location: IWireRenameLocation | null, lineText: string, position: IEditorPosition): RenameLocation | null {
	if (location) {
		return { range: toEditorRange(location.range), text: location.text };
	}
	return renameLocationAt(lineText, position.lineNumber, position.column);
}

// ---- the widget

export class RenameController extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _input: HTMLInputElement;
	private readonly _message: HTMLElement;

	private _visible = false;
	private _seed: RenameLocation | null = null;
	private _provider: IRenameProviderAdapter | null = null;
	private _resource: URI | null = null;
	/** monotonic; a stale answer is dropped by comparing against it, nothing supersedes by itself */
	private _requestId = 0;
	private _pending: { handle: number; requestId: number } | null = null;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _languageFeatures: ILanguageFeaturesService,
		private readonly _getResource: () => URI | undefined,
		/** another open file's model, for a rename that spans files; without it those are refused */
		private readonly _modelForResource: (resource: URI) => TextModel | undefined = () => undefined
	) {
		super();

		this._element = append(_editor.view.element, $('.editor-rename-widget'));
		this._element.style.display = 'none';
		this._input = append(this._element, $<HTMLInputElement>('input.rename-input', {
			type: 'text', spellcheck: 'false', 'aria-label': 'Rename Symbol'
		}));
		this._message = append(this._element, $('span.rename-message', { role: 'status' }));

		this._register(addDisposableListener(this._input, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.accept();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.hide();
			}
		}));
		// clicking away is a cancel, like the reference's blur handling
		this._register(addDisposableListener(this._input, 'blur', () => this.hide()));
	}

	get isVisible(): boolean { return this._visible; }
	/** the name the box opened with, for tests and the dev hook */
	get currentName(): string | null { return this._seed?.text ?? null; }

	/** @returns whether the box opened; false is the no-op case, not an error */
	async show(): Promise<boolean> {
		const model = this._editor.getModel();
		const resource = this._getResource();
		// the readonly gate: the edits go to the model directly, so this is where it is checked
		if (!model || !resource || this._editor.isReadonly) {
			return false;
		}
		const provider = this._languageFeatures.getRenameProviders(this._languageFeatures.languageIdForResource(resource))[0];
		if (!provider) {
			return false; // no provider: no box at all
		}

		const position = this._editor.getSelection().getPosition();
		const requestId = this._nextRequest(provider.handle);
		const location = await provider.resolveRenameLocation(resource, { lineNumber: position.lineNumber, column: position.column }, requestId);
		if (requestId !== this._requestId) {
			return false; // superseded while in flight
		}
		this._pending = null;

		const seed = renameSeed(location, model.getLineContent(position.lineNumber), position);
		if (!seed) {
			return false; // nothing word-shaped under the cursor
		}

		this._seed = seed;
		this._provider = provider;
		this._resource = resource;
		this._message.textContent = '';
		this._input.value = seed.text;
		this._element.style.display = '';
		this._position(seed);
		this._visible = true;
		this._input.focus();
		this._input.select();
		return true;
	}

	/** @returns whether anything was renamed */
	async accept(): Promise<boolean> {
		const seed = this._seed;
		const provider = this._provider;
		const resource = this._resource;
		if (!this._visible || !seed || !provider || !resource || this._editor.isReadonly) {
			return false;
		}

		const newName = this._input.value;
		// an unchanged, empty or whitespace name lands here and never becomes an edit
		const nameReason = validateNewName(newName, seed.text);
		if (nameReason) {
			this._showMessage(nameReason);
			return false;
		}

		const requestId = this._nextRequest(provider.handle);
		const wire = await provider.provideRenameEdits(
			resource,
			{ lineNumber: seed.range.startLineNumber, column: seed.range.startColumn },
			newName,
			requestId
		);
		if (requestId !== this._requestId) {
			return false;
		}
		this._pending = null;
		if (!wire) {
			this._showMessage('No result.'); // null is both "empty" and "failed" on this SPI
			return false;
		}

		const converted = toWorkspaceTextEdits(wire);
		if (!converted.ok) {
			this._showMessage(converted.rejectReason);
			return false;
		}
		const sanityReason = validateRenameResult(converted.edits, newName);
		if (sanityReason) {
			this._showMessage(sanityReason);
			return false;
		}

		const prepared = prepareWorkspaceEdit(converted.edits, target => this._modelOf(target));
		if (!prepared.isApplied) {
			this._showMessage(prepared.rejectReason ?? prepared.ariaSummary);
			return false;
		}
		const unopened = prepared.groups.find(group => !this._modelOf(group.resource));
		if (unopened) {
			this._showMessage(`${unopened.resource.path} is not open — nothing was renamed.`);
			return false;
		}

		this.hide();
		for (const group of prepared.groups) {
			const model = this._modelOf(group.resource)!;
			// ONE undo step per file: the brackets make the whole group a single edit stack element
			model.pushStackElement();
			model.pushEditOperations(null, [...group.edits], () => null);
			model.pushStackElement();
		}
		return true;
	}

	hide(): void {
		if (!this._visible) {
			return;
		}
		this._visible = false;
		this._element.style.display = 'none';
		this._seed = null;
		this._provider = null;
		this._resource = null;
		// a dropped answer must not land in a closed box
		this._nextRequest(null);
		this._editor.focus();
	}

	private _showMessage(message: string): void {
		this._message.textContent = message;
	}

	/** bumps the request id and cancels the fetch it supersedes */
	private _nextRequest(handle: number | null): number {
		if (this._pending) {
			this._languageFeatures.cancelRequest(this._pending.handle, this._pending.requestId);
		}
		this._requestId++;
		this._pending = handle === null ? null : { handle, requestId: this._requestId };
		return this._requestId;
	}

	private _modelOf(resource: URI): TextModel | undefined {
		const active = this._getResource();
		if (active && active.toString() === resource.toString()) {
			return this._editor.getModel() ?? undefined;
		}
		return this._modelForResource(resource);
	}

	/** the anchor maths suggest uses: content coordinates, minus scroll, plus the line-number margin */
	private _position(seed: RenameLocation): void {
		const viewModel = this._editor.getViewModel();
		const scrollable = this._editor.view.scrollableElement;
		const lineText = this._editor.getModel()?.getLineContent(seed.range.startLineNumber) ?? '';
		const marginWidth = this._editor.view.marginElement.style.display === 'none'
			? 0
			: this._editor.view.marginElement.offsetWidth;
		const left = viewModel.getXForColumn(lineText, seed.range.startColumn) - scrollable.scrollLeft + marginWidth;
		const top = viewModel.getLineTop(seed.range.startLineNumber) - scrollable.scrollTop;
		this._element.style.left = `${Math.max(0, left)}px`;
		this._element.style.top = `${Math.max(0, top)}px`;
	}
}

// ---- the per-widget lookup, the same shape find and gotoError use

const controllers = new WeakMap<EditorWidget, RenameController>();

export function registerRenameController(widget: EditorWidget, controller: RenameController): void {
	controllers.set(widget, controller);
}

export function renameControllerFor(widget: EditorWidget | null): RenameController | null {
	return widget ? controllers.get(widget) ?? null : null;
}

/** the real id from the reference's rename.ts */
export const RENAME_IDS = {
	Rename: 'editor.action.rename'
} as const;

export function registerRenameCommands(getActiveController: () => RenameController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const editorTextFocus = new RawContextKey<boolean>('editorTextFocus', false);

	disposables.push(CommandsRegistry.registerCommand(RENAME_IDS.Rename, () => {
		void getActiveController()?.show();
	}));
	disposables.push(CommandMetadata.register({ id: RENAME_IDS.Rename, title: 'Rename Symbol', category: 'Refactor' }));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: RENAME_IDS.Rename,
		weight: KeybindingWeight.EditorContrib,
		when: editorTextFocus as never,
		primary: KeyCode.F2
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
