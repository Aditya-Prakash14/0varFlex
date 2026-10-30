// src/common/base/common/uri.ts — ported from vs/base/common/uri.ts (which is generated from the
// vscode-uri package). File scheme only for now; http/untitled/... arrive when needed.
// Skipped upstream: revive/toJSON/marshalling, the caching URI subclass, isUri/from.

export interface UriComponents {
	scheme: string;
	authority?: string;
	path?: string;
	query?: string;
	fragment?: string;
}

const _empty = '';
const _slash = '/';
const _regexp = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;
const _schemePattern = /^\w[\w\d+.-]*$/;
const _singleSlashStart = /^\//;
const _doubleSlashStart = /^\/\//;

const isWindows = (typeof process !== 'undefined' && process.platform === 'win32')
	|| (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent));

// minimal subset of vs/base/common/charCode.ts
const CharCode = {
	Space: 32, ExclamationMark: 33, Hash: 35, DollarSign: 36, Ampersand: 38,
	SingleQuote: 39, OpenParen: 40, CloseParen: 41, Asterisk: 42, Plus: 43,
	Comma: 44, Dash: 45, Period: 46, Slash: 47, Digit0: 48, Digit9: 57,
	Colon: 58, Semicolon: 59, Equals: 61, QuestionMark: 63, AtSign: 64,
	A: 65, Z: 90, OpenSquareBracket: 91, CloseSquareBracket: 93, Underline: 95,
	a: 97, z: 122, Tilde: 126
} as const;

function _validateUri(ret: URI, _strict?: boolean): void {

	// scheme, must be set
	if (!ret.scheme && _strict) {
		throw new Error(`[UriError]: Scheme is missing: {scheme: "", authority: "${ret.authority}", path: "${ret.path}", query: "${ret.query}", fragment: "${ret.fragment}"}`);
	}

	// scheme, https://tools.ietf.org/html/rfc3986#section-3.1
	// ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
	if (ret.scheme && !_schemePattern.test(ret.scheme)) {
		throw new Error('[UriError]: Scheme contains illegal characters.');
	}

	// path, http://tools.ietf.org/html/rfc3986#section-3.3
	// If a URI contains an authority component, then the path component
	// must either be empty or begin with a slash ("/") character. If a URI
	// does not contain an authority component, then the path cannot begin
	// with two slash characters ("//").
	if (ret.path) {
		if (ret.authority) {
			if (!_singleSlashStart.test(ret.path)) {
				throw new Error('[UriError]: If a URI contains an authority component, then the path component must either be empty or begin with a slash ("/") character');
			}
		} else {
			if (_doubleSlashStart.test(ret.path)) {
				throw new Error('[UriError]: If a URI does not contain an authority component, then the path cannot begin with two slash characters ("//")');
			}
		}
	}
}

// a uri without scheme and without strict-mode falls back to the file-scheme
function _schemeFix(scheme: string, _strict: boolean): string {
	if (!scheme && !_strict) {
		return 'file';
	}
	return scheme;
}

// implements a bit of https://tools.ietf.org/html/rfc3986#section-5
function _referenceResolution(scheme: string, path: string): string {

	// the slash-character is our 'default base' as we don't
	// support constructing URIs relative to other URIs
	switch (scheme) {
		case 'https':
		case 'http':
		case 'file':
			if (!path) {
				path = _slash;
			} else if (path[0] !== _slash) {
				path = _slash + path;
			}
			break;
	}
	return path;
}

/**
 * Uniform Resource Identifier (URI) http://tools.ietf.org/html/rfc3986.
 * This class is a simple parser which creates the basic component parts
 * (http://tools.ietf.org/html/rfc3986#section-3) with minimal validation
 * and encoding.
 */
export class URI implements UriComponents {

	/**
	 * scheme is the 'http' part of 'http://www.example.com/some/path?query#fragment'.
	 * The part before the first colon.
	 */
	readonly scheme: string;

	/**
	 * authority is the 'www.example.com' part of 'http://www.example.com/some/path?query#fragment'.
	 * The part between the first double slashes and the next slash.
	 */
	readonly authority: string;

	/**
	 * path is the '/some/path' part of 'http://www.example.com/some/path?query#fragment'.
	 */
	readonly path: string;

	/**
	 * query is the 'query' part of 'http://www.example.com/some/path?query#fragment'.
	 */
	readonly query: string;

	/**
	 * fragment is the 'fragment' part of 'http://www.example.com/some/path?query#fragment'.
	 */
	readonly fragment: string;

