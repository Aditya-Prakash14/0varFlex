# mini-vscode

A miniature VS Code built from scratch (Electron + TypeScript), porting structure and behavior
from a local VS Code reference tree, exercise by exercise. See `git log` for the progression
(instantiation → IPC → shell → commands → keybindings → configuration/storage → text model →
editor view).

## Known deltas worth knowing before extending

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
