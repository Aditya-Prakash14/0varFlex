// src/common/platform/instantiation/common/descriptors.ts
// — ported from vs/platform/instantiation/common/descriptors.ts
//
// shortcut: sync-only DI. supportsDelayedInstantiation is kept as a marker (and rejected by
// the sync-only InstantiationService) — upgrade if async services are ever needed in code.

export class SyncDescriptor<T> {

	readonly ctor: any;
	readonly staticArguments: unknown[];
	readonly supportsDelayedInstantiation: boolean;

	constructor(ctor: new (...args: any[]) => T, staticArguments: unknown[] = [], supportsDelayedInstantiation: boolean = false) {
		this.ctor = ctor;
		this.staticArguments = staticArguments;
		this.supportsDelayedInstantiation = supportsDelayedInstantiation;
	}
}

export interface SyncDescriptor0<T> {
	readonly ctor: new () => T;
}
