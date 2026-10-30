// Offset fuzz: getPositionAt ↔ getOffsetAt must round-trip on every offset of messy corpora —
// this catches every off-by-one class of bug before the UI exists to confuse you.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TextModel } from '../src/common/editor/common/model/textModel.js';

// deterministic PRNG so failures reproduce
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TOKENS = ['const', 'let', 'x', 'y_2', 'é', '😀', '中文', '\t', '  ', '{', '}', '();', '// c', 'a-b'];

function buildCorpus(random: () => number, targetLength: number, pickEol: () => string): string {
	let result = '';
	while (result.length < targetLength) {
		const token = TOKENS[Math.floor(random() * TOKENS.length)];
		result += token;
		if (random() < 0.2) {
			result += pickEol();
			// trailing spaces are a real class of offset bugs
			if (random() < 0.3) {
				result += ' ';
			}
		} else {
			result += ' ';
		}
	}
	return result;
}

function fuzzOffsets(model: TextModel, canonicalValue: string, eol: string, seed: number, iterations: number): void {
	const random = mulberry32(seed);
	for (let i = 0; i < iterations; i++) {
		const offset = Math.floor(random() * (canonicalValue.length + 1));

		// offsets between the \r and \n of a CRLF pair are not distinguishable from the line end
		// in the position representation (true in the reference too) — skip that interior slot
		if (offset > 0 && canonicalValue.charCodeAt(offset - 1) === 13 && canonicalValue.charCodeAt(offset) === 10) {
			continue;
		}

		const position = model.getPositionAt(offset);
		assert.equal(model.getOffsetAt(position), offset, `offset ${offset} must round-trip (got ${position})`);

		// manual computation in code units
		const prefix = canonicalValue.slice(0, offset);
		const lines = prefix.split(eol);
		assert.equal(position.lineNumber, lines.length, `line for offset ${offset}`);
		assert.equal(position.column, lines[lines.length - 1].length + 1, `column for offset ${offset}`);
	}
}

test('offset fuzz: LF corpus', () => {
	const random = mulberry32(1);
	const text = buildCorpus(random, 5000, () => '\n');
	const model = new TextModel(text);
	assert.equal(model.getEOL(), '\n');
	fuzzOffsets(model, model.getValue(), '\n', 2, 500);
});

test('offset fuzz: CRLF corpus', () => {
	const random = mulberry32(3);
	const text = buildCorpus(random, 5000, () => '\r\n');
	const model = new TextModel(text);
	assert.equal(model.getEOL(), '\r\n');
	fuzzOffsets(model, model.getValue(), '\r\n', 4, 500);
});

test('offset fuzz: mixed EOL corpus (coalesced to first EOL)', () => {
	const random = mulberry32(5);
	const mixedEols = ['\n', '\r\n', '\r'];
	const text = buildCorpus(random, 5000, () => mixedEols[Math.floor(random() * mixedEols.length)]);
	const model = new TextModel(text);

	// shortcut: mixed files coalesce to the first-seen EOL — fuzz against the canonical value
	fuzzOffsets(model, model.getValue(), model.getEOL(), 6, 500);
});

test('offset fuzz: after many random edits, offsets stay consistent', () => {
	const random = mulberry32(7);
	let model = new TextModel(buildCorpus(random, 500, () => '\n'));

	for (let i = 0; i < 100; i++) {
		const value = model.getValue();
		if (value.length === 0) {
			break;
		}
		const start = Math.floor(random() * value.length);
		const end = Math.min(value.length, start + Math.floor(random() * 20));
		const range = model.getPositionAt(start);
		const rangeEnd = model.getPositionAt(end);
		const inserted = random() < 0.5 ? 'Xy\n' : '';
		model.pushEditOperations(null, [{ range: new (model.getFullModelRange().constructor as typeof import('../src/common/editor/common/core/range.js').Range)(range.lineNumber, range.column, rangeEnd.lineNumber, rangeEnd.column), text: inserted }], () => null);
	}

	const value = model.getValue();
	fuzzOffsets(model, value, model.getEOL(), 8, 300);
});
