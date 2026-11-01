// src/renderer/workbench/contrib/scm/browser/scmActions.ts — the Source Control commands with
// the REAL ids read from vs/workbench/contrib/scm/browser/scm.contribution.ts:
//
//   workbench.view.scm   — show the Source Control composite
//   scm.acceptInput      — ctrl/cmd+enter in the commit box (runs the PROVIDER's command)
//
// Plus one generic command the workbench owns, which is how an extension gets text onto the
// screen without the workbench learning what the text is:
//
//   workbench.action.openReadonlyContent  — { key, name, content } → a readonly tab
//
// That command is the seam git-lite's diff uses. It is deliberately NOT git-shaped.

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { EditorService } from '../../../services/editor/browser/editorService.js';
import { ScmViewFocusContext } from './scmView.js';
import type { SCMView } from './scmView.js';

export const SCM_VIEW_ID = 'workbench.view.scm';
export const SCM_ACCEPT_INPUT_ID = 'scm.acceptInput';
export const OPEN_READONLY_CONTENT_ID = 'workbench.action.openReadonlyContent';

export interface ISCMActionServices {
	getView(): SCMView;
	showScmView(): void;
	readonly editorService: EditorService;
}

export function registerSCMActions(services: ISCMActionServices): IDisposable {
	const disposables: IDisposable[] = [];

	const register = (id: string, title: string, category: string, handler: (...args: never[]) => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...(args as never[]))));
		disposables.push(CommandMetadata.register({ id, title, category }));
	};

	register(SCM_VIEW_ID, 'Show Source Control', 'View', () => {
		services.showScmView();
		services.getView().focusInput();
	});

	register(SCM_ACCEPT_INPUT_ID, 'Accept Input (Commit)', 'Source Control', () => {
		services.getView().acceptInput();
	});

	// the generic readonly-content tab. An extension calls this through
	// `vscode.commands.executeCommand`, so no new RPC surface was needed for the diff.
	register(OPEN_READONLY_CONTENT_ID, 'Open Readonly Content', 'View', (options: unknown) => {
		const request = options as { key?: unknown; name?: unknown; content?: unknown } | undefined;
		if (!request || typeof request.content !== 'string') {
			return false;
		}
		const key = typeof request.key === 'string' && request.key ? request.key : `content-${Date.now()}`;
		const name = typeof request.name === 'string' && request.name ? request.name : 'Preview';
		return services.editorService.openReadonlyContent({ key, name, content: request.content });
	});

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: SCM_ACCEPT_INPUT_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: ScmViewFocusContext,
		primary: KeyMod.CtrlCmd | KeyCode.Enter
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
