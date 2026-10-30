// instantiation core — the acceptance tests for the DI container.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { _util, createDecorator } from '../src/common/platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../src/common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../src/common/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../src/common/platform/instantiation/common/descriptors.js';

test('decorated dependencies resolve; dependencies are created before dependents', () => {
	interface IOrderB { readonly _serviceBrand: undefined; }
	interface IOrderA { readonly _serviceBrand: undefined; }
	const IOrderB = createDecorator<IOrderB>('test.order.B');
	const IOrderA = createDecorator<IOrderA>('test.order.A');

	const creationOrder: string[] = [];
	class OrderB implements IOrderB {
		declare readonly _serviceBrand: undefined;
		constructor() { creationOrder.push('B'); }
	}
	class OrderA implements IOrderA {
		declare readonly _serviceBrand: undefined;
		constructor(@IOrderB readonly b: IOrderB) { creationOrder.push('A'); }
	}

	const instantiationService = new InstantiationService(new ServiceCollection(
		[IOrderA, new SyncDescriptor(OrderA)],
		[IOrderB, new SyncDescriptor(OrderB)],
	));

	instantiationService.invokeFunction(accessor => accessor.get(IOrderA));
	assert.deepEqual(creationOrder, ['B', 'A']);
});

test('services are created lazily on first use (and then cached)', () => {
	interface ILazyA { readonly _serviceBrand: undefined; }
	interface ILazyB { readonly _serviceBrand: undefined; }
	const ILazyA = createDecorator<ILazyA>('test.lazy.A');
	const ILazyB = createDecorator<ILazyB>('test.lazy.B');

	let aCreated = 0;
	let bCreated = 0;
	class LazyA implements ILazyA {
		declare readonly _serviceBrand: undefined;
		constructor() { aCreated++; }
	}
	class LazyB implements ILazyB {
		declare readonly _serviceBrand: undefined;
		constructor() { bCreated++; }
	}

	const instantiationService = new InstantiationService(new ServiceCollection(
		[ILazyA, new SyncDescriptor(LazyA)],
		[ILazyB, new SyncDescriptor(LazyB)],
	));

	assert.deepEqual([aCreated, bCreated], [0, 0]); // registering creates nothing

	instantiationService.invokeFunction(accessor => accessor.get(ILazyA));
	assert.deepEqual([aCreated, bCreated], [1, 0]); // B's constructor never ran

	instantiationService.invokeFunction(accessor => accessor.get(ILazyA));
	assert.equal(aCreated, 1); // ...and A is a singleton
});

test('cycles are detected and the error names the cycle', () => {
	interface ICycleA { readonly _serviceBrand: undefined; }
	interface ICycleB { readonly _serviceBrand: undefined; }
	const ICycleA = createDecorator<ICycleA>('test.cycle.A');
	const ICycleB = createDecorator<ICycleB>('test.cycle.B');

	class CycleA implements ICycleA {
		declare readonly _serviceBrand: undefined;
		constructor(@ICycleB readonly b: ICycleB) { }
	}
	class CycleB implements ICycleB {
		declare readonly _serviceBrand: undefined;
		constructor(@ICycleA readonly a: ICycleA) { }
	}

	const instantiationService = new InstantiationService(new ServiceCollection(
		[ICycleA, new SyncDescriptor(CycleA)],
		[ICycleB, new SyncDescriptor(CycleB)],
	));

	assert.throws(
		() => instantiationService.invokeFunction(accessor => accessor.get(ICycleA)),
		{ message: 'test.cycle.A -> test.cycle.B -> test.cycle.A' }
	);
});

test('createChild shadows parent services', () => {
	interface IShadow { readonly _serviceBrand: undefined; }
	const IShadow = createDecorator<IShadow>('test.shadow');

	class Original implements IShadow { declare readonly _serviceBrand: undefined; }
	class Replacement implements IShadow { declare readonly _serviceBrand: undefined; }

	const parent = new InstantiationService(new ServiceCollection([IShadow, new SyncDescriptor(Original)]));
	const child = parent.createChild(new ServiceCollection([IShadow, new SyncDescriptor(Replacement)]));

	assert.ok(parent.invokeFunction(accessor => accessor.get(IShadow)) instanceof Original);
	assert.ok(child.invokeFunction(accessor => accessor.get(IShadow)) instanceof Replacement);
});

