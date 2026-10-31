// The marker service (12): owner isolation is the point — two providers on one resource must
// never clobber each other's markers, and an owner update replaces only that owner's set.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';
import { MarkerService, MarkerSeverity } from '../src/renderer/workbench/services/markers/browser/markerService.js';

const RESOURCE = 'file:///tmp/markers.cfg';
const OTHER_RESOURCE = 'file:///tmp/other.cfg';

function marker(severity: MarkerSeverity, message: string, line = 1, column = 1) {
	return {
		severity,
		message,
		range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + 3 }
	};
}

test('severity values are the ported bit flags (Hint 1, Info 2, Warning 4, Error 8)', () => {
	assert.equal(MarkerSeverity.Hint, 1);
	assert.equal(MarkerSeverity.Info, 2);
	assert.equal(MarkerSeverity.Warning, 4);
	assert.equal(MarkerSeverity.Error, 8);
});

test('changeOne replaces only the calling owner’s markers (owner isolation)', () => {
	const service = new MarkerService();

	service.changeOne('toy-lang', URI.parse(RESOURCE), [marker(MarkerSeverity.Error, 'from toy-lang')]);
	service.changeOne('spelling', URI.parse(RESOURCE), [marker(MarkerSeverity.Warning, 'from spelling')]);

	// updating toy-lang must not touch spelling
	service.changeOne('toy-lang', URI.parse(RESOURCE), [marker(MarkerSeverity.Warning, 'updated toy-lang')]);

	const all = service.read();
	assert.equal(all.length, 2);
	assert.deepEqual(all.map(m => `${m.owner}:${m.message}`).sort(), ['spelling:from spelling', 'toy-lang:updated toy-lang']);
	assert.equal(service.getOwnerCount(URI.parse(RESOURCE)), 2);
});

test('an empty update removes that owner’s tuple and still fires', () => {
	const service = new MarkerService();
	service.changeOne('toy-lang', URI.parse(RESOURCE), [marker(MarkerSeverity.Error, 'x')]);
	service.changeOne('spelling', URI.parse(RESOURCE), [marker(MarkerSeverity.Warning, 'y')]);

	const seen: string[][] = [];
	service.onMarkerChanged(resources => seen.push(resources.map(r => r.toString())));

	service.changeOne('toy-lang', URI.parse(RESOURCE), []);
	assert.equal(service.read().length, 1);
	assert.equal(service.read()[0].owner, 'spelling');

	// removing the last owner drops the resource entirely
	service.changeOne('spelling', URI.parse(RESOURCE), []);
	assert.equal(service.read().length, 0);
	assert.equal(service.getResourceCount(), 0);

	return Promise.resolve().then(() => {
		// the batched event: one fire per microtask unless more changes arrive
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], [RESOURCE]);
	});
});

test('changeAll batches the changed resources into one event', async () => {
	const service = new MarkerService();
	const seen: string[][] = [];
	service.onMarkerChanged(resources => seen.push(resources.map(r => r.toString())));

	service.changeAll('toy-lang', [
		{ resource: URI.parse(RESOURCE), markers: [marker(MarkerSeverity.Error, 'a')] },
		{ resource: URI.parse(OTHER_RESOURCE), markers: [marker(MarkerSeverity.Warning, 'b')] }
	]);

	await Promise.resolve();
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0].sort(), [OTHER_RESOURCE, RESOURCE].sort());
});

test('read filters by the severity bit mask, owner and resource', () => {
	const service = new MarkerService();
	service.changeAll('toy-lang', [
		{
			resource: URI.parse(RESOURCE),
			markers: [
				marker(MarkerSeverity.Error, 'error'),
				marker(MarkerSeverity.Warning, 'warning'),
				marker(MarkerSeverity.Info, 'info')
			]
		},
		{ resource: URI.parse(OTHER_RESOURCE), markers: [marker(MarkerSeverity.Error, 'other')] }
	]);
	service.changeOne('spelling', URI.parse(RESOURCE), [marker(MarkerSeverity.Warning, 'typo')]);

	assert.equal(service.read({ severity: MarkerSeverity.Error }).length, 2);
	assert.equal(service.read({ resource: URI.parse(RESOURCE) }).length, 4);
	assert.equal(service.read({ owner: 'spelling' }).length, 1);
	assert.equal(service.read({ owner: 'toy-lang', severity: MarkerSeverity.Warning }).length, 1);
});

test('markers come back sorted severity-desc, then resource, then position', () => {
	const service = new MarkerService();
	service.changeOne('toy-lang', URI.parse(RESOURCE), [
		marker(MarkerSeverity.Info, 'info', 5, 2),
		marker(MarkerSeverity.Error, 'error line 3', 3, 1),
		marker(MarkerSeverity.Error, 'error line 1', 1, 4)
	]);
	const sorted = service.read();
	assert.deepEqual(sorted.map(m => m.message), ['error line 1', 'error line 3', 'info']);
});

test('markersByLine indexes every line a range spans', () => {
	const service = new MarkerService();
	service.changeOne('toy-lang', URI.parse(RESOURCE), [{
		severity: MarkerSeverity.Warning,
		message: 'multi',
		range: { startLineNumber: 2, startColumn: 4, endLineNumber: 4, endColumn: 2 }
	}]);
	const byLine = service.markersByLine(URI.parse(RESOURCE));
	assert.deepEqual([...byLine.keys()].sort(), [2, 3, 4]);
	assert.equal(byLine.get(3)?.length, 1);
	assert.equal(service.highestSeverityOnLine(URI.parse(RESOURCE), 3), MarkerSeverity.Warning);
	assert.equal(service.highestSeverityOnLine(URI.parse(RESOURCE), 5), undefined);
});

test('removeOwner clears every resource that owner touched', () => {
	const service = new MarkerService();
	service.changeAll('toy-lang', [
		{ resource: URI.parse(RESOURCE), markers: [marker(MarkerSeverity.Error, 'a')] },
		{ resource: URI.parse(OTHER_RESOURCE), markers: [marker(MarkerSeverity.Error, 'b')] }
	]);
	service.changeOne('spelling', URI.parse(RESOURCE), [marker(MarkerSeverity.Warning, 'c')]);

	service.removeOwner('toy-lang');
	assert.equal(service.read().length, 1);
	assert.equal(service.read()[0].owner, 'spelling');
	assert.equal(service.hasMarkers(URI.parse(OTHER_RESOURCE)), false);
});
