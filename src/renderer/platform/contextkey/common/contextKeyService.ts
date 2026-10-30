// src/renderer/platform/contextkey/common/contextKeyService.ts — the scoped context key
// service. Simplified from vs/platform/contextkey/browser/contextKeyService.ts: explicit scope
// chain instead of DOM-attribute scopes.
//
// shortcut: cached expressions are invalidated when one of their keys() changed; upstream adds
// weak-ref GC bookkeeping for expressions nobody observes anymore.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable } from '../../../../common/base/common/lifecycle.js';
import { ContextKeyExpression, ContextKeyValue, IContext, IContextKey, IContextKeyChangeEvent, IContextKeyService } from './contextkey.js';

export class ContextKeyService extends Disposable implements IContextKeyService, IContext {

	declare readonly _serviceBrand: undefined;

	private readonly _context = new Map<string, ContextKeyValue>();
	private readonly _cachedExpressions = new Map<ContextKeyExpression, boolean>();
	private readonly _keys = new Map<string, IContextKey>();

	private readonly _onDidChangeContext = this._register(new Emitter<IContextKeyChangeEvent>());
	readonly onDidChangeContext: Event<IContextKeyChangeEvent> = this._onDidChangeContext.event;

	private _pendingKeys: Set<string> | undefined;
	private _scheduled = false;

	constructor(private readonly _parent?: ContextKeyService) {
		super();
	}

	createScoped(_target?: unknown): ContextKeyService {
		return new ContextKeyService(this);
	}

	createKey<T extends ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T> {
		const service = this;
		let keyImpl = this._keys.get(key);
		if (!keyImpl) {
			keyImpl = {
				set: (value: ContextKeyValue) => service._setValue(key, value),
				reset: () => service._removeValue(key),
				get: () => service.getContextKeyValue<T>(key) ?? defaultValue
			};
			this._keys.set(key, keyImpl);
		}
		return keyImpl as IContextKey<T>;
	}

	/** IContext implementation + public read path (scope chain: own scope first, then parents). */
	getValue<T = ContextKeyValue>(key: string): T | undefined {
		return this.getContextKeyValue<T>(key);
	}

	getContextKeyValue<T>(key: string): T | undefined {
		if (this._context.has(key)) {
			return this._context.get(key) as T;
		}
		return this._parent?.getContextKeyValue<T>(key);
	}

	contextMatchesRules(rules: ContextKeyExpression | undefined): boolean {
		if (!rules) {
			return true;
		}
		let cached = this._cachedExpressions.get(rules);
		if (cached === undefined) {
			cached = rules.evaluate(this);
			this._cachedExpressions.set(rules, cached);
		}
		return cached;
	}

	override dispose(): void {
		super.dispose();
		this._keys.clear();
	}

	private _setValue(key: string, value: ContextKeyValue): void {
		const existing = this._context.get(key);
		// same-value short-circuit: moving the panel fires panelVisible on every intermediate
		// drag step otherwise — only a boolean change counts
		if (existing === value) {
			return;
		}
		this._context.set(key, value);
		this._bufferChange(key);
	}

	private _removeValue(key: string): void {
		if (this._context.has(key)) {
			this._context.delete(key);
			this._bufferChange(key);
		}
	}

	private _bufferChange(key: string): void {
		this._pendingKeys ??= new Set();
		this._pendingKeys.add(key);
		if (this._scheduled) {
			return;
		}

		this._scheduled = true;
		queueMicrotask(() => {
			this._scheduled = false;
			const keys = this._pendingKeys!;
			this._pendingKeys = undefined;

			// re-evaluate lazily: only drop cached expressions affected by the changed keys
			for (const expr of [...this._cachedExpressions.keys()]) {
				if (expr.keys().some(k => keys.has(k))) {
					this._cachedExpressions.delete(expr);
				}
			}

			this._onDidChangeContext.fire({
				affectsSome: (candidateKeys: ReadonlySet<string>) => {
					for (const candidate of candidateKeys) {
						if (keys.has(candidate)) {
							return true;
						}
					}
					return false;
				}
			});
		});
	}
}