	protected constructor(schemeOrData: string | UriComponents, authority?: string, path?: string, query?: string, fragment?: string, _strict: boolean = false) {

		if (typeof schemeOrData === 'object') {
			this.scheme = schemeOrData.scheme || _empty;
			this.authority = schemeOrData.authority || _empty;
			this.path = schemeOrData.path || _empty;
			this.query = schemeOrData.query || _empty;
			this.fragment = schemeOrData.fragment || _empty;
		} else {
			this.scheme = _schemeFix(schemeOrData, _strict);
			this.authority = authority || _empty;
			this.path = _referenceResolution(this.scheme, path || _empty);
			this.query = query || _empty;
			this.fragment = fragment || _empty;

			_validateUri(this, _strict);
		}
	}

	/**
	 * Returns a string representing the corresponding file system path of this URI.
	 * Will handle UNC paths, normalizes windows drive letters to lower-case, and uses the
	 * platform specific path separator.
	 */
	get fsPath(): string {
		return uriToFsPath(this, false);
	}

	/**
	 * Derive a new URI from this URI, overriding individual components.
	 */
	with(change: { scheme?: string; authority?: string | null; path?: string | null; query?: string | null; fragment?: string | null }): URI {

		if (!change) {
			return this;
		}

		let { scheme, authority, path, query, fragment } = change;
		if (scheme === undefined) {
			scheme = this.scheme;
		} else if (scheme === null) {
			scheme = _empty;
		}
		if (authority === undefined) {
			authority = this.authority;
		} else if (authority === null) {
			authority = _empty;
		}
		if (path === undefined) {
			path = this.path;
		} else if (path === null) {
			path = _empty;
		}
		if (query === undefined) {
			query = this.query;
		} else if (query === null) {
			query = _empty;
		}
		if (fragment === undefined) {
			fragment = this.fragment;
		} else if (fragment === null) {
			fragment = _empty;
		}

		if (scheme === this.scheme
			&& authority === this.authority
			&& path === this.path
			&& query === this.query
			&& fragment === this.fragment) {

			return this;
		}

		return new URI(scheme, authority, path, query, fragment);
	}

	/**
	 * Creates a new URI from a string, e.g. `http://www.example.com/some/path`,
	 * `file:///usr/home`, or `scheme:with/path`.
	 */
	static parse(value: string, _strict: boolean = false): URI {
		const match = _regexp.exec(value);
		if (!match) {
			return new URI(_empty, _empty, _empty, _empty, _empty);
		}
		return new URI(
			match[2] || _empty,
			percentDecode(match[4] || _empty),
			percentDecode(match[5] || _empty),
			percentDecode(match[7] || _empty),
			percentDecode(match[9] || _empty),
			_strict
		);
	}

	/**
	 * Creates a new URI from a file system path, e.g. `c:\my\files`, `/usr/home`,
	 * or `\\server\share\some\path`.
	 *
	 * The *difference* between `URI#parse` and `URI#file` is that the latter treats the argument
	 * as path, not as stringified-uri: a path might contain characters that are interpreted by
	 * `URI#parse` (# and ?).
	 */
	static file(path: string): URI {

		let authority = _empty;

		// normalize to fwd-slashes on windows,
		// on other systems bwd-slashes are valid
		// filename character, eg /f\oo/ba\r.txt
		if (isWindows) {
			path = path.replace(/\\/g, _slash);
		}

		// check for authority as used in UNC shares
		// or use the path as given
		if (path[0] === _slash && path[1] === _slash) {
			const idx = path.indexOf(_slash, 2);
			if (idx === -1) {
				authority = path.substring(2);
				path = _slash;
			} else {
				authority = path.substring(2, idx);
				path = path.substring(idx) || _slash;
			}
		}

		return new URI('file', authority, path, _empty, _empty);
	}

	/**
	 * Join a URI path with path fragments and normalizes the resulting path.
	 */
	static joinPath(uri: URI, ...pathFragment: string[]): URI {
		if (!uri.path) {
			throw new Error(`[UriError]: cannot call joinPath on URI without path: ${uri.toString()}`);
		}
		// upstream uses path.posix.join (or path.win32.join for file-uris on windows)
		const newPath = _posixJoin(uri.path, pathFragment);
		return uri.with({ path: newPath });
	}

	/**
	 * Creates a string representation for this URI. It's guaranteed that calling
	 * `URI.parse` with the result of this function creates an URI which is equal
	 * to this URI.
	 *
	 * @param skipEncoding Do not encode the result, default is `false`
	 */
	toString(skipEncoding: boolean = false): string {
		return _asFormatted(this, skipEncoding);
	}
}