test('disposing a child disposes child-created services only; parent stays intact', () => {
	const disposed: string[] = [];

	interface IParentService { readonly _serviceBrand: undefined; }
	interface IChildService { readonly _serviceBrand: undefined; }
	const IParentService = createDecorator<IParentService>('test.disp.parent');
	const IChildService = createDecorator<IChildService>('test.disp.child');

	class ParentService implements IParentService {
		declare readonly _serviceBrand: undefined;
		dispose() { disposed.push('parent'); }
	}
	class ChildService implements IChildService {
		declare readonly _serviceBrand: undefined;
		constructor(@IParentService readonly parent: IParentService) { }
		dispose() { disposed.push('child'); }
	}

	const parent = new InstantiationService(new ServiceCollection([IParentService, new SyncDescriptor(ParentService)]));
	const child = parent.createChild(new ServiceCollection([IChildService, new SyncDescriptor(ChildService)]));

	parent.invokeFunction(accessor => accessor.get(IParentService));
	child.invokeFunction(accessor => accessor.get(IChildService)); // resolves the parent's service too

	child.dispose();
	assert.deepEqual(disposed, ['child']); // parent-created service untouched

	parent.dispose();
	assert.deepEqual(disposed, ['child', 'parent']);
});

test('container-created services dispose in reverse creation order; passed-in instances are never disposed', () => {
	const disposed: string[] = [];

	interface IC1 { readonly _serviceBrand: undefined; }
	interface IC2 { readonly _serviceBrand: undefined; }
	interface IC3 { readonly _serviceBrand: undefined; }
	interface IPassedIn { readonly _serviceBrand: undefined; dispose(): void; }
	const IC1 = createDecorator<IC1>('test.dispose.C1');
	const IC2 = createDecorator<IC2>('test.dispose.C2');
	const IC3 = createDecorator<IC3>('test.dispose.C3');
	const IPassedIn = createDecorator<IPassedIn>('test.dispose.passedIn');

	class C1 implements IC1 { declare readonly _serviceBrand: undefined; dispose() { disposed.push('C1'); } }
	class C2 implements IC2 { declare readonly _serviceBrand: undefined; dispose() { disposed.push('C2'); } }
	class C3 implements IC3 { declare readonly _serviceBrand: undefined; dispose() { disposed.push('C3'); } }

	const passedIn: IPassedIn = { _serviceBrand: undefined, dispose() { disposed.push('passed-in'); } };

	const instantiationService = new InstantiationService(new ServiceCollection(
		[IC1, new SyncDescriptor(C1)],
		[IC2, new SyncDescriptor(C2)],
		[IC3, new SyncDescriptor(C3)],
		[IPassedIn, passedIn],
	));

	instantiationService.invokeFunction(accessor => accessor.get(IC1));
	instantiationService.invokeFunction(accessor => accessor.get(IC2));
	instantiationService.invokeFunction(accessor => accessor.get(IC3));
	assert.equal(instantiationService.invokeFunction(accessor => accessor.get(IPassedIn)), passedIn);

	instantiationService.dispose();
	assert.deepEqual(disposed, ['C3', 'C2', 'C1']);
});

test('createDecorator returns the same identifier for a duplicate id', () => {
	interface IDup { readonly _serviceBrand: undefined; }
	const first = createDecorator<IDup>('test.duplicate');
	const second = createDecorator<IDup>('test.duplicate');

	assert.equal(first, second);
	assert.equal(String(first), 'test.duplicate'); // toString is the service id
});

test('using a service identifier as a plain function throws the decorator-misuse error', () => {
	interface IMisuse { readonly _serviceBrand: undefined; }
	const id = createDecorator<IMisuse>('test.misuse');

	assert.throws(
		() => (id as unknown as (...args: unknown[]) => void)(),
		/@IServiceName-decorator can only be used to decorate a parameter/
	);
});

test('a subclass adding its own decorated params does not corrupt the base class metadata', () => {
	interface ISubA { readonly _serviceBrand: undefined; }
	interface ISubB { readonly _serviceBrand: undefined; }
	const ISubA = createDecorator<ISubA>('test.sub.A');
	const ISubB = createDecorator<ISubB>('test.sub.B');

	class Base {
		constructor(@ISubA readonly a: ISubA) { }
	}
	class Sub extends Base {
		constructor(@ISubA a: ISubA, @ISubB readonly b: ISubB) { super(a); }
	}

	const depsOf = (ctor: Function) =>
		_util.getServiceDependencies(ctor as unknown as _util.DI_TARGET_OBJ)
			.map(d => `${d.id}@${d.index}`)
			.sort();

	assert.deepEqual(depsOf(Base), ['test.sub.A@0']); // base metadata is intact...
	assert.deepEqual(depsOf(Sub), ['test.sub.A@0', 'test.sub.B@1']); // ...and Sub carries its own
});
