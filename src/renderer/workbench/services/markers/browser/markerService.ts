// src/renderer/workbench/services/markers/browser/markerService.ts — the marker store, ported
// in semantics from vs/platform/markers/common/markerService.ts (+ markers.ts):
//
//   - markers are keyed by (resource, OWNER): an owner's update replaces only that owner's
//     markers — two providers must never clobber each other (the acceptance demands it);
//   - an empty update removes the tuple and still fires the change;
//   - reads are the reference's `read(filter)` with the severity bit-mask filter;
//   - `onMarkerChanged` reports the CHANGED RESOURCES, batched (the real service floats the
//     event after the current task; ours batches on a microtask).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';

/** ported bit-flag severities: Hint = 1, Info = 2, Warning = 4, Error = 8 */
export enum MarkerSeverity {
	Hint = 1,
	Info = 2,
	Warning = 4,
	Error = 8
}

export namespace MarkerSeverity {
	export function toString(severity: MarkerSeverity): string {
		switch (severity) {
			case MarkerSeverity.Hint: return 'Hint';
			case MarkerSeverity.Info: return 'Info';
			case MarkerSeverity.Warning: return 'Warning';
			case MarkerSeverity.Error: return 'Error';
			default: return 'Unknown';
		}
	}
}

export interface IMarkerRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface IMarkerData {
	readonly severity: MarkerSeverity;
	readonly message: string;
	readonly range: IMarkerRange;
	readonly code?: string;
}

export interface IMarker extends IMarkerData {
	readonly owner: string;
	readonly resource: URI;
}

export interface IMarkerFilter {
	/** bit mask: MarkerSeverity.Error covers errors only */
	readonly severity?: MarkerSeverity;
	readonly owner?: string;
	readonly resource?: URI;
}

function compareMarkers(a: IMarker, b: IMarker): number {
	// ported order: severity desc (Error first), then position
	if (a.severity !== b.severity) {
		return b.severity - a.severity;
	}
	if (a.resource.toString() !== b.resource.toString()) {
		return a.resource.toString() < b.resource.toString() ? -1 : 1;
	}
	if (a.range.startLineNumber !== b.range.startLineNumber) {
		return a.range.startLineNumber - b.range.startLineNumber;
	}
	return a.range.startColumn - b.range.startColumn;
}

export class MarkerService extends Disposable {

	/** resource → owner → markers */
	private readonly _data = new Map<string, Map<string, IMarker[]>>();
	private readonly _onMarkerChanged = this._register(new Emitter<readonly URI[]>());
	readonly onMarkerChanged: Event<readonly URI[]> = this._onMarkerChanged.event;

	private _pendingChangedResources: URI[] | null = null;

	// ---- mutations (the IMarkerService surface)

	changeOne(owner: string, resource: URI, markers: readonly IMarkerData[]): void {
		this.changeAll(owner, [{ resource, markers }]);
	}

	changeAll(owner: string, entries: readonly { resource: URI; markers: readonly IMarkerData[] }[]): void {
		const changed: URI[] = [];
		for (const entry of entries) {
			const key = entry.resource.toString();
			const byOwner = this._data.get(key);

			if (entry.markers.length === 0) {
				// remove this (owner, resource) tuple
				if (byOwner?.delete(owner)) {
					if (byOwner.size === 0) {
						this._data.delete(key);
					}
					changed.push(entry.resource);
				}
				continue;
			}

			const converted = entry.markers.map(marker => ({ ...marker, owner, resource: entry.resource }));
			const target = byOwner ?? new Map<string, IMarker[]>();
			target.set(owner, converted);
			this._data.set(key, target);
			changed.push(entry.resource);
		}

		if (changed.length > 0) {
			this._scheduleChangeEvent(changed);
		}
	}

	removeOwner(owner: string): void {
		const changed: URI[] = [];
		for (const [key, byOwner] of this._data) {
			if (byOwner.delete(owner)) {
				changed.push(URI.parse(key));
				if (byOwner.size === 0) {
					this._data.delete(key);
				}
			}
		}
		if (changed.length > 0) {
			this._scheduleChangeEvent(changed);
		}
	}

	private _scheduleChangeEvent(changed: readonly URI[]): void {
		// the real service floats the event; a microtask keeps callers synchronous. The event
		// reports a SET of resources: repeats of an already-pending resource are folded in.
		if (this._pendingChangedResources) {
			for (const resource of changed) {
				if (!this._pendingChangedResources.some(pending => pending.toString() === resource.toString())) {
					this._pendingChangedResources.push(resource);
				}
			}
			return;
		}
		this._pendingChangedResources = [...changed];
		queueMicrotask(() => {
			const resources = this._pendingChangedResources ?? [];
			this._pendingChangedResources = null;
			if (resources.length > 0) {
				this._onMarkerChanged.fire(resources);
			}
		});
	}

	// ---- reads

	read(filter?: IMarkerFilter): readonly IMarker[] {
		const result: IMarker[] = [];
		for (const byOwner of this._data.values()) {
			for (const markers of byOwner.values()) {
				for (const marker of markers) {
					if (filter?.severity !== undefined && (marker.severity & filter.severity) === 0) {
						continue;
					}
					if (filter?.owner !== undefined && marker.owner !== filter.owner) {
						continue;
					}
					if (filter?.resource !== undefined && marker.resource.toString() !== filter.resource.toString()) {
						continue;
					}
					result.push(marker);
				}
			}
		}
		return result.sort(compareMarkers);
	}

	readForResource(resource: URI): readonly IMarker[] {
		return this.read({ resource });
	}

	/** the per-line index the decorations and the problems picker share */
	markersByLine(resource: URI): Map<number, IMarker[]> {
		const byLine = new Map<number, IMarker[]>();
		for (const marker of this.readForResource(resource)) {
			for (let line = marker.range.startLineNumber; line <= Math.max(marker.range.startLineNumber, marker.range.endLineNumber); line++) {
				const list = byLine.get(line) ?? [];
				list.push(marker);
				byLine.set(line, list);
			}
		}
		return byLine;
	}

	hasMarkers(resource: URI): boolean {
		return (this._data.get(resource.toString())?.size ?? 0) > 0;
	}

	/** the highest severity on a line (the margin dot's color) */
	highestSeverityOnLine(resource: URI, lineNumber: number): MarkerSeverity | undefined {
		return this.markersByLine(resource).get(lineNumber)?.reduce<MarkerSeverity | undefined>(
			(highest, marker) => highest === undefined || marker.severity > highest ? marker.severity : highest,
			undefined
		);
	}

	getOwnerCount(resource: URI): number {
		return this._data.get(resource.toString())?.size ?? 0;
	}

	/** test/debug view */
	getResourceCount(): number {
		return this._data.size;
	}
}
