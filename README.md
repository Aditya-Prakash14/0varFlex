# mini-vscode

A miniature VS Code built from scratch (Electron + TypeScript), porting structure and behavior
from a local VS Code reference tree, exercise by exercise. See `git log` for the progression
(instantiation → IPC → shell → commands → keybindings → configuration/storage → text model →
editor view → files/workspace → extensions → language features).

## Language features (12): LSP is an extension pattern

The workbench knows only *providers*; the LSP bridge lives in an extension:

- `extensions/toy-lang/` — a real client/server pair: `client/src/lsp-client.ts` speaks
  JSON-RPC over stdio with `Content-Length` **byte** framing, request ids, `$/cancelRequest`,
  stderr forwarding (`[toy-lang] server stderr:`) and a dispose that reaps the child. The server
  (`server/src/server.ts`) is built on the real `vscode-languageserver` package with a PURE
  grammar (`analysis.ts`) behind the handlers; `spawn(process.execPath, …, ELECTRON_RUN_AS_NODE=1)`
  is how the extension host runs it as plain node. The server also exits when its stdin closes
  (parent-death), so no zombies survive a reload or a window close.
- The provider SPI mirrors 11: `languages.registerCompletionItemProvider` /
  `registerHoverProvider` / `createDiagnosticCollection` → RPC → `MainThreadLanguageFeatures` →
  a `LanguageFeatureRegistry`-lite (exact languageId only — no glob/pattern selectors) → the
  editor consults it on demand. Superseded fetches are cancelled across the port (the host fires
  the provider's token; the toy client turns it into `$/cancelRequest`) and stale results are
  dropped by request generation + model-version recheck.
- `services/markers/` — the ported marker store: keyed by (resource, **owner**), so one
  provider's update never clears another's; an empty update removes the tuple; reads take the
  severity bit mask; `onMarkerChanged` reports the deduped resource set batched on a microtask.
- Editor contribs: suggest (trigger rules below), hover (300ms dwell, markdown-lite,
  `Hover.range` highlight, marker tooltips) and marker decorations (SVG-wave squiggles + gutter
  dots in the 08 overlay layers).
- Problems: the left status entry `⨯ N  ⚠ M` opens 04's quick pick over the marker service;
  picking opens the resource with the marker's **range** selected.

Deltas specific to 12:

- `editor.quickSuggestions` is effectively **off**: while the widget is closed only an explicit
  `Ctrl+Space` or a provider `triggerCharacter` (`=`, `[`, ` ` for toy-lang) opens it; word
  characters re-filter only while open. (The modern default is 'on'.)
- One provider is consulted per feature (no merging across providers), no docs side panel, no
  snippets/placeholder parsing, no preview mode or partial accept, no commit characters. The
  accept clamps the replacement range to the cursor on the item's line (a provider range
  extending past the cursor is truncated — revisit for mid-word ranges).
- Hover is a single plain panel (not interactive-with-scroll-into-editor), markdown-lite only
  (paragraphs, `` `code` ``, fences). `editor.suggest.maxVisibleSuggestions` no longer exists in
  the reference revision: the widget uses a fixed 8-row window with scrolling.
- Composition (IME) suppresses completion fetches; the composition path itself was not exercised
  live in the acceptance (only via the guard's code path).
- `toyLang.maxNumberOfProblems` (default 100) truncates server-side with a logged proof; the
  setting reaches the host because the configuration mirror now snapshots the configuration
  REGISTRY (extension-contributed keys included) instead of a hardcoded key list.

## Known deltas worth knowing before extending

- **Extensions**: no marketplace, install/update/disable UI, extension kinds, proposed APIs,
  menus/views contributions, telemetry or extension storage; a SINGLE extension host process per
  window (`utilityProcess`, the port transferred from main). `engines.mini-vscode` is the only
  accepted engine — pointing the scanner at `~/.vscode/extensions` parses the manifests and
  skips them gracefully (real extensions would die on the API gaps; this is by design).
- **Extension host internals**: the `vscode` module is injected by patching `Module._load`;
  console output is attributed by a "current extension" marker (the reference walks the call
  stack, which only works because its host files exist unbundled); documents sync FULL text with
  the reference's change DTO shape (so 12 can switch to deltas without API churn).
- **File stack**: one `file` provider (disk) running in main behind the `file` channel (02's
  hand-written `FileIOChannel` is retired); string-only content (no streams/VSBuffer), no UNC or
  network handling; deletes go to the OS trash with an `rm` fallback on volumes without one.
- **Watcher**: a single recursive `fs.watch` host (node supports recursion on macOS/Windows
  only), no `@parcel/watcher`-class native recursion and no correlation ids — a stale-delete
  guard covers the create-then-rename race; `excludes` are path-segment names, not globs.
- **External changes**: a clean editor reloads silently (cursor/scroll preserved); a dirty one
  gets a status-bar warning whose click reloads after a confirmation (real VS Code keeps your
  version and offers a compare).
- **Workspace**: a single folder, remembered by path in application storage (real: workspace
  storage keyed by folder hash), workspace settings in `<folder>/.mini/settings.json` (real:
  `.vscode/settings.json`); no hot-exit, so open editors do not survive a relaunch.
- **Explorer**: no multi-select, drag-drop move/copy, compact folders or icon themes; the inline
  input rejects `a/b` (real VS Code creates the intermediate folders).
- **Word wrap is not implemented.** Wrapped-line rendering is its own coordinate system (view
  lines vs model lines, wrapping columns, injected text) — it is deliberately out of scope. If
  wrapping is wanted later, porting `viewParts/lines/` wrapping calculations (the real
  `IViewModel` + `WrappedLine` model) is the first big port to do.
- Native scrollbars instead of the rendered scrollbar widget (`viewParts/editorScrollbar`), no
  smooth scrolling physics, no minimap, no folding, no multi-cursor.
- Editor tabs: no preview/italic tabs, no pinned tabs, no tab drag-reorder or drag between
  groups, no breadcrumbs; the editor groups live in a plain split view (no docking grid).
- No hot-exit/backups/autoSave and no untitled editors; saving is one write through the FileIO
  channel (see `textEditorInput.ts`).
- The tokenizer is a single scanner per line (`// shortcut:` in `src/renderer/editor/browser/tokenizer.ts`);
  TextMate/Monarch grammars are the upgrade path.
- Line buffer is a line array (not the piece tree); see `textBuffer.ts` notes.
