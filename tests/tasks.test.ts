// A2-3: the task model — variable expansion, npm detection, tasks.json parsing, the
// problem matcher and the ANSI stripping that has to happen before matching.
//
// All pure, so none of this needs a pty.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	expandTask,
	expandVariables,
	ITask,
	matchProblems,
	npmScriptGroup,
	npmTasksFromPackageJson,
	parseTasksJson,
	sortTasks,
	taskForGroup
} from '../src/common/platform/tasks/common/tasks.js';
import { stripAnsi, stripAnsiStreaming } from '../src/renderer/workbench/contrib/tasks/browser/taskService.js';

// ---- variables

test('expandVariables: the supported variables are replaced', () => {
	const context = { workspaceFolder: '/w', file: '/w/src/a.ts' };
	assert.equal(expandVariables('${workspaceFolder}/out', context), '/w/out');
	assert.equal(expandVariables('check ${file}', context), 'check /w/src/a.ts');
	assert.equal(expandVariables('${workspaceFolder} ${file}', context), '/w /w/src/a.ts');
});

test('expandVariables: an UNKNOWN variable is left alone, not blanked', () => {
	// blanking would turn `rm -rf ${unknown}/x` into `rm -rf /x`
	assert.equal(expandVariables('${nope}/x', { workspaceFolder: '/w' }), '${nope}/x');
	// and so is a known name with no value available
	assert.equal(expandVariables('${file}', { workspaceFolder: '/w' }), '${file}');
});

test('expandTask: expands the command, every arg and the cwd', () => {
	const task: ITask = {
		label: 't', source: 'workspace', command: '${workspaceFolder}/run.sh',
		args: ['--in', '${file}', '--plain'], group: 'none', cwd: '${workspaceFolder}/sub'
	};
	const expanded = expandTask(task, { workspaceFolder: '/w', file: '/w/a.ts' });
	assert.equal(expanded.command, '/w/run.sh');
	assert.deepEqual(expanded.args, ['--in', '/w/a.ts', '--plain']);
	assert.equal(expanded.cwd, '/w/sub');
	assert.equal(expanded.label, 't', 'the label is not a template');
});

// ---- npm detection

test('npmScriptGroup: the real provider heuristic', () => {
	assert.equal(npmScriptGroup('build'), 'build');
	assert.equal(npmScriptGroup('compile'), 'build');
	assert.equal(npmScriptGroup('watch'), 'build');
	assert.equal(npmScriptGroup('test'), 'test');
	assert.equal(npmScriptGroup('Test'), 'test', 'the match is case-insensitive');
	assert.equal(npmScriptGroup('start'), 'none');
	assert.equal(npmScriptGroup('lint'), 'none');
});

test('npmTasksFromPackageJson: scripts become "npm: <script>" tasks running npm run', () => {
	const { tasks, errors } = npmTasksFromPackageJson(JSON.stringify({
		scripts: { build: 'tsc', test: 'node --test', start: 'electron .' }
	}));
	assert.deepEqual(errors, []);
	assert.deepEqual(tasks.map(task => task.label), ['npm: build', 'npm: test', 'npm: start']);
	assert.deepEqual(tasks[0].args, ['run', 'build']);
	assert.equal(tasks[0].command, 'npm');
	assert.equal(tasks[0].group, 'build');
	assert.equal(tasks[1].group, 'test');
	assert.equal(tasks[2].group, 'none');
});

test('npmTasksFromPackageJson: no scripts is normal, bad JSON is an error', () => {
	assert.deepEqual(npmTasksFromPackageJson('{}'), { tasks: [], errors: [] });
	assert.deepEqual(npmTasksFromPackageJson('{"scripts":null}'), { tasks: [], errors: [] });
	assert.deepEqual(npmTasksFromPackageJson('{"scripts":[]}').tasks, []);
	const broken = npmTasksFromPackageJson('{not json');
	assert.equal(broken.tasks.length, 0);
	assert.match(broken.errors[0].message, /not valid JSON/);
});

test('npmTasksFromPackageJson: non-string script bodies are skipped', () => {
	const { tasks } = npmTasksFromPackageJson('{"scripts":{"ok":"x","bad":42}}');
	assert.deepEqual(tasks.map(task => task.label), ['npm: ok']);
});

// ---- tasks.json

test('parseTasksJson: a well-formed file produces tasks', () => {
	const { tasks, errors } = parseTasksJson(JSON.stringify({
		version: '2.0.0',
		tasks: [
			{ label: 'build it', command: 'make', args: ['-j4'], group: 'build' },
			{ label: 'plain', command: 'ls' }
		]
	}));
	assert.deepEqual(errors, []);
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0].label, 'build it');
	assert.equal(tasks[0].group, 'build');
	assert.deepEqual(tasks[0].args, ['-j4']);
	assert.equal(tasks[0].source, 'workspace');
	assert.deepEqual(tasks[1].args, [], 'args default to empty');
	assert.equal(tasks[1].group, 'none');
});

