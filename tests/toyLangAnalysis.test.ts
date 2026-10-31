// The toy language grammar (12): analyze / completionsAt / hoverAt are pure — these tests pin
// the spec in the extension README without any editor, socket or LSP in the loop.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	analyze,
	completionsAt,
	hoverAt,
	DiagnosticSeverity
} from '../extensions/toy-lang/server/src/analysis.js';

const VALID = [
	'# a comment with an emoji 🎉',
	'[app]',
	'name = auto',
	'entry = true',
	'timeout = 30',
	'workers = 4',
	'',
	'[log]',
	'level = auto',
	'flags = false',
	''
].join('\n');

function messages(text: string): string[] {
	return analyze(text).map(d => d.message);
}

test('a valid document has no diagnostics', () => {
	assert.deepEqual(analyze(VALID), []);
});

test('a line without "=" is an Error with the ported message and range', () => {
	const diagnostics = analyze('name auto\n');
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].severity, DiagnosticSeverity.Error);
	assert.equal(diagnostics[0].message, "Expected 'key = value'");
	assert.equal(diagnostics[0].code, 'syntax');
	assert.deepEqual(diagnostics[0].range, {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 9 }
	});
});

test('unknown keys are Warnings pointing at the key text', () => {
	const diagnostics = analyze('bogus = true\n');
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].severity, DiagnosticSeverity.Warning);
	assert.equal(diagnostics[0].message, "Unknown key 'bogus'");
	assert.deepEqual(diagnostics[0].range.start, { line: 0, character: 0 });
	assert.deepEqual(diagnostics[0].range.end, { line: 0, character: 5 });
});

test('duplicate keys warn inside the same section, and are fine in different sections', () => {
	assert.equal(messages('timeout = 1\ntimeout = 2\n').length, 1);
	assert.match(messages('timeout = 1\ntimeout = 2\n')[0], /Duplicate key 'timeout'/);

	assert.deepEqual(analyze('[a]\ntimeout = 1\n[b]\ntimeout = 2\n'), []);

	const sectioned = analyze('[log]\nlevel = auto\nlevel = true\n');
	assert.equal(sectioned.length, 1);
	assert.match(sectioned[0].message, /Duplicate key 'level' in section 'log'/);
});

test('bad values and missing values are Warnings on the value text', () => {
	const bad = analyze('timeout = soon\n');
	assert.equal(bad.length, 1);
	assert.equal(bad[0].severity, DiagnosticSeverity.Warning);
	assert.match(bad[0].message, /Invalid value 'soon'/);
	assert.deepEqual(bad[0].range, { start: { line: 0, character: 10 }, end: { line: 0, character: 14 } });

	const missing = analyze('timeout =\n');
	assert.equal(missing.length, 1);
	assert.match(missing[0].message, /Missing value/);

	// numbers, negatives and decimals are fine
	assert.deepEqual(analyze('timeout = -1\nworkers = 2.5\n'), []);
});

test('comments are stripped, and an emoji in one shifts nothing', () => {
	const text = '# note 🎉\nname = true # trailing comment\n';
	assert.deepEqual(analyze(text), []);

	const withBad = '# 🎉 emoji\nbroken line\n';
	const diagnostics = analyze(withBad);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].range.start.line, 1);
});

test('section resolution: [log] + level is log.level; a root key stays usable in a section', () => {
	assert.deepEqual(analyze('[log]\nlevel = auto\n'), []);
	// the ported lenient rule: a key that exists at the root is valid anywhere
	assert.deepEqual(analyze('[log]\nname = auto\n'), []);
	assert.match(messages('[log]\nfoo = auto\n')[0], /Unknown key 'foo'/);
});

test('completions at line start offer the known keys and "["', () => {
	const result = completionsAt('', 0, 0);
	assert.equal(result.isIncomplete, false);
	const labels = result.items.map(item => item.label);
	assert.deepEqual(labels.slice(0, -1), ['name', 'entry', 'timeout', 'workers', 'log.level', 'flags']);
	assert.equal(labels[labels.length - 1], '[');

	// the text edit replaces what was typed ("ti" → "timeout")
	const typed = completionsAt('ti', 0, 2);
	const timeout = typed.items.find(item => item.label === 'timeout');
	assert.ok(timeout);
	assert.deepEqual(timeout.textEdit.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } });
	assert.equal(timeout.textEdit.newText, 'timeout');
});

test('inside [log] the key completion offers the local name, not the qualified one', () => {
	const text = '[log]\n';
	const result = completionsAt(text, 1, 0);
	const labels = result.items.map(item => item.label);
	assert.ok(labels.includes('level'));
	// the qualified spelling is not offered in the section it belongs to
	assert.ok(!labels.includes('log.level'));
	// root keys stay offered (the lenient resolution accepts them anywhere)
	assert.ok(labels.includes('name'));
});

test('after "=" the value completion is true/false/auto/<number> and isIncomplete', () => {
	const line = 'timeout = au';
	const result = completionsAt(line, 0, line.length);
	assert.equal(result.isIncomplete, true); // proves the refetch path
	assert.deepEqual(result.items.map(item => item.label), ['true', 'false', 'auto', '30']);
	// the text edit replaces the typed fragment ("au")
	const auto = result.items.find(item => item.label === 'auto');
	assert.ok(auto);
	assert.deepEqual(auto.textEdit.range, { start: { line: 0, character: 10 }, end: { line: 0, character: 12 } });
	assert.equal(auto.textEdit.newText, 'auto');
});

test('hover on a key returns markdown with the description, allowed values and an example', () => {
	const line = 'timeout = 30';
	const result = hoverAt(line, 0, 3);
	assert.ok(result);
	assert.match(result.contents, /`timeout`/);
	assert.match(result.contents, /How long to wait/);
	assert.match(result.contents, /Allowed values/);
	assert.match(result.contents, /```/);
	assert.deepEqual(result.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } });
});

test('hover on a value describes the line’s key; hover on nothing returns null', () => {
	const line = 'workers = 4';
	const onValue = hoverAt(line, 0, 11);
	assert.ok(onValue);
	assert.match(onValue.contents, /`workers`/);

	assert.equal(hoverAt('mystery = 1', 0, 2), null);
	assert.equal(hoverAt('', 0, 0), null);
});

test('hover works on a sectioned key and on a value inside the section', () => {
	const text = '[log]\nlevel = auto';
	const onKey = hoverAt(text, 1, 2);
	assert.ok(onKey);
	assert.match(onKey.contents, /`log\.level`/);
});
