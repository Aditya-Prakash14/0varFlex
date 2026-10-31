// src/renderer/workbench/contrib/problems/browser/problemsView.ts — the problems surface the
// exercise asks for, composed from what earlier exercises already built:
//
//   - a status bar entry on the LEFT (`⨯ N  ⚠ M` — the real placement) that live-updates from
//     the marker service;
//   - clicking opens 04's quick pick listing every marker, grouped by file (sorted by severity
//     then position, using the service's ported order);
//   - picking one opens the resource with the marker's RANGE selected (09's open options grew
//     an end position for this).

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { MarkerService, MarkerSeverity, IMarker } from '../../../services/markers/browser/markerService.js';
import { QuickInputController } from '../../../../platform/quickinput/browser/quickInput.js';
import { EditorService } from '../../../services/editor/browser/editorService.js';
import { StatusbarPart, StatusbarAlignment } from '../../../browser/parts/statusbar/statusbarPart.js';

export interface IProblemsViewOptions {
	readonly markers: MarkerService;
	readonly quickInput: QuickInputController;
	readonly editorService: EditorService;
	readonly statusbar: StatusbarPart;
}

const STATUS_ENTRY_ID = 'status.problems';

export function registerProblemsView(options: IProblemsViewOptions): IDisposable {
	const { markers, quickInput, editorService, statusbar } = options;

	const updateStatusEntry = (): void => {
		const all = markers.read();
		const errors = all.filter(marker => marker.severity === MarkerSeverity.Error).length;
		const warnings = all.filter(marker => marker.severity === MarkerSeverity.Warning).length;
		statusbar.addEntry(STATUS_ENTRY_ID, {
			text: `⨯ ${errors}  ⚠ ${warnings}`,
			title: 'Problems',
			alignment: StatusbarAlignment.LEFT,
			priority: 50,
			onClick: () => void showProblemsPicker()
		});
	};

	const showProblemsPicker = async (): Promise<void> => {
		const all = markers.read();
		if (all.length === 0) {
			return;
		}
		const picked = await quickInput.pick<IMarker>({
			placeholder: 'Problems',
			items: value => {
				const needle = value.trim().toLowerCase();
				if (!needle) {
					return all;
				}
				return all.filter(marker =>
					marker.message.toLowerCase().includes(needle) ||
					(marker.resource.fsPath ?? marker.resource.path).toLowerCase().includes(needle)
				);
			},
			label: marker => `${severityGlyph(marker.severity)} ${marker.message}`,
			description: marker => `${relativePath(marker.resource.fsPath ?? marker.resource.path)}:${marker.range.startLineNumber}:${marker.range.startColumn}`
		});
		if (!picked) {
			return;
		}
		await editorService.openEditor({
			resource: picked.resource,
			options: {
				selection: {
					lineNumber: picked.range.startLineNumber,
					column: picked.range.startColumn,
					endLineNumber: picked.range.endLineNumber,
					endColumn: picked.range.endColumn
				}
			}
		});
	};

	const markersListener = markers.onMarkerChanged(() => updateStatusEntry());
	updateStatusEntry();
	// the entry always exists (0/0 included) — clicking with no markers is a no-op

	return toDisposable(() => {
		markersListener.dispose();
		statusbar.removeEntry(STATUS_ENTRY_ID);
	});
}

function severityGlyph(severity: MarkerSeverity): string {
	switch (severity) {
		case MarkerSeverity.Error: return '⨯';
		case MarkerSeverity.Warning: return '⚠';
		case MarkerSeverity.Info: return 'ⓘ';
		default: return '＊';
	}
}

function relativePath(fsPath: string): string {
	const parts = fsPath.split('/');
	return parts.length <= 3 ? fsPath : `…/${parts.slice(-3).join('/')}`;
}
