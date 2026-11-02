// src/renderer/editor/contrib/gotoError/markerNavigation.ts — which marker F8 goes to.
//
// Ported in behaviour from vs/editor/contrib/gotoError/browser/markerNavigationService.ts. The
// choosing is separated from the jumping because "next" has three edge cases that are easy to get
// subtly wrong and invisible when they are: the cursor sitting exactly on a marker, the cursor
// past the last one (wrap), and two markers on the same line.

import { IMarker, MarkerSeverity } from '../../../workbench/services/markers/browser/markerService.js';

export interface IMarkerPosition {
	readonly lineNumber: number;
	readonly column: number;
}

/** reading order: by line, then by column — NOT the severity order the problems view uses */
export function compareMarkerPositions(a: IMarker, b: IMarker): number {
	if (a.range.startLineNumber !== b.range.startLineNumber) {
		return a.range.startLineNumber - b.range.startLineNumber;
	}
	return a.range.startColumn - b.range.startColumn;
}

/** the markers for one file in reading order; the service returns them severity-first */
export function sortedForNavigation(markers: readonly IMarker[]): IMarker[] {
	return [...markers].sort(compareMarkerPositions);
}

/**
 * The marker to move to from `position`.
 *
 * Strictly after (or before) the position, so pressing F8 twice on the same marker advances
 * instead of standing still. Wraps at the end, which is what makes F8 a walk through every
 * problem in the file rather than a dead end.
 *
 * Returns null only when there are no markers at all.
 */
export function findMarkerNear(
	markers: readonly IMarker[],
	position: IMarkerPosition,
	direction: 'next' | 'previous'
): IMarker | null {
	const sorted = sortedForNavigation(markers);
	if (sorted.length === 0) {
		return null;
	}

	if (direction === 'next') {
		const found = sorted.find(marker => isAfter(marker, position));
		return found ?? sorted[0]; // wrap to the top
	}

	for (let i = sorted.length - 1; i >= 0; i--) {
		if (isBefore(sorted[i], position)) {
			return sorted[i];
		}
	}
	return sorted[sorted.length - 1]; // wrap to the bottom
}

function isAfter(marker: IMarker, position: IMarkerPosition): boolean {
	const { startLineNumber, startColumn } = marker.range;
	return startLineNumber > position.lineNumber
		|| (startLineNumber === position.lineNumber && startColumn > position.column);
}

function isBefore(marker: IMarker, position: IMarkerPosition): boolean {
	const { startLineNumber, startColumn } = marker.range;
	return startLineNumber < position.lineNumber
		|| (startLineNumber === position.lineNumber && startColumn < position.column);
}

/** `Error (2 of 7): message` — the reference's shape, so the count tells you where you are */
export function describeMarker(marker: IMarker, index: number, total: number): string {
	const severity = MarkerSeverity.toString(marker.severity);
	const position = total > 1 ? ` (${index + 1} of ${total})` : '';
	return `${severity}${position}: ${marker.message}`;
}

/** where `marker` sits in reading order, for the message above */
export function indexOfMarker(markers: readonly IMarker[], marker: IMarker): number {
	return sortedForNavigation(markers).findIndex(candidate =>
		candidate === marker
		|| (candidate.range.startLineNumber === marker.range.startLineNumber
			&& candidate.range.startColumn === marker.range.startColumn
			&& candidate.message === marker.message));
}
