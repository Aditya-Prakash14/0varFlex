// src/renderer/workbench/services/extensions/extensionRegistries.ts — contributions register in
// the workbench BEFORE any activation (the exercise's load-bearing rule): commands become
// palette metadata + activating stubs, keybindings land in 05's registry at extension weight,
// configuration lands in 06's registry, languages in the language service.
//
// Ported from the reference's workbench-side registration (AbstractExtensionService
// _doHandleExtensionPoints): commands get the manifest title/category, keybindings are parsed
// with the same parser user keybindings use, configuration accepts BOTH manifest shapes.

import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import type { ILogService } from '../../../../common/platform/log/common/log.js';
import type { IExtensionConfigurationContribution } from '../../../../common/platform/extensions/common/extensions.js';
import type { IScannedExtension } from '../../../../common/platform/extensions/common/extensionScanner.js';
import { CommandMetadata } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { parseKeybinding } from '../../../platform/keybinding/common/keybindingParser.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ConfigurationRegistry } from '../../../../common/platform/configuration/common/configurationRegistry.js';
import type { LanguageService } from '../languages/common/languageService.js';
import type { ExtensionService } from './extensionService.js';

export interface IExtensionRegistryServices {
	readonly extensionService: ExtensionService;
	readonly languageService: LanguageService;
	readonly logService: ILogService;
}

export function registerExtensionContributions(extensions: readonly IScannedExtension[], services: IExtensionRegistryServices): IDisposable {
	const disposables: IDisposable[] = [];

	for (const { description } of extensions) {
		const contributes = description.contributes;
		const source = description.identifier;

		// commands: a stub that activates the owning extension and dispatches into the host
		for (const command of contributes.commands ?? []) {
			services.extensionService.ensureExtensionCommand(command.command);
			disposables.push(CommandMetadata.register({
				id: command.command,
				title: command.title,
				category: command.category ?? description.displayId
			}));
		}

		// keybindings: parsed by the same parser the user file uses; extension weight
		for (const keybinding of contributes.keybindings ?? []) {
			const primary = keybinding.key ? parseKeybinding(keybinding.key) : null;
			const mac = keybinding.mac ? parseKeybinding(keybinding.mac) : null;
			if (!primary && !mac) {
				services.logService.warn(`[${source}] keybinding for '${keybinding.command}' has no parsable key; ignored`);
				continue;
			}
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id: keybinding.command,
				// extra files notch: extension keybindings outrank workbench defaults
				weight: KeybindingWeight.ExternalExtension,
				when: keybinding.when ? ContextKeyExpr.deserialize(keybinding.when) ?? undefined : undefined,
				primary: primary ?? undefined,
				mac: mac ?? undefined
			}));
		}

		// configuration: the manifest carries full dotted keys (real extensions do too — the
		// exercise's "prefix by extension id" hint does not match the reference: no prefixing)
		const configurationContributions = normalizeConfiguration(contributes.configuration);
		for (const contribution of configurationContributions) {
			disposables.push(ConfigurationRegistry.registerConfiguration({
				id: source,
				title: contribution.title ?? description.displayId,
				properties: contribution.properties as never
			}));
		}

		// languages: id → file extensions (12's highlighting + the status bar consume this)
		for (const language of contributes.languages ?? []) {
			services.languageService.registerLanguage(language, source);
		}
	}

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}

function normalizeConfiguration(configuration: IExtensionConfigurationContribution | readonly IExtensionConfigurationContribution[] | undefined): readonly IExtensionConfigurationContribution[] {
	if (!configuration) {
		return [];
	}
	return Array.isArray(configuration) ? configuration : [configuration as IExtensionConfigurationContribution];
}