test('parseTasksJson: bad entries are reported and SKIPPED, good ones survive', () => {
	const { tasks, errors } = parseTasksJson(JSON.stringify({
		tasks: [
			{ command: 'no-label' },
			{ label: 'no command' },
			{ label: 'fine', command: 'ok' }
		]
	}));
	assert.deepEqual(tasks.map(task => task.label), ['fine']);
	assert.equal(errors.length, 2);
	assert.match(errors[0].message, /needs a string "label"/);
	assert.match(errors[1].message, /needs a string "command"/);
});

test('parseTasksJson: a missing tasks array is an error, not a crash', () => {
	assert.match(parseTasksJson('{}').errors[0].message, /needs a "tasks" array/);
	assert.match(parseTasksJson('nope').errors[0].message, /not valid JSON/);
});

test('parseTasksJson: an unknown group falls back to none', () => {
	const { tasks } = parseTasksJson('{"tasks":[{"label":"a","command":"b","group":"deploy"}]}');
	assert.equal(tasks[0].group, 'none');
});

test('parseTasksJson: a problem matcher is read only when complete and valid', () => {
	const good = parseTasksJson(JSON.stringify({
		tasks: [{
			label: 'a', command: 'b',
			problemMatcher: { pattern: '^(.*):(\\d+): (.*)$', file: 1, line: 2, message: 3, severity: 'warning' }
		}]
	}));
	assert.equal(good.tasks[0].problemMatcher?.severity, 'warning');
	assert.equal(good.tasks[0].problemMatcher?.column, undefined);

	// an incomplete matcher is dropped rather than half-applied
	const incomplete = parseTasksJson('{"tasks":[{"label":"a","command":"b","problemMatcher":{"pattern":"x"}}]}');
	assert.equal(incomplete.tasks[0].problemMatcher, undefined);

	// an INVALID regex must be rejected at parse time, not at the first line of output
	const badRegex = parseTasksJson('{"tasks":[{"label":"a","command":"b","problemMatcher":{"pattern":"(unclosed","file":1,"line":2,"message":3}}]}');
	assert.equal(badRegex.tasks[0].problemMatcher, undefined);
});

// ---- group selection and ordering

test('taskForGroup / sortTasks', () => {
	const tasks: ITask[] = [
		{ label: 'npm: test', source: 'npm', command: 'npm', args: [], group: 'test' },
		{ label: 'npm: build', source: 'npm', command: 'npm', args: [], group: 'build' },
		{ label: 'zeta', source: 'workspace', command: 'z', args: [], group: 'none' },
		{ label: 'alpha', source: 'workspace', command: 'a', args: [], group: 'build' }
	];
	assert.equal(taskForGroup(tasks, 'test')?.label, 'npm: test');
	assert.equal(taskForGroup(tasks, 'none')?.label, 'zeta');
	// workspace tasks first, alphabetical within a source
	assert.deepEqual(sortTasks(tasks).map(task => task.label), ['alpha', 'zeta', 'npm: build', 'npm: test']);
});

// ---- the problem matcher

const MATCHER = { pattern: '^(.*):(\\d+):(\\d+): (.*)$', file: 1, line: 2, column: 3, message: 4 };

test('matchProblems: captures file, line, column and message', () => {
	const problems = matchProblems('src/a.ts:12:5: something is wrong\n', MATCHER);
	assert.deepEqual(problems, [{ path: 'src/a.ts', line: 12, column: 5, message: 'something is wrong', severity: 'error' }]);
});

test('matchProblems: non-matching output is not a problem', () => {
	const output = [
		'> my-app@1.0.0 build',
		'> tsc -p .',
		'',
		'src/a.ts:3:1: real error',
		'Done in 1.2s'
	].join('\n');
	const problems = matchProblems(output, MATCHER);
	assert.equal(problems.length, 1, 'build noise must not become problems');
	assert.equal(problems[0].line, 3);
});

test('matchProblems: severity defaults to error and is honoured when given', () => {
	assert.equal(matchProblems('a:1:1: m\n', MATCHER)[0].severity, 'error');
	assert.equal(matchProblems('a:1:1: m\n', { ...MATCHER, severity: 'warning' })[0].severity, 'warning');
});

