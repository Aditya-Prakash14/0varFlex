// A2-2: the toy debugger's program semantics (pure), plus the workbench client's tolerant
// readers for DAP response bodies.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	applyLine,
	firstBreakpointIndex,
	parseProgram,
	runUntilBreakpoint
} from '../extensions/toy-debug/src/program.js';
import { readFrames, readScopes, readVariables } from '../src/renderer/workbench/services/debug/browser/debugService.js';

// ---- parsing

test('parseProgram: statements keep their ORIGINAL line numbers', () => {
	// blank lines and comments must not shift execution onto the wrong statement
	const { lines } = parseProgram('# a comment\n\ninc\n\nset 5\n');
	assert.deepEqual(lines.map(line => [line.lineNumber, line.op, line.operand]), [
		[3, 'inc', 1],
		[5, 'set', 5]
	]);
});

test('parseProgram: inc/dec default to 1 and accept an operand', () => {
	const { lines } = parseProgram('inc\ninc 10\ndec\ndec 4\n');
	assert.deepEqual(lines.map(line => [line.op, line.operand]), [
		['inc', 1], ['inc', 10], ['dec', 1], ['dec', 4]
	]);
});

test('parseProgram: print takes no operand', () => {
	const { lines } = parseProgram('print\n');
	assert.equal(lines[0].op, 'print');
	assert.equal(lines[0].operand, undefined);
});

test('parseProgram: errors are collected, not thrown, and the good lines survive', () => {
	const { lines, errors } = parseProgram('inc\nfly 3\nset\nset x\nset 2\n');
	assert.deepEqual(lines.map(line => line.lineNumber), [1, 5]);
	assert.deepEqual(errors.map(error => error.lineNumber), [2, 3, 4]);
	assert.match(errors[0].message, /unknown statement/);
	assert.match(errors[1].message, /needs a value/);
	assert.match(errors[2].message, /not an integer/);
});

test('parseProgram: CRLF input parses the same as LF', () => {
	const { lines } = parseProgram('inc\r\nset 3\r\n');
	assert.deepEqual(lines.map(line => [line.lineNumber, line.op]), [[1, 'inc'], [2, 'set']]);
});

// ---- stepping

test('applyLine: each op does what it says', () => {
	const at = (op: string, operand?: number) => ({ lineNumber: 1, op: op as never, operand, text: '' });
	assert.equal(applyLine(5, at('inc')).counter, 6);
	assert.equal(applyLine(5, at('inc', 10)).counter, 15);
	assert.equal(applyLine(5, at('dec')).counter, 4);
	assert.equal(applyLine(5, at('dec', 3)).counter, 2);
	assert.equal(applyLine(5, at('set', 42)).counter, 42);
	// print leaves the counter alone and produces output
	const printed = applyLine(7, at('print'));
	assert.equal(printed.counter, 7);
	assert.equal(printed.output, 'counter = 7\n');
});

test('runUntilBreakpoint: with no breakpoints the whole program runs', () => {
	const { lines } = parseProgram('set 0\ninc\ninc\ninc 10\n');
	const result = runUntilBreakpoint(lines, 0, 0, new Set());
	assert.equal(result.counter, 12);
	assert.equal(result.index, lines.length);
	assert.equal(result.stoppedAtBreakpoint, false);
});

test('runUntilBreakpoint: stops BEFORE executing the breakpoint line', () => {
	const { lines } = parseProgram('set 0\ninc\ninc\ninc 10\n');
	// breakpoint on line 4 ("inc 10"): lines 1-3 run, so counter is 2, not 12
	const result = runUntilBreakpoint(lines, 0, 0, new Set([4]));
	assert.equal(result.stoppedAtBreakpoint, true);
	assert.equal(result.counter, 2, 'the breakpoint line must not have run yet');
	assert.equal(lines[result.index].lineNumber, 4);
});

test('runUntilBreakpoint: the starting line always executes, so continue makes progress', () => {
	const { lines } = parseProgram('inc\ninc\ninc\n');
	// sitting on a breakpoint at line 2 and continuing must not stop on line 2 again
	const result = runUntilBreakpoint(lines, 1, 0, new Set([2]));
	assert.equal(result.stoppedAtBreakpoint, false, 'continue would otherwise loop forever');
	assert.equal(result.counter, 2);
	assert.equal(result.index, 3);
});

test('runUntilBreakpoint: a breakpoint on a blank line never matches', () => {
	const { lines } = parseProgram('inc\n\ninc\n');
	const result = runUntilBreakpoint(lines, 0, 0, new Set([2]));
	assert.equal(result.stoppedAtBreakpoint, false);
	assert.equal(result.counter, 2);
});

test('runUntilBreakpoint: outputs are collected in order', () => {
	const { lines } = parseProgram('set 1\nprint\ninc\nprint\n');
	const result = runUntilBreakpoint(lines, 0, 0, new Set());
	assert.deepEqual(result.outputs, ['counter = 1\n', 'counter = 2\n']);
});

test('firstBreakpointIndex: finds the first matching statement, or -1', () => {
	const { lines } = parseProgram('inc\ninc\ninc\n');
	assert.equal(firstBreakpointIndex(lines, new Set([3])), 2);
	assert.equal(firstBreakpointIndex(lines, new Set([1, 3])), 0);
	assert.equal(firstBreakpointIndex(lines, new Set([3]), 2), 2);
	assert.equal(firstBreakpointIndex(lines, new Set([99])), -1);
	assert.equal(firstBreakpointIndex(lines, new Set()), -1);
});

// ---- the client's tolerant body readers (an adapter may omit anything)

test('readFrames: reads a well-formed stackTrace body', () => {
	const frames = readFrames({
		stackFrames: [{ id: 1, name: 'inc 10', line: 4, column: 1, source: { path: '/p/program.toy' } }]
	});
	assert.deepEqual(frames, [{ id: 1, name: 'inc 10', line: 4, column: 1, path: '/p/program.toy' }]);
});

test('readFrames: junk and missing fields never throw', () => {
	assert.deepEqual(readFrames(undefined), []);
	assert.deepEqual(readFrames({}), []);
	assert.deepEqual(readFrames({ stackFrames: 'nope' }), []);
	// a frame without an id or line is not renderable and is dropped
	assert.deepEqual(readFrames({ stackFrames: [{ name: 'x' }, { id: 1 }] }), []);
	// column and source are optional
	assert.deepEqual(readFrames({ stackFrames: [{ id: 2, line: 7 }] }), [
		{ id: 2, name: 'frame 2', line: 7, column: 1, path: undefined }
	]);
});

test('readScopes: scopes start collapsed with no variables loaded', () => {
	const scopes = readScopes({ scopes: [{ name: 'Locals', variablesReference: 1000 }] });
	assert.deepEqual(scopes, [{ name: 'Locals', variablesReference: 1000, variables: [], expanded: false }]);
	assert.deepEqual(readScopes({ scopes: [{ name: 'no ref' }] }), []);
	assert.deepEqual(readScopes(null), []);
});

test('readVariables: values are stringified, missing ones become empty', () => {
	const variables = readVariables({
		variables: [
			{ name: 'counter', value: 12, variablesReference: 0 },
			{ name: 'flag', value: false },
			{ name: 'empty' }
		]
	});
	assert.deepEqual(variables, [
		{ name: 'counter', value: '12', variablesReference: 0 },
		{ name: 'flag', value: 'false', variablesReference: 0 },
		{ name: 'empty', value: '', variablesReference: 0 }
	]);
	assert.deepEqual(readVariables({}), []);
});
