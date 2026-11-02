/*---------------------------------------------------------------------------------------------
 *  Declarations needed by the vendored VS Code files — NOT vendored code itself.
 *--------------------------------------------------------------------------------------------*/

// VS Code's build injects these globals; its own tsconfig declares them in a build-generated
// file we do not have. This is ADDITIVE: it declares the globals so the vendored `nls.ts`
// typechecks under this project's stricter settings, without editing a vendored file — which is
// the rule in README.md. They are undefined at runtime here, and nls.ts already copes: it falls
// back to the untranslated message, which is the only behaviour this project wants anyway.
declare global {
	// eslint-disable-next-line no-var
	var _VSCODE_NLS_MESSAGES: string[];
	// eslint-disable-next-line no-var
	var _VSCODE_NLS_LANGUAGE: string | undefined;
}

export { };