// --- path joining (a minimal path.posix.join/normalize) ---

function _posixJoin(base: string, fragments: string[]): string {
	return _posixNormalize([base, ...fragments].filter(s => s.length > 0).join(_slash));
}

function _posixNormalize(path: string): string {
	if (path === _empty) {
		return '.';
	}
	const isAbsolute = path.charCodeAt(0) === CharCode.Slash;
	const trailingSeparator = path.charCodeAt(path.length - 1) === CharCode.Slash;

	const segments: string[] = [];
	for (const segment of path.split(_slash)) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length > 0 && segments[segments.length - 1] !== '..') {
				segments.pop();
			} else if (!isAbsolute) {
				segments.push('..');
			}
		} else {
			segments.push(segment);
		}
	}

	let normalized = segments.join(_slash);
	if (isAbsolute) {
		normalized = _slash + normalized;
	}
	if (trailingSeparator && normalized !== _slash) {
		normalized += _slash;
	}
	if (!normalized) {
		normalized = isAbsolute ? _slash : '.';
	}
	return normalized;
}

/**
 * Compute `fsPath` for the given uri
 */
export function uriToFsPath(uri: URI, keepDriveLetterCasing: boolean): string {

	let value: string;
	if (uri.authority && uri.path.length > 1 && uri.scheme === 'file') {
		// unc path: file://shares/c$/far/boo
		value = `//${uri.authority}${uri.path}`;
	} else if (
		uri.path.charCodeAt(0) === CharCode.Slash
		&& (uri.path.charCodeAt(1) >= CharCode.A && uri.path.charCodeAt(1) <= CharCode.Z || uri.path.charCodeAt(1) >= CharCode.a && uri.path.charCodeAt(1) <= CharCode.z)
		&& uri.path.charCodeAt(2) === CharCode.Colon
	) {
		if (!keepDriveLetterCasing) {
			// windows drive letter: file:///c:/far/boo
			value = uri.path[1].toLowerCase() + uri.path.substring(2);
		} else {
			value = uri.path.substring(1);
		}
	} else {
		// other path
		value = uri.path;
	}
	if (isWindows) {
		value = value.replace(/\//g, '\\');
	}
	return value;
}

/**
 * Create the external version of a uri
 */
function _asFormatted(uri: URI, skipEncoding: boolean): string {

	const encoder = !skipEncoding
		? encodeURIComponentFast
		: encodeURIComponentMinimal;

	let res = '';
	let { scheme, authority, path, query, fragment } = uri;
	if (scheme) {
		res += scheme;
		res += ':';
	}
	if (authority || scheme === 'file') {
		res += _slash;
		res += _slash;
	}
	if (authority) {
		let idx = authority.indexOf('@');
		if (idx !== -1) {
			// <user>@<auth>
			const userinfo = authority.substring(0, idx);
			authority = authority.substring(idx + 1);
			idx = userinfo.indexOf(':');
			if (idx === -1) {
				res += encoder(userinfo, false, false);
			} else {
				// <user>:<pass>@<auth>
				res += encoder(userinfo.substring(0, idx), false, false);
				res += ':';
				res += encoder(userinfo.substring(idx + 1), false, false);
			}
			res += '@';
		}
		authority = authority.toLowerCase();
		idx = authority.lastIndexOf(':');
		if (idx === -1) {
			res += encoder(authority, false, true);
		} else {
			// <auth>:<port>
			res += encoder(authority.substring(0, idx), false, true);
			res += authority.substring(idx);
		}
	}
	if (path) {
		// lower-case windows drive letters in /C:/fff or C:/fff
		if (path.length >= 3 && path.charCodeAt(0) === CharCode.Slash && path.charCodeAt(2) === CharCode.Colon) {
			const code = path.charCodeAt(1);
			if (code >= CharCode.A && code <= CharCode.Z) {
				path = `/${String.fromCharCode(code + 32)}:${path.substring(3)}`; // "/c:".length === 3
			}
		} else if (path.length >= 2 && path.charCodeAt(1) === CharCode.Colon) {
			const code = path.charCodeAt(0);
			if (code >= CharCode.A && code <= CharCode.Z) {
				path = `${String.fromCharCode(code + 32)}:${path.substring(2)}`; // "/c:".length === 3
			}
		}
		// encode the rest of the path
		res += encoder(path, true, false);
	}
	if (query) {
		res += '?';
		res += encoder(query, false, false);
	}
	if (fragment) {
		res += '#';
		res += !skipEncoding ? encodeURIComponentFast(fragment, false, false) : fragment;
	}
	return res;
}

// --- decode

function decodeURIComponentGraceful(str: string): string {
	try {
		return decodeURIComponent(str);
	} catch {
		if (str.length > 3) {
			return str.substring(0, 3) + decodeURIComponentGraceful(str.substring(3));
		} else {
			return str;
		}
	}
}

const _rEncodedAsHex = /(%[0-9A-Za-z][0-9A-Za-z])+/g;

function percentDecode(str: string): string {
	if (!str.match(_rEncodedAsHex)) {
		return str;
	}
	return str.replace(_rEncodedAsHex, (match) => decodeURIComponentGraceful(match));
}

// --- encode

// reserved characters: https://tools.ietf.org/html/rfc3986#section-2.2
const encodeTable: { [ch: number]: string } = {
	[CharCode.Colon]: '%3A', // gen-delims
	[CharCode.Slash]: '%2F',
	[CharCode.QuestionMark]: '%3F',
	[CharCode.Hash]: '%23',
	[CharCode.OpenSquareBracket]: '%5B',
	[CharCode.CloseSquareBracket]: '%5D',
	[CharCode.AtSign]: '%40',

	[CharCode.ExclamationMark]: '%21', // sub-delims
	[CharCode.DollarSign]: '%24',
	[CharCode.Ampersand]: '%26',
	[CharCode.SingleQuote]: '%27',
	[CharCode.OpenParen]: '%28',
	[CharCode.CloseParen]: '%29',
	[CharCode.Asterisk]: '%2A',
	[CharCode.Plus]: '%2B',
	[CharCode.Comma]: '%2C',
	[CharCode.Semicolon]: '%3B',
	[CharCode.Equals]: '%3D',

	[CharCode.Space]: '%20',
};

function encodeURIComponentFast(uriComponent: string, isPath: boolean, isAuthority: boolean): string {
	let res: string | undefined = undefined;
	let nativeEncodePos = -1;

	for (let pos = 0; pos < uriComponent.length; pos++) {
		const code = uriComponent.charCodeAt(pos);

		// unreserved characters: https://tools.ietf.org/html/rfc3986#section-2.3
		if (
			(code >= CharCode.a && code <= CharCode.z)
			|| (code >= CharCode.A && code <= CharCode.Z)
			|| (code >= CharCode.Digit0 && code <= CharCode.Digit9)
			|| code === CharCode.Dash
			|| code === CharCode.Period
			|| code === CharCode.Underline
			|| code === CharCode.Tilde
			|| (isPath && code === CharCode.Slash)
			|| (isAuthority && code === CharCode.OpenSquareBracket)
			|| (isAuthority && code === CharCode.CloseSquareBracket)
			|| (isAuthority && code === CharCode.Colon)
		) {
			// check if we are delaying native encode
			if (nativeEncodePos !== -1) {
				res += encodeURIComponent(uriComponent.substring(nativeEncodePos, pos));
				nativeEncodePos = -1;
			}
			// check if we write into a new string (by default we try to return the param)
			if (res !== undefined) {
				res += uriComponent.charAt(pos);
			}

		} else {
			// encoding needed, we need to allocate a new string
			if (res === undefined) {
				res = uriComponent.substring(0, pos);
			}

			// check with default table first
			const escaped = encodeTable[code];
			if (escaped !== undefined) {

				// check if we are delaying native encode
				if (nativeEncodePos !== -1) {
					res += encodeURIComponent(uriComponent.substring(nativeEncodePos, pos));
					nativeEncodePos = -1;
				}

				// append escaped variant to result
				res += escaped;

			} else if (nativeEncodePos === -1) {
				// use native encode only when needed
				nativeEncodePos = pos;
			}
		}
	}

	if (nativeEncodePos !== -1) {
		res += encodeURIComponent(uriComponent.substring(nativeEncodePos));
	}

	return res !== undefined ? res : uriComponent;
}

function encodeURIComponentMinimal(path: string): string {
	let pos = path.indexOf('?');
	const hashPos = path.indexOf('#');
	if (pos === -1 || (hashPos !== -1 && hashPos < pos)) {
		pos = hashPos;
	}
	if (pos === -1) {
		return path;
	}

	let res = path.substring(0, pos);
	let copyStart = pos;
	for (; pos < path.length; pos++) {
		const code = path.charCodeAt(pos);
		if (code === CharCode.Hash || code === CharCode.QuestionMark) {
			if (copyStart < pos) {
				res += path.substring(copyStart, pos);
			}
			res += encodeTable[code];
			copyStart = pos + 1;
		}
	}
	if (copyStart < path.length) {
		res += path.substring(copyStart);
	}
	return res;
}
