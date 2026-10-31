// src/renderer/base/browser/dom.ts — the small DOM toolkit the shell needs.
// Ported from vs/base/browser/dom.ts (`$`, `append`, listeners, class helpers, Dimension);
// ElementSizeObserver is ported from vs/editor/browser/config/elementSizeObserver.ts,
// which is its home in this revision of the reference.

import { Emitter, Event } from '../../../common/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../common/base/common/lifecycle.js';

export interface IDimension {
	readonly width: number;
	readonly height: number;
}

export class Dimension implements IDimension {

	static readonly None = new Dimension(0, 0);

	constructor(readonly width: number, readonly height: number) { }

	with(width: number = this.width, height: number = this.height): Dimension {
		if (width !== this.width || height !== this.height) {
			return new Dimension(width, height);
		}
		return this;
	}
}

export function getWindow(element: HTMLElement | null | undefined): Window {
	return element?.ownerDocument.defaultView ?? window;
}

/**
 * Schedule a callback for the next animation frame. The returned disposable cancels it.
 * rAF NEVER fires in occluded windows (13's lesson — the size observer and every consumer
 * already rely on this scheduler): a 50ms timer backstops it, exactly like the view's render
 * scheduling in 08.
 */
export function scheduleAtNextAnimationFrame(targetWindow: Window, callback: () => void): IDisposable {
	let done = false;
	const run = (): void => {
		if (done) {
			return;
		}
		done = true;
		targetWindow.clearTimeout(timer);
		callback();
	};
	const handle = targetWindow.requestAnimationFrame(run);
	const timer = targetWindow.setTimeout(run, 50);
	return toDisposable(() => {
		done = true;
		targetWindow.cancelAnimationFrame(handle);
		targetWindow.clearTimeout(timer);
	});
}

/**
 * Adds a DOM event listener that is removed when the returned disposable is disposed.
 */
export function addDisposableListener(node: EventTarget, type: string, handler: (event: any) => void, useCaptureOrOptions?: boolean | AddEventListenerOptions): IDisposable {
	node.addEventListener(type, handler, useCaptureOrOptions);
	return toDisposable(() => node.removeEventListener(type, handler as EventListener, useCaptureOrOptions as any));
}

export function size(element: HTMLElement, width: number | null, height: number | null): void {
	if (typeof width === 'number') {
		element.style.width = `${width}px`;
	}
	if (typeof height === 'number') {
		element.style.height = `${height}px`;
	}
}

export function position(element: HTMLElement, top: number, left: number): void {
	element.style.top = `${top}px`;
	element.style.left = `${left}px`;
}

export function show(...elements: HTMLElement[]): void {
	for (const element of elements) {
		element.style.display = '';
		element.removeAttribute('aria-hidden');
	}
}

export function hide(...elements: HTMLElement[]): void {
	for (const element of elements) {
		element.style.display = 'none';
		element.setAttribute('aria-hidden', 'true');
	}
}

export function setVisibility(visible: boolean, ...elements: HTMLElement[]): void {
	if (visible) {
		show(...elements);
	} else {
		hide(...elements);
	}
}

export function addClass(element: HTMLElement, ...classes: string[]): void {
	element.classList.add(...classes);
}

export function removeClass(element: HTMLElement, ...classes: string[]): void {
	element.classList.remove(...classes);
}

export function toggleClass(element: HTMLElement, className: string, force?: boolean): boolean {
	return element.classList.toggle(className, force);
}

export function append<T extends Node>(parent: HTMLElement, child: T): T;
export function append<T extends Node>(parent: HTMLElement, ...children: (T | string)[]): void;
export function append<T extends Node>(parent: HTMLElement, ...children: (T | string)[]): T | void {
	children.forEach(child => {
		if (typeof child === 'string') {
			parent.appendChild(document.createTextNode(child));
		} else {
			parent.appendChild(child);
		}
	});

	// the single-child overload returns the child (upstream does exactly this)
	if (children.length === 1 && typeof children[0] !== 'string') {
		return children[0] as T;
	}
}

