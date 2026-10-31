// src/renderer/editor/contrib/suggest/suggest.ts — the suggest model's data shape and the
// filter, ported from vs/editor/contrib/suggest/browser/suggest.ts + filters.ts at 1%:
//
//   - `scoreItem`: subsequence match over filterText with a consecutive-run bonus; returns the
//     matched INDICES so the widget can bold them (the reference scores with scoreFuzzy and
//     carries `matchedRanges` the same way — delta: simpler scoring, no camel-hump bonus);
//   - `ISuggestItem` holds the resolved replace RANGE (the provider's textEdit-lite range or the
//     word-prefix range), exactly what accept needs.

import { Range } from '../../../../common/editor/common/core/range.js';
import { isWordCharacter } from '../../browser/core/wordHelper.js';

export const enum SuggestionTriggerKind {
	Invoke = 1,
	TriggerCharacter = 2,
	TriggerForIncompleteCompletions = 3
}

export interface ISuggestItem {
	readonly label: string;
	readonly kind: number;
	readonly detail?: string;
	readonly documentation?: string;
	readonly insertText: string;
	readonly filterText: string;
	readonly sortText: string;
	/** what accept replaces */
	readonly range: Range;
	/** the filter result (recomputed on every refilter) */
	score: number;
	matched: number[];
}

export interface IScoredFilter {
	readonly score: number;
	readonly matched: number[];
}

/**
 * subsequence match: every prefix char must occur in order; consecutive hits score higher so
 * `nam` prefers `name` over `n_a_m`. Case-insensitive.
 */
export function scoreItem(filterText: string, prefix: string): IScoredFilter | null {
	if (prefix.length === 0) {
		return { score: 1, matched: [] };
	}
	const text = filterText.toLowerCase();
	const needle = prefix.toLowerCase();
	const matched: number[] = [];
	let textIndex = 0;
	let score = 0;
	let consecutive = 0;

	for (const char of needle) {
		const found = text.indexOf(char, textIndex);
		if (found === -1) {
			return null;
		}
		if (found === textIndex && matched.length > 0) {
			consecutive++;
			score += 5 + consecutive;
		} else {
			consecutive = 0;
			score += 1;
			// prefer matches at word starts (the cheap version of the reference's bonuses)
			if (found === 0 || !isWordCharacter(text[found - 1])) {
				score += 3;
			}
		}
		matched.push(found);
		textIndex = found + 1;
	}
	// shorter labels win ties; earlier overall match wins
	return { score: score - filterText.length / 100, matched };
}

/** the word prefix in front of the cursor (column is 1-based; the text up to the cursor) */
export function wordPrefixAt(lineText: string, column: number): { prefix: string; startColumn: number } {
	let start = column - 1;
	while (start > 0 && isWordCharacter(lineText[start - 1])) {
		start--;
	}
	return { prefix: lineText.substring(start, column - 1), startColumn: start + 1 };
}
