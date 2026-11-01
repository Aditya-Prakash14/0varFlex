// The Welcome page's state: walkthrough completion, the recent-folder list, and the startup
// decision. Pure, so these run without building an editor.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	addRecentFolder,
	basenameOf,
	dirnameOf,
	MAX_RECENT_FOLDERS,
	readCompletedSteps,
	readRecentFolders,
	removeRecentFolder,
	shouldOpenWelcomeOnStartup,
	stepForCommand,
	WALKTHROUGH_STEPS,
	walkthroughProgress,
	type IWalkthroughStep
} from '../src/renderer/workbench/contrib/welcome/browser/welcomeState.js';

// ---- the walkthrough definition itself

test('every walkthrough step has a unique id and a command', () => {
	const ids = new Set<string>();
	for (const step of WALKTHROUGH_STEPS) {
		assert.ok(step.id && !ids.has(step.id), `duplicate or missing id: ${step.id}`);
		ids.add(step.id);
		assert.ok(step.commandId, `${step.id} needs a command to complete it`);
		assert.ok(step.title && step.description && step.actionLabel, `${step.id} needs its text`);
	}
});

test('the first step is opening a folder, because little else works without one', () => {
	assert.equal(WALKTHROUGH_STEPS[0].id, 'openFolder');
});

// ---- completion state, read back from storage

test('readCompletedSteps accepts known ids and drops everything else', () => {
	const completed = readCompletedSteps(['openFolder', 'terminal']);
	assert.deepEqual([...completed].sort(), ['openFolder', 'terminal']);
});

test('readCompletedSteps drops ids this version no longer has', () => {
	// a renamed step must not leave a permanently-complete ghost behind
	const completed = readCompletedSteps(['openFolder', 'someRemovedStep']);
	assert.deepEqual([...completed], ['openFolder']);
});

test('readCompletedSteps survives junk in storage', () => {
	for (const stored of [null, undefined, 'nope', 42, {}, [1, 2, 3], [null]]) {
		assert.equal(readCompletedSteps(stored).size, 0, `${JSON.stringify(stored)} must be ignored`);
	}
});

test('walkthroughProgress counts and detects completion', () => {
	const steps: IWalkthroughStep[] = [
		{ id: 'a', title: 'A', description: '', commandId: 'c.a', actionLabel: 'A' },
		{ id: 'b', title: 'B', description: '', commandId: 'c.b', actionLabel: 'B' }
	];
	assert.deepEqual(walkthroughProgress(new Set(), steps), { done: 0, total: 2, allDone: false });
	assert.deepEqual(walkthroughProgress(new Set(['a']), steps), { done: 1, total: 2, allDone: false });
	assert.deepEqual(walkthroughProgress(new Set(['a', 'b']), steps), { done: 2, total: 2, allDone: true });
	// an id not in the step list must not inflate the count
	assert.deepEqual(walkthroughProgress(new Set(['a', 'ghost']), steps), { done: 1, total: 2, allDone: false });
});

test('walkthroughProgress on an empty walkthrough is not "all done"', () => {
	assert.deepEqual(walkthroughProgress(new Set(), []), { done: 0, total: 0, allDone: false });
});

test('stepForCommand maps a real command to the step it completes', () => {
	// this is the hook that ticks a step when the user actually runs the command
	assert.equal(stepForCommand('workbench.action.files.openFolder')?.id, 'openFolder');
	assert.equal(stepForCommand('workbench.action.chat.open')?.id, 'agent');
	assert.equal(stepForCommand('some.unrelated.command'), undefined);
});

// ---- the recent-folder list

test('addRecentFolder puts the newest first', () => {
    const list = addRecentFolder(addRecentFolder([], '/a'), '/b');
	assert.deepEqual(list.map(entry => entry.path), ['/b', '/a']);
});

test('re-opening a folder MOVES it to the front instead of duplicating it', () => {
	let list = addRecentFolder([], '/a');
	list = addRecentFolder(list, '/b');
	list = addRecentFolder(list, '/a');
	// otherwise the list fills with one folder
	assert.deepEqual(list.map(entry => entry.path), ['/a', '/b']);
	assert.equal(list.length, 2);
});