/**
 * Create an element: tag name, `.classes`, `#id` — e.g. `$('.part.titlebar')` or `$('div', { title: 'x' })`.
 */
export function $<T extends HTMLElement>(description: string, attrs?: { [key: string]: any }, ...children: Array<Node | string>): T {

	let tagName = 'div';
	const classes: string[] = [];
	let id: string | undefined;

	for (const part of description.split(/(?=[.#])/)) {
		if (part.startsWith('#')) {
			id = part.slice(1);
		} else if (part.startsWith('.')) {
			classes.push(part.slice(1));
		} else if (part) {
			tagName = part;
		}
	}

	const result = document.createElement(tagName) as unknown as T;
	if (id) {
		result.id = id;
	}
	if (classes.length > 0) {
		result.classList.add(...classes);
	}

	if (attrs) {
		Object.entries(attrs).forEach(([name, value]) => {
			if (typeof value === 'undefined') {
				return;
			}
			if (/^on\w+$/.test(name)) {
				(result as any)[name] = value;
			} else {
				result.setAttribute(name, value);
			}
		});
	}

	result.append(...children);

	return result;
}

/**
 * Observe the size of a DOM element with a `ResizeObserver` that reacts at most once
 * per animation frame — the debounce that stops layout thrash.
 */
export class ElementSizeObserver extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _referenceDomElement: HTMLElement | null;
	private _width: number;
	private _height: number;
	private _resizeObserver: ResizeObserver | null;

	constructor(referenceDomElement: HTMLElement | null, dimension?: IDimension) {
		super();
		this._referenceDomElement = referenceDomElement;
		this._width = -1;
		this._height = -1;
		this._resizeObserver = null;
		this.measureReferenceDomElement(false, dimension);
	}

	override dispose(): void {
		this.stopObserving();
		super.dispose();
	}

	getWidth(): number {
		return this._width;
	}

	getHeight(): number {
		return this._height;
	}

	startObserving(): void {
		if (!this._resizeObserver && this._referenceDomElement) {
			// We want to react to the resize observer only once per animation frame.
			// The first time the resize observer fires, we will react to it immediately.
			// Otherwise we will postpone to the next animation frame.
			let observedDimension: IDimension | null = null;

			const observeNow = () => {
				if (observedDimension) {
					this.observe({ width: observedDimension.width, height: observedDimension.height });
				} else {
					this.observe();
				}
			};

			let shouldObserve = false;
			let alreadyObservedThisAnimationFrame = false;

			const update = () => {
				if (shouldObserve && !alreadyObservedThisAnimationFrame) {
					try {
						shouldObserve = false;
						alreadyObservedThisAnimationFrame = true;
						observeNow();
					} finally {
						scheduleAtNextAnimationFrame(getWindow(this._referenceDomElement), () => {
							alreadyObservedThisAnimationFrame = false;
							update();
						});
					}
				}
			};

			this._resizeObserver = new ResizeObserver(entries => {
				if (entries && entries[0] && entries[0].contentRect) {
					observedDimension = { width: entries[0].contentRect.width, height: entries[0].contentRect.height };
				} else {
					observedDimension = null;
				}
				shouldObserve = true;
				update();
			});
			this._resizeObserver.observe(this._referenceDomElement);
		}
	}

	stopObserving(): void {
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = null;
		}
	}

	observe(dimension?: IDimension): void {
		this.measureReferenceDomElement(true, dimension);
	}

	private measureReferenceDomElement(emitEvent: boolean, dimension?: IDimension): void {
		let observedWidth = 0;
		let observedHeight = 0;
		if (dimension) {
			observedWidth = dimension.width;
			observedHeight = dimension.height;
		} else if (this._referenceDomElement) {
			observedWidth = this._referenceDomElement.clientWidth;
			observedHeight = this._referenceDomElement.clientHeight;
		}
		observedWidth = Math.max(5, observedWidth);
		observedHeight = Math.max(5, observedHeight);
		if (this._width !== observedWidth || this._height !== observedHeight) {
			this._width = observedWidth;
			this._height = observedHeight;
			if (emitEvent) {
				this._onDidChange.fire();
			}
		}
	}
}