test('matchProblems: a missing column defaults to 1', () => {
	const problems = matchProblems('a.ts:7: oops\n', { pattern: '^(.*):(\\d+): (.*)$', file: 1, line: 2, message: 3 });
	assert.deepEqual(problems, [{ path: 'a.ts', line: 7, column: 1, message: 'oops', severity: 'error' }]);
});

test('matchProblems: a match with an unusable line number is skipped, not reported at line 0', () => {
	// a squiggle at line 0 would land in the wrong place
	const problems = matchProblems('a.ts:0:1: bad\na.ts:x:1: worse\n', MATCHER);
	assert.deepEqual(problems, []);
});

test('matchProblems: CRLF output matches the same as LF', () => {
	assert.equal(matchProblems('a.ts:1:2: m\r\n', MATCHER).length, 1);
});

test('matchProblems: an invalid pattern yields nothing instead of throwing', () => {
	assert.deepEqual(matchProblems('a.ts:1:2: m\n', { ...MATCHER, pattern: '(unclosed' }), []);
});

// ---- ANSI stripping (a pty colours its output, and the escapes poison the captures)

test('stripAnsi: colour codes would otherwise be captured INTO the path', () => {
	const coloured = '\u001b[31msrc/a.ts:4:2: red error\u001b[0m';
	assert.equal(stripAnsi(coloured), 'src/a.ts:4:2: red error');

	// The failure mode is worse than "does not match": a greedy `(.*)` happily swallows the
	// escape, so the matcher reports a problem against a path that does not exist and a message
	// carrying a trailing reset code. Stripping first is what makes the marker land on the real
	// file instead of a phantom one.
	const unstripped = matchProblems(coloured, MATCHER);
	assert.equal(unstripped.length, 1);
	assert.notEqual(unstripped[0].path, 'src/a.ts');
	assert.ok(unstripped[0].path.includes('\u001b'), 'the escape ends up inside the captured path');

	const stripped = matchProblems(stripAnsi(coloured), MATCHER);
	assert.deepEqual(stripped, [{ path: 'src/a.ts', line: 4, column: 2, message: 'red error', severity: 'error' }]);
});

test('stripAnsi: OSC sequences (window titles) are removed too', () => {
	assert.equal(stripAnsi('\u001b]0;a title\u0007hello'), 'hello');
	assert.equal(stripAnsi('plain text'), 'plain text');
});

// ---- the streaming stripper: a pty can split an escape across two chunks

test('stripAnsiStreaming: a whole escape in one chunk is stripped immediately', () => {
	const result = stripAnsiStreaming('', '\u001b[31mred\u001b[0m\n');
	assert.equal(result.text, 'red\n');
	assert.equal(result.pending, '');
});

test('stripAnsiStreaming: an escape SPLIT across chunks does not leak garbage', () => {
	// chunk 1 ends mid-escape; stripping it alone would emit the bare "[31m"
	const first = stripAnsiStreaming('', 'src/a.ts:1:1: \u001b[31');
	assert.equal(first.text, 'src/a.ts:1:1: ', 'the partial escape must be held back');
	assert.equal(first.pending, '\u001b[31');

	const second = stripAnsiStreaming(first.pending, 'm oops\n');
	assert.equal(second.text, ' oops\n', 'the completed escape is stripped, not printed');
	assert.equal(second.pending, '');

	assert.equal(first.text + second.text, 'src/a.ts:1:1:  oops\n');
});

test('stripAnsiStreaming: a split at the ESC byte itself is handled', () => {
	const first = stripAnsiStreaming('', 'plain\u001b');
	assert.equal(first.text, 'plain');
	assert.equal(first.pending, '\u001b');
	const second = stripAnsiStreaming(first.pending, '[0mmore');
	assert.equal(second.text, 'more');
});

test('stripAnsiStreaming: text with no escapes passes straight through', () => {
	const result = stripAnsiStreaming('', 'just output\n');
	assert.deepEqual(result, { text: 'just output\n', pending: '' });
});

test('stripAnsiStreaming: a lone ESC in binary junk does not stall the stream forever', () => {
	// 33 bytes of tail is past the cap, so it is emitted as data rather than held
	const junk = '\u001b' + 'x'.repeat(40);
	const result = stripAnsiStreaming('', junk);
	assert.equal(result.pending, '', 'the stream must not stall waiting for a terminator');
	assert.ok(result.text.length > 0);
});

test('stripAnsiStreaming: an OSC sequence split across chunks is held then stripped', () => {
	const first = stripAnsiStreaming('', 'a\u001b]0;ti');
	assert.equal(first.text, 'a');
	const second = stripAnsiStreaming(first.pending, 'tle\u0007b');
	assert.equal(second.text, 'b');
});
