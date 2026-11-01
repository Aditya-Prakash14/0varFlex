// src/renderer/workbench/contrib/chat/browser/chatActions.ts — the Chat commands.
//
// Ids follow the real workbench's chat contribution where one exists, so muscle memory carries
// over: `workbench.action.chat.open` with ctrl/cmd+alt+i, plus the view id and a stop command.

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatViewFocusContext } from './chatView.js';
import type { ChatView } from './chatView.js';
import type { ChatService } from '../../../services/chat/browser/chatService.js';

export const CHAT_VIEW_ID = 'workbench.view.chat';
export const CHAT_OPEN_ID = 'workbench.action.chat.open';
export const CHAT_STOP_ID = 'workbench.action.chat.stop';
export const CHAT_NEW_ID = 'workbench.action.chat.newChat';

export interface IChatActionServices {
	readonly chatService: ChatService;
	getView(): ChatView;
	showChatView(): void;
}

export function registerChatActions(services: IChatActionServices): IDisposable {
	const disposables: IDisposable[] = [];

	const register = (id: string, title: string, handler: () => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => handler()));
		disposables.push(CommandMetadata.register({ id, title, category: 'Chat' }));
	};

	register(CHAT_VIEW_ID, 'Show Chat', () => {
		services.showChatView();
		services.getView().focusInput();
	});

	register(CHAT_OPEN_ID, 'Open Chat', () => {
		services.showChatView();
		services.getView().focusInput();
	});

	register(CHAT_STOP_ID, 'Stop the Agent', () => services.chatService.cancel());
	register(CHAT_NEW_ID, 'New Chat', () => {
		services.chatService.clear();
		services.showChatView();
		services.getView().focusInput();
	});

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: CHAT_OPEN_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI
	}));

	// Escape stops a running agent, but only while the chat has focus
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: CHAT_STOP_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: ChatViewFocusContext,
		primary: KeyCode.Escape
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
