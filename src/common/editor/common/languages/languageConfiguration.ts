// src/common/editor/common/languages/languageConfiguration.ts — what the editor needs to know
// about a language's syntax, ported in shape from vs/editor/common/languages/languageConfiguration.ts.
//
// Two consumers, which is why this is in `common` and not next to either of them:
//   - comment tokens, for the comment-toggle commands (a renderer contrib);
//   - bracket pairs and auto-closing pairs, for bracket matching (a contrib) and for the type
//     handler (the editor core, which is where the reference puts auto-closing too).
//
// shortcut: one built-in table keyed on file extension. The real thing loads
// `language-configuration.json` from `contributes.languages`, so an extension can define its own
// syntax; our manifests carry only id/aliases/extensions. Upgrade when an extension needs to
// bring a language we do not already know, or needs to override one of these.

export interface ICommentTokens {
	readonly line?: string;
	readonly blockStart?: string;
	readonly blockEnd?: string;
}

export interface IBracketPair {
	readonly open: string;
	readonly close: string;
}

export interface IAutoClosingPair extends IBracketPair {
	/**
	 * Auto-close only when the character after the cursor is one of these (or the line ends).
	 *
	 * This is the reference's `autoCloseBefore`, and it is what stops `(` from auto-closing when
	 * you type it in front of an existing word — `(foo` would otherwise become `()foo`.
	 */
	readonly autoCloseBefore: string;
}

export interface ILanguageConfiguration {
	readonly comments: ICommentTokens;
	readonly brackets: readonly IBracketPair[];
	readonly autoClosingPairs: readonly IAutoClosingPair[];
}

// the real defaults, copied from the reference's CharacterPairSupport. Quotes get the narrower
// set: typing `"` right before another quote should not nest a second pair.
const AUTOCLOSE_BEFORE_QUOTES = ';:.,=}])> \n\t';
const AUTOCLOSE_BEFORE_BRACKETS = '\'"`;:.,=}])> \n\t';

const STANDARD_BRACKETS: readonly IBracketPair[] = [
	{ open: '(', close: ')' },
	{ open: '[', close: ']' },
	{ open: '{', close: '}' }
];

function bracketsAutoClosing(brackets: readonly IBracketPair[]): IAutoClosingPair[] {
	return brackets.map(pair => ({ ...pair, autoCloseBefore: AUTOCLOSE_BEFORE_BRACKETS }));
}

function quotesAutoClosing(quotes: readonly string[]): IAutoClosingPair[] {
	return quotes.map(quote => ({ open: quote, close: quote, autoCloseBefore: AUTOCLOSE_BEFORE_QUOTES }));
}

const C_LIKE: ILanguageConfiguration = {
	comments: { line: '//', blockStart: '/*', blockEnd: '*/' },
	brackets: STANDARD_BRACKETS,
	autoClosingPairs: [...bracketsAutoClosing(STANDARD_BRACKETS), ...quotesAutoClosing(['"', "'", '`'])]
};

const HASH: ILanguageConfiguration = {
	comments: { line: '#' },
	brackets: STANDARD_BRACKETS,
	autoClosingPairs: [...bracketsAutoClosing(STANDARD_BRACKETS), ...quotesAutoClosing(['"', "'"])]
};

const CSS: ILanguageConfiguration = {
	// CSS has no line comment, so Ctrl+/ falls back to the block form
	comments: { blockStart: '/*', blockEnd: '*/' },
	brackets: STANDARD_BRACKETS,
	autoClosingPairs: [...bracketsAutoClosing(STANDARD_BRACKETS), ...quotesAutoClosing(['"', "'"])]
};

const MARKUP_BRACKETS: readonly IBracketPair[] = [...STANDARD_BRACKETS, { open: '<', close: '>' }];

const MARKUP: ILanguageConfiguration = {
	comments: { blockStart: '<!--', blockEnd: '-->' },
	brackets: MARKUP_BRACKETS,
	// `<` is matched and jumpable but not auto-closed: in markup it is far more often the start of
	// a tag being typed than a bracket wanting a partner
	autoClosingPairs: [...bracketsAutoClosing(STANDARD_BRACKETS), ...quotesAutoClosing(['"', "'"])]
};

const SQL_LIKE: ILanguageConfiguration = {
	comments: { line: '--', blockStart: '--[[', blockEnd: ']]' },
	brackets: STANDARD_BRACKETS,
	autoClosingPairs: [...bracketsAutoClosing(STANDARD_BRACKETS), ...quotesAutoClosing(['"', "'"])]
};

/** the configuration for a file, by extension */
export function languageConfigurationFor(path: string): ILanguageConfiguration {
	const match = /\.([A-Za-z0-9_]+)$/.exec(path);
	const extension = match ? match[1].toLowerCase() : '';

	switch (extension) {
		case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
		case 'json': case 'jsonc': case 'c': case 'h': case 'cpp': case 'hpp':
		case 'cs': case 'java': case 'go': case 'rs': case 'swift': case 'kt':
		case 'php': case 'scala': case 'dart': case 'proto':
			return C_LIKE;
		case 'css': case 'scss': case 'less':
			return CSS;
		case 'html': case 'xml': case 'svg': case 'vue': case 'md': case 'markdown':
			return MARKUP;
		case 'py': case 'sh': case 'bash': case 'zsh': case 'yml': case 'yaml':
		case 'toml': case 'ini': case 'cfg': case 'conf': case 'rb': case 'pl':
		case 'r': case 'gitignore': case 'dockerfile': case 'makefile':
			return HASH;
		case 'sql': case 'lua':
			return SQL_LIKE;
		default:
			// an unknown file is treated as C-like, which is wrong less often than refusing to
			// comment or to close a bracket at all
			return C_LIKE;
	}
}

/** comment tokens for a file — the comment-toggle commands' entry point */
export function commentTokensFor(path: string): ICommentTokens {
	return languageConfigurationFor(path).comments;
}
