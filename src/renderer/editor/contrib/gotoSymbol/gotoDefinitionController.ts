// src/renderer/editor/contrib/gotoSymbol/gotoDefinitionController.ts — F12: ask the definition
// provider where the symbol under the cursor is declared, and go there.
//
// Ported in shape from vs/editor/contrib/gotoSymbol/browser/goToCommands.ts (the
// GoToDefinitionAction arm of it). There is no controller class and no per-widget state — one
// keystroke is one provider round trip — so this follows the stateless contrib shape of
// linesOperations.ts rather than findController's.
//
// shortcut: the first result wins when the provider returns several; the reference opens a peek
// list (gotoLocation.multipleDefinitions) to choose from. Upgrade when there is a peek widget to
// put the list in.
// shortcut: no "No definition found" message and no alternative command; a miss is silent, which
// is what the task asks for. Upgrade together with the peek widget.

import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { IWireLocation } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { toEditorRange, type ILanguageFeaturesService } from '../../../workbench/api/common/mainThreadLanguageFeatures.js';
import type { EditorWidget } from '../../browser/editorWidget.js';

/** the real id, verified against the reference's goToCommands.ts (GoToDefinitionAction.id) */
export const GOTO_DEFINITION_IDS = {
	RevealDefinition: 'editor.action.revealDefinition'
} as const;

/** what the editor service's openEditor takes: a range, revealed centred by the pane */
export interface IDefinitionSelection {
	readonly lineNumber: number;
	readonly column: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface IDefinitionTarget {
	readonly resource: URI;
	readonly selection: IDefinitionSelection;
}

export interface IGotoDefinitionContext {
	getActiveWidget(): EditorWidget | null;
	/** the active editor's file, or undefined for a pane with no resource */
	getResource(): URI | undefined;
	readonly languageFeatures: ILanguageFeaturesService;
	/** opens (or just activates) the file and selects the range, centred — the editor service's job */
	openEditor(target: IDefinitionTarget): Promise<unknown>;
}

/**
 * The whole decision: which of the provider's locations to go to, and where that is in editor
 * coordinates. The wire is 0-based LSP, the editor is 1-based — this is the only place the
 * conversion happens for F12.
 *
 * @returns null for no provider result at all (null, empty, or a malformed entry), which the
 * command turns into a silent no-op.
 */
export function definitionTarget(locations: readonly IWireLocation[] | null): IDefinitionTarget | null {
	const location = locations?.[0];
	if (!location?.uri || !location.range) {
		return null;
	}
	const range = toEditorRange(location.range);
	return {
		// the adapter layer spells wire uris the same way (mainThreadLanguageFeatures' workspace
		// edits): every resource that can reach this port is a file
		resource: URI.file(location.uri.path),
		selection: {
			lineNumber: range.startLineNumber,
			column: range.startColumn,
			endLineNumber: range.endLineNumber,
			endColumn: range.endColumn
		}
	};
}

/** every fetch bumps this, so a superseded F12 is cancelled at the LSP layer and its result dropped */
let requestId = 0;
let inFlight: { handle: number; requestId: number } | null = null;

export async function goToDefinition(context: IGotoDefinitionContext): Promise<IDefinitionTarget | null> {
	const widget = context.getActiveWidget();
	const resource = context.getResource();
	if (!widget || !widget.getModel() || !resource) {
		return null;
	}

	const languageId = context.languageFeatures.languageIdForResource(resource);
	const provider = context.languageFeatures.getDefinitionProviders(languageId)[0];
	if (!provider) {
		return null;
	}

	const id = ++requestId;
	if (inFlight) {
		context.languageFeatures.cancelRequest(inFlight.handle, inFlight.requestId);
	}
	inFlight = { handle: provider.handle, requestId: id };

	const position = widget.getSelection().getPosition();
	let locations: readonly IWireLocation[] | null = null;
	try {
		locations = await provider.provideDefinition(resource, { lineNumber: position.lineNumber, column: position.column }, id);
	} catch {
		// a provider failure is indistinguishable from an empty result over this SPI, so both are a no-op
		locations = null;
	}
	if (id !== requestId) {
		return null;
	}
	inFlight = null;

	const target = definitionTarget(locations);
	if (!target) {
		return null;
	}
	// the open applies the selection AND reveals it centred, in this file or another one
	await context.openEditor(target);
	return target;
}

export function registerGotoDefinitionCommands(context: IGotoDefinitionContext): IDisposable {
	const disposables: IDisposable[] = [
		CommandsRegistry.registerCommand(GOTO_DEFINITION_IDS.RevealDefinition, () => {
			void goToDefinition(context);
		}),
		CommandMetadata.register({ id: GOTO_DEFINITION_IDS.RevealDefinition, title: 'Go to Definition', category: 'Navigation' }),
		KeybindingsRegistry.registerKeybindingRule({
			id: GOTO_DEFINITION_IDS.RevealDefinition,
			weight: KeybindingWeight.EditorContrib,
			when: new RawContextKey<boolean>('editorTextFocus', false) as never,
			primary: KeyCode.F12
		})
	];
	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
