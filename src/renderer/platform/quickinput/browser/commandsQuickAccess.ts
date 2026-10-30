// src/renderer/platform/quickinput/browser/commandsQuickAccess.ts — the command palette
// provider, simplified from vs/platform/quickinput/browser/commandsQuickAccess.ts:
// metadata entries gated by `precondition` via the context service, MRU section on top,
// fuzzy scoring on the title when typing.
//
// shortcut: the scorer is a subsequence match with prefix/word-start/consecutive bonuses —
// upstream uses the full TF-IDF + fuzzyScore machinery (base/common/filters.ts).

import type { ILogService } from '../../../../common/platform/log/common/log.js';
import { CommandMetadata, ICommandMetadata, ICommandService } from '../../commands/common/commands.js';
import { IContextKeyService } from '../../contextkey/common/contextkey.js';
import { IQuickPickOptions, QuickInputController } from './quickInput.js';

export interface ICommandUsageStore {
	get<T>(key: string): T | undefined;
	set(key: string, value: unknown): void;
}

interface ICommandQuickPick {
	readonly metadata: ICommandMetadata;
}

const RECENTLY_USED_KEY = 'commands.recentlyUsed';
const MAX_RECENT = 10;

export class CommandsQuickAccessProvider {

	constructor(
		private readonly _quickInput: QuickInputController,
		private readonly _commandService: ICommandService,
		private readonly _contextKeyService: IContextKeyService,
		private readonly _usageStore: ICommandUsageStore,
		private readonly _logService: ILogService
	) { }

	async pick(): Promise<void> {
		const recentIds = this._usageStore.get<string[]>(RECENTLY_USED_KEY) ?? [];

		const options: IQuickPickOptions<ICommandQuickPick> = {
			placeholder: 'Type the name of a command to run',
			items: value => this._getPicks(value, recentIds),
			label: pick => pick.metadata.title,
			description: pick => pick.metadata.category
		};

		const picked = await this._quickInput.pick(options);
		if (!picked) {
			return;
		}

		// the picker is already hidden — VS Code executes after hide to avoid stale-context flicker
		this._recordRecentlyUsed(picked.metadata.id);
		await this._commandService.executeCommand(picked.metadata.id).catch(error => {
			this._logService.error(`command palette: ${(error as Error).message}`);
		});
	}

	private _getPicks(value: string, recentIds: string[]): ICommandQuickPick[] {
		// surfacing gate: preconditions hide commands from the palette — never from execution
		const available: ICommandQuickPick[] = CommandMetadata.all()
			.filter(metadata => this._contextKeyService.contextMatchesRules(metadata.precondition))
			.map(metadata => ({ metadata }));

		if (!value) {
			// most-recently-used on top, then the rest alphabetically
			const byId = new Map(available.map(pick => [pick.metadata.id, pick]));
			const recent = recentIds.map(id => byId.get(id)).filter((pick): pick is ICommandQuickPick => !!pick);
			const recentSet = new Set(recentIds);
			const rest = available
				.filter(pick => !recentSet.has(pick.metadata.id))
				.sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
			return [...recent, ...rest];
		}

		const scored: { pick: ICommandQuickPick; score: number }[] = [];
		for (const pick of available) {
			const score = fuzzyScore(pick.metadata.title, value);
			if (score !== undefined) {
				scored.push({ pick, score });
			}
		}
		scored.sort((a, b) => b.score - a.score || a.pick.metadata.title.localeCompare(b.pick.metadata.title));
		return scored.map(entry => entry.pick);
	}

	private _recordRecentlyUsed(id: string): void {
		const recentIds = this._usageStore.get<string[]>(RECENTLY_USED_KEY) ?? [];
		const updated = [id, ...recentIds.filter(recentId => recentId !== id)].slice(0, MAX_RECENT);
		this._usageStore.set(RECENTLY_USED_KEY, updated);
	}
}

/**
 * Simplified fuzzy score: a subsequence match with bonuses for a prefix match, matches at word
 * starts and consecutive characters; shorter titles win ties.
 */
export function fuzzyScore(target: string, query: string): number | undefined {
	const lowerTarget = target.toLowerCase();
	const lowerQuery = query.toLowerCase();

	let position = 0;
	let score = 0;
	let lastHit = -2;
	let firstHit = -1;

	for (const ch of lowerQuery) {
		const index = lowerTarget.indexOf(ch, position);
		if (index === -1) {
			return undefined;
		}
		if (firstHit === -1) {
			firstHit = index;
		}

		score += 1;
		if (index === 0) {
			score += 8;
		} else if (!/[a-z0-9]/.test(lowerTarget[index - 1])) {
			score += 4; // word start
		}
		if (index === lastHit + 1) {
			score += 2; // consecutive
		}

		lastHit = index;
		position = index + 1;
	}

	if (firstHit === 0) {
		score += 6;
	}
	return score * 1000 - target.length;
}
