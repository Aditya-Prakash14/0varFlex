// src/renderer/editor/browser/config.ts — the editor options reader, wired to 06's
// IConfigurationService (live reload included). Real keys and defaults from
// vs/editor/common/config/editorOptions.ts.

import { Emitter, Event } from '../../../common/base/common/event.js';
import { Disposable } from '../../../common/base/common/lifecycle.js';
import type { IConfigurationService } from '../../../common/platform/configuration/common/configuration.js';

export interface IEditorOptions {
	readonly fontSize: number;
	readonly tabSize: number;
	readonly lineNumbers: 'on' | 'off' | 'relative' | 'interval';
	readonly cursorBlinking: 'blink' | 'solid';
	readonly renderLineHighlight: 'line' | 'none';
	readonly fontFamily: string;
	readonly cursorWidth: number;
	readonly scrollBeyondLastLine: boolean;
}

export class EditorOptionsService extends Disposable {

	private readonly _onDidChangeOptions = this._register(new Emitter<void>());
	readonly onDidChangeOptions: Event<void> = this._onDidChangeOptions.event;

	constructor(private readonly _configuration: IConfigurationService) {
		super();
		this._register(_configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('editor')) {
				this._onDidChangeOptions.fire();
			}
		}));
	}

	getOptions(): IEditorOptions {
		return {
			fontSize: this._configuration.getValue<number>('editor.fontSize') ?? 14,
			tabSize: this._configuration.getValue<number>('editor.tabSize') ?? 4,
			lineNumbers: this._configuration.getValue<IEditorOptions['lineNumbers']>('editor.lineNumbers') ?? 'on',
			cursorBlinking: this._configuration.getValue<IEditorOptions['cursorBlinking']>('editor.cursorBlinking') ?? 'blink',
			renderLineHighlight: this._configuration.getValue<IEditorOptions['renderLineHighlight']>('editor.renderLineHighlight') ?? 'line',
			fontFamily: this._configuration.getValue<string>('editor.fontFamily') ?? '',
			cursorWidth: this._configuration.getValue<number>('editor.cursorWidth') ?? 2,
			scrollBeyondLastLine: this._configuration.getValue<boolean>('editor.scrollBeyondLastLine') ?? true
		};
	}
}