test('addRecentFolder caps the list', () => {
	let list: ReturnType<typeof addRecentFolder> = [];
	for (let i = 0; i < MAX_RECENT_FOLDERS + 5; i++) {
		list = addRecentFolder(list, `/folder-${i}`);
	}
	assert.equal(list.length, MAX_RECENT_FOLDERS);
	// the newest survive, the oldest fall off
	assert.equal(list[0].path, `/folder-${MAX_RECENT_FOLDERS + 4}`);
});

test('addRecentFolder ignores an empty path', () => {
	assert.deepEqual(addRecentFolder([], ''), []);
});

test('removeRecentFolder removes only that entry', () => {
	let list = addRecentFolder(addRecentFolder([], '/a'), '/b');
	list = removeRecentFolder(list, '/a');
	assert.deepEqual(list.map(entry => entry.path), ['/b']);
	// removing something absent is a no-op, not an error
	assert.deepEqual(removeRecentFolder(list, '/zzz').map(entry => entry.path), ['/b']);
});

test('readRecentFolders de-duplicates, caps and tolerates both stored shapes', () => {
	// an older build may have stored plain strings
	const fromStrings = readRecentFolders(['/a', '/b', '/a']);
	assert.deepEqual(fromStrings.map(entry => entry.path), ['/a', '/b']);

	const fromObjects = readRecentFolders([{ path: '/x', name: 'x' }, { path: '/y' }]);
	assert.deepEqual(fromObjects.map(entry => entry.path), ['/x', '/y']);

	assert.deepEqual(readRecentFolders('nope'), []);
	assert.deepEqual(readRecentFolders([null, 42, {}]), []);
});

test('readRecentFolders derives the display name from the path', () => {
	const [entry] = readRecentFolders(['/home/me/projects/my-app']);
	assert.equal(entry.name, 'my-app');
});

// ---- path display helpers

test('basenameOf handles both separators and trailing slashes', () => {
	assert.equal(basenameOf('/a/b/c'), 'c');
	assert.equal(basenameOf('C:\\Users\\me\\repo'), 'repo');
	assert.equal(basenameOf('/a/b/c/'), 'c', 'a trailing slash must not yield an empty label');
	assert.equal(basenameOf('repo'), 'repo');
	assert.equal(basenameOf('/'), '/');
});

test('dirnameOf returns the containing directory, or empty at the root', () => {
	assert.equal(dirnameOf('/a/b/c'), '/a/b');
	assert.equal(dirnameOf('C:\\Users\\me\\repo'), 'C:\\Users\\me');
	assert.equal(dirnameOf('/a'), '');
});

// ---- the startup decision

test('startup: anything restored from the previous session wins', () => {
	// the real setting reads "if none are restored from the previous session"
	for (const setting of ['welcomePage', 'welcomePageInEmptyWorkbench', 'none']) {
		assert.equal(shouldOpenWelcomeOnStartup(setting, false, true), false);
	}
});

test('startup: none never shows it, welcomePage always does', () => {
	assert.equal(shouldOpenWelcomeOnStartup('none', false, false), false);
	assert.equal(shouldOpenWelcomeOnStartup('none', true, false), false);
	assert.equal(shouldOpenWelcomeOnStartup('welcomePage', false, false), true);
	assert.equal(shouldOpenWelcomeOnStartup('welcomePage', true, false), true);
});

test('startup: welcomePageInEmptyWorkbench shows it only with no folder open', () => {
	assert.equal(shouldOpenWelcomeOnStartup('welcomePageInEmptyWorkbench', false, false), true);
	assert.equal(shouldOpenWelcomeOnStartup('welcomePageInEmptyWorkbench', true, false), false);
});

test('startup: an unknown value falls back to the default, not to silence', () => {
	// a typo in settings.json must not quietly disable the page
	for (const setting of [undefined, null, '', 'wlecomePage', 42, {}]) {
		assert.equal(shouldOpenWelcomeOnStartup(setting, false, false), true, `${JSON.stringify(setting)}`);
	}
});
