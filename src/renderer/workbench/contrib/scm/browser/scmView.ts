// src/renderer/workbench/contrib/scm/browser/scmView.ts — the Source Control composite, ported
// in shape from vs/workbench/contrib/scm/browser/scmViewPane.ts:
//
//   - the commit box is the input box of whichever repository registered (placeholder comes from
//     the provider), Ctrl+Enter runs the provider's acceptInputCommand;
//   - resource groups render as a label + count badge, with one row per file: the status LETTER
//     and its colour (the M/A/D/R palette from the real contrib/scm CSS), the basename, and the
//     directory dimmed beside it;
//   - clicking a row executes the command the PROVIDER attached to that resource. The view does
//     not know what a diff is.
//
// delta: no staging (resource group actions), no inline hunk actions, no merge-conflict section,
// no provider switcher — one repository is the realistic single-folder case.
//
// shortcut: rows are rendered in full rather than windowed. A status list is tens of entries, not
// the 20k a search can produce; upgrade to the search tree's pooling if a repository ever floods.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import type { ISCMRepository, ISCMResource, SCMService } from '../../../services/scm/common/scmService.js';

export const ScmViewFocusContext = new RawContextKey<boolean>('scmViewFocus', false);

export interface ISCMViewServices {
	readonly scmService: SCMService;
	readonly commandService: ICommandService;
	readonly contextKeyService: IContextKeyService;
}

/** basename/dirname without pulling in node:path (the renderer is a browser bundle) */
function splitPath(fsPath: string): { name: string; dir: string } {
	const index = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
	return index >= 0
		? { name: fsPath.slice(index + 1), dir: fsPath.slice(0, index) }
		: { name: fsPath, dir: '' };
}

export class SCMView extends Disposable {

	readonly element: HTMLElement;

	private readonly _input: HTMLTextAreaElement;
	private readonly _body: HTMLElement;
	private readonly _placeholderOwner: HTMLTextAreaElement;
	private readonly _focusKey: IContextKey<boolean>;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	constructor(container: HTMLElement, private readonly _services: ISCMViewServices) {
		super();

		this.element = append(container, $('.scm-view'));

		this._input = append(this.element, $<HTMLTextAreaElement>('textarea.scm-input', {
			rows: '1',
			spellcheck: 'false',
			'aria-label': 'Source control commit message'
		}));
		this._placeholderOwner = this._input;

		this._body = append(this.element, $('.scm-body'));

		this._focusKey = ScmViewFocusContext.bindTo(_services.contextKeyService);
		this._register(addDisposableListener(this._input, 'focus', () => this._focusKey.set(true)));
		this._register(addDisposableListener(this._input, 'blur', () => this._focusKey.set(false)));

		this._register(addDisposableListener(this._input, 'input', () => {
			const repository = this._services.scmService.activeRepository;
			if (repository) {
				this._services.scmService.setInputBoxValue(repository.handle, this._input.value);
			}
		}));

		this._register(addDisposableListener(this._input, 'keydown', (event: KeyboardEvent) => {
			// the real binding: ctrl/cmd+enter accepts the input
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				this.acceptInput();
			}
		}));

		this._register(this._services.scmService.onDidChangeRepositories(() => this.render()));
		this.render();
	}

	focusInput(): void {
		this._input.focus();
	}

	/** run the provider's accept command (commit) */
	acceptInput(): void {
		const repository = this._services.scmService.activeRepository;
		const accept = repository?.acceptCommand;
		if (!repository || !accept) {
			return;
		}
		void this._services.commandService.executeCommand(accept.id, ...(accept.args ?? []));
	}

	render(): void {
		const repository = this._services.scmService.activeRepository;

		this._placeholderOwner.placeholder = repository?.inputBoxPlaceholder ?? 'Message (press Ctrl+Enter to commit)';
		// only overwrite the box when the provider's value genuinely differs, so typing is safe
		if (repository && this._input.value !== repository.inputBoxValue && document.activeElement !== this._input) {
			this._input.value = repository.inputBoxValue;
		}
		this._input.disabled = !repository;

		this._body.textContent = '';

		if (!repository) {
			append(this._body, $('.scm-empty', {}, 'No source control providers registered.'));
			this._onDidChangeState.fire();
			return;
		}

		const groups = repository.groups.filter(group => group.resources.length > 0);
		if (groups.length === 0) {
			append(this._body, $('.scm-empty', {}, 'No changes.'));
			this._onDidChangeState.fire();
			return;
		}

		for (const group of groups) {
			const header = append(this._body, $('.scm-group-header'));
			append(header, $('span.scm-group-label', {}, group.label));
			append(header, $('span.scm-group-count', {}, String(group.resources.length)));

			for (const resource of group.resources) {
				this._renderResource(this._body, resource);
			}
		}

		this._onDidChangeState.fire();
	}

	private _renderResource(parent: HTMLElement, resource: ISCMResource): void {
		const { name, dir } = splitPath(resource.resource.fsPath);
		const row = append(parent, $('.scm-row', { title: resource.tooltip ?? resource.resource.fsPath }));

		append(row, $('span.scm-row-name', {}, name));
		append(row, $('span.scm-row-dir', {}, dir));

		const letter = append(row, $('span.scm-row-letter', {}, resource.letter));
		// the colour comes from the letter, like the real decorations do
		letter.classList.add(`letter-${(resource.letter || 'x').toLowerCase()}`);

		if (resource.command) {
			const command = resource.command;
			this._register(addDisposableListener(row, 'click', () => {
				void this._services.commandService.executeCommand(command.id, ...(command.args ?? []));
			}));
		} else {
			row.classList.add('no-command');
		}
	}

	/** the badge the activity bar / header shows */
	get count(): number {
		return this._services.scmService.activeRepository?.count ?? 0;
	}

	currentRepository(): ISCMRepository | undefined {
		return this._services.scmService.activeRepository;
	}
}
