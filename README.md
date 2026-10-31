# mini-vscode

A miniature VS Code built from scratch (Electron + TypeScript), porting structure and behavior
from a local VS Code reference tree, exercise by exercise. See `git log` for the progression
(instantiation → IPC → shell → commands → keybindings → configuration/storage → text model →
editor view).

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
