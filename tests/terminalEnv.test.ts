// The pty env curation (13): the host's injected vars must not leak into the user's shell,
// TERM* gets stamped, PATH survives byte-for-byte — and the exit banner is the real formatter.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	formatMessageForTerminal,
	resolveDefaultShell,
	sanitizePtyEnv
} from '../src/common/platform/terminal/common/terminal.js';

test('sanitizePtyEnv drops the host’s injections and stamps TERM*', () => {
	const env = sanitizePtyEnv({
		PATH: '/usr/local/bin:/usr/bin:/bin',
		HOME: '/Users/someone',
		SHELL: '/bin/zsh',
		NODE_OPTIONS: '--max-old-space-size=4096',
		ELECTRON_RUN_AS_NODE: '1',
		ELECTRON_ENABLE_LOGGING: '1',
		MINI_VSCODE_VERSION: '0.0.1',
		TERM: undefined
	}, '9.9.9');

	assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin', 'PATH stays verbatim');
	assert.equal(env.HOME, '/Users/someone');
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
	assert.equal(env.ELECTRON_ENABLE_LOGGING, undefined);
	assert.equal(env.MINI_VSCODE_VERSION, undefined);
	assert.equal(env.TERM_PROGRAM, 'mini-vscode');
	assert.equal(env.TERM_PROGRAM_VERSION, '9.9.9');
	assert.equal(env.TERM, 'xterm-256color');
});

test('sanitizePtyEnv keeps an existing TERM', () => {
	const env = sanitizePtyEnv({ TERM: 'screen-256color' }, '1.0.0');
	assert.equal(env.TERM, 'screen-256color');
});

test('resolveDefaultShell uses $SHELL and falls back sanely', () => {
	assert.equal(resolveDefaultShell({ SHELL: '/bin/bash' }), '/bin/bash');
	assert.equal(resolveDefaultShell({ SHELL: '' }), process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/zsh');
	assert.equal(resolveDefaultShell({}), process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/zsh');
});

test('formatMessageForTerminal is the ported " * message " banner', () => {
	const formatted = formatMessageForTerminal('[exited with code 0]');
	assert.ok(formatted.startsWith('\r\n'));
	assert.ok(formatted.includes('\x1b[7m * '));
	assert.ok(formatted.includes('[exited with code 0]'));
	assert.ok(formatted.endsWith('\x1b[0m\n\r'));

	const inline = formatMessageForTerminal('x', { excludeLeadingNewLine: true });
	assert.ok(!inline.startsWith('\r\n'));
});
