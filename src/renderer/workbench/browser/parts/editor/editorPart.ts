// src/renderer/workbench/browser/parts/editor/editorPart.ts — the editor part owns GROUPS in a
// horizontal split view, ported in shape from vs/workbench/browser/parts/editor/editorPart.ts
// (a grid there, a split view here — no drag/drop docking in this course).
//
// The real part keeps the last group around: closing the last editor leaves an EMPTY group with
// the watermark showing. Groups are never closed by the course's commands, so `addGroup` is the
// only structural mutation.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { append, position, size, $ } from '../../../../base/browser/dom.js';
import { IView, Orientation, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Part } from '../../part.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorGroupView, IEditorGroupViewServices } from './editorGroupView.js';

/** adapts a group to a SplitView view */
class GroupView implements IView {

	constructor(private readonly _group: EditorGroupView) { }

	get element(): HTMLElement {
		return this._group.element;
	}

	get minimumSize(): number {
		return 220;
	}

	get maximumSize(): number {
		return Number.POSITIVE_INFINITY;
	}

	layout(partSize: number, offset: number, orthogonalSize: number): void {
		position(this._group.element, 0, offset);
		size(this._group.element, partSize, orthogonalSize);
		this._group.layout(partSize, orthogonalSize);
	}
}

export interface IEditorCloseRequest {
	readonly input: EditorInput;
	readonly group: EditorGroupView;
}

export class EditorPart extends Part {

	private _splitView: SplitView | undefined;
	private readonly _groups: EditorGroupView[] = [];
	private _activeGroup: EditorGroupView | undefined;
	private _nextGroupId = 1;

	private readonly _onDidActiveGroupChange = this._register(new Emitter<EditorGroupView>());
	readonly onDidActiveGroupChange: Event<EditorGroupView> = this._onDidActiveGroupChange.event;
	private readonly _onDidAddGroup = this._register(new Emitter<EditorGroupView>());
	readonly onDidAddGroup: Event<EditorGroupView> = this._onDidAddGroup.event;
	/** tab ✕ / middle-click: the service owns the confirmation flow, the part only reports */
	private readonly _onDidRequestCloseEditor = this._register(new Emitter<IEditorCloseRequest>());
	readonly onDidRequestCloseEditor: Event<IEditorCloseRequest> = this._onDidRequestCloseEditor.event;

	constructor(private readonly _services: IEditorGroupViewServices) {
		super('editor');
	}

	override get minimumWidth(): number { return 300; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get minimumHeight(): number { return 0; }
	override get maximumHeight(): number { return Number.POSITIVE_INFINITY; }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const container = append(parent, $('.editor-part-content'));
		this._splitView = this._register(new SplitView(container, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: false
		}));
		// the workbench always has at least one group — its watermark is the empty state
		this.addGroup();
		return container;
	}

	get groups(): readonly EditorGroupView[] {
		return this._groups;
	}

	get activeGroup(): EditorGroupView {
		return this._activeGroup!;
	}

	getGroup(id: number): EditorGroupView | undefined {
		return this._groups.find(group => group.id === id);
	}

	/** split: a new empty group next to the active one (real's default direction is right) */
	addGroup(): EditorGroupView {
		const group = this._register(new EditorGroupView(this._nextGroupId++, this._services));
		this._groups.push(group);
		this._splitView!.addView(new GroupView(group), 0);
		// a freshly added view has size 0 and would stay 0×0 until the next workbench layout:
		// take half of the available width now so the new group is laid out immediately
		const totalWidth = this.dimension?.width ?? this._splitView!.size;
		if (totalWidth > 0) {
			this._splitView!.setViewSize(this._groups.length - 1, Math.max(1, Math.floor(totalWidth / 2)));
		}
		this._register(group.onDidActivate(() => this.setActiveGroup(group)));
		this._register(group.onDidRequestCloseEditor(input => this._onDidRequestCloseEditor.fire({ input, group })));
		this.setActiveGroup(group);
		this._onDidAddGroup.fire(group);
		return group;
	}

	setActiveGroup(group: EditorGroupView): void {
		if (this._activeGroup === group) {
			return;
		}
		this._activeGroup = group;
		for (const candidate of this._groups) {
			candidate.setActiveGroupLook(candidate === group);
		}
		this._onDidActiveGroupChange.fire(group);
	}

	/** the group showing this input, if any (used for open-editor reuse) */
	findGroup(input: EditorInput): EditorGroupView | undefined {
		return this._groups.find(group => group.contains(input));
	}

	override layout(width: number, height: number, top = 0, left = 0): void {
		super.layout(width, height, top, left);
		// the split view sizes its own container; groups position inside it
		this._splitView?.layout(width, height);
	}
}
