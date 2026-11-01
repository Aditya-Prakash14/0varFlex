# 0varflex — architecture map

What this is: the honest delta between this codebase and the one it was rebuilt from.

Reference paths are relative to the root of a `microsoft/vscode` checkout (on this machine:
`C:\Users\admin\Desktop\vscode`, `main` @ v1.145.0). Every reference path cited below was
verified to exist in that checkout.

Scale, for context: ~26k lines across `src/` + `extensions/`, against roughly 1.4M in `src/vs/`.

| Subsystem | Our files | Real VS Code | What the real one has beyond ours |
|---|---|---|---|
| Process model | `src/main/`, `src/extHost/`, `src/ptyHost/`, `src/preload/` | `src/vs/code/electron-main/`, `src/vs/workbench/api/node/`, `src/vs/platform/terminal/node/` | shared process, dedicated file-watcher process, web + remote server hosts, process explorer |
| DI | `src/common/platform/instantiation/` | `src/vs/platform/instantiation/` | async/delayed instantiation, tracing + profiling hooks, strict service collections |
| IPC | `src/common/base/parts/ipc/` | `src/vs/base/parts/ipc/` | three transports (Electron/Node/MessagePort), `PersistentProtocol` with reconnect + replay, `IURITransformer`, cross-process cancellation |
| Layout | `src/renderer/workbench/browser/parts/{titlebar,activitybar,sidebar,panel,editor,statusbar}/`, `src/renderer/base/browser/ui/splitview/` | `src/vs/workbench/browser/layout.ts`, `src/vs/workbench/browser/part.ts`, `src/vs/base/browser/ui/grid/` | real 2D grid docking with arbitrary nesting, zen + centered layout, multi-window, auxiliary bars |
| Commands / context | `src/renderer/platform/commands/`, `src/renderer/platform/contextkey/` | `src/vs/platform/commands/`, `src/vs/platform/contextkey/` | menu contributions (`MenuRegistry`/`MenuId`), `args` inside `when`, `key in valueKey` against real context values, submenus, `ResourceContextKey` |
| Keybindings | `src/renderer/platform/keybinding/` | `src/vs/platform/keybinding/`, `src/vs/base/common/keyCodes.ts` | keyboard-layout service, ScanCode/KeyCode split for layout independence, full IME handling, `-commandId` removal rules |
| Config / storage | `src/common/platform/configuration/`, `src/common/platform/storage/` | `src/vs/platform/configuration/`, `src/vs/platform/storage/` | settings UI, scopes beyond user/workspace (folder, language, machine), profiles, SQLite backend + migrations |
| Editor model | `src/common/editor/common/model/` | `src/vs/editor/common/model/` | piece tree buffer, snapshots, decorations interval tree, persisted token store, bracket-pair colorization |
| Editor view | `src/renderer/editor/browser/` | `src/vs/editor/browser/` | word wrap, folding, minimap, multi-cursor, find widget, custom scrollbar physics, view zones |
| Editor groups | `src/renderer/workbench/browser/parts/editor/`, `src/renderer/workbench/common/editor/` | same paths | preview tabs, tab drag + drop, breadcrumbs, hot-exit, side-by-side and diff editors |
| Files / watcher | `src/common/platform/files/`, `src/main/files/` | `src/vs/platform/files/` | many providers (remote, in-memory, user-data), request correlation, streaming read/write, glob patterns |
| Explorer | `src/renderer/workbench/contrib/files/` | `src/vs/workbench/contrib/files/` | multi-select, drag + drop, icon themes, compact folders, virtualized rendering at scale |
| Extensions | `src/extHost/`, `src/renderer/workbench/services/extensions/`, `src/renderer/workbench/api/common/` | `src/vs/workbench/api/`, `src/vs/workbench/services/extensions/` | marketplace + install flow, proposed-API gating, extension kinds (ui/workspace/web), remote ext host |
| Language features | `src/renderer/editor/contrib/{suggest,hover}/`, `src/renderer/workbench/services/markers/`, `extensions/toy-lang/` | `src/vs/editor/contrib/{suggest,hover}/`, `src/vs/platform/markers/`, `extensions/*-language-features/` | incremental document sync, semantic tokens, snippets, code actions, rename, glob document selectors |
| Terminal | `src/ptyHost/`, `src/main/terminal/`, `src/renderer/workbench/contrib/terminal/` | `src/vs/platform/terminal/`, `src/vs/workbench/contrib/terminal/` | shell integration + command decorations, reconnect and restore, profiles, image output, link detection |
| Packaging | `electron-builder.config.cjs`, `scripts/{dist,check-dist}.mjs`, `resources/` | `build/gulpfile.vscode*.js`, `resources/{darwin,linux,win32}/` | native module rebuilds, real signing + notarization, staged rollout, Windows/Linux installers |

---

## The five questions

### 1. Why does the workbench know nothing about Git, debugging, or LSP?

Because the dependency arrow only points one way: features depend on the workbench, and the
workbench depends on registries. Nothing under `src/renderer/workbench/` imports a feature by
name. Features get in through one of two seams.

In-process features self-register. `bootstrap.ts` calls `registerFileCommands`,
`registerProblemsView`, `registerTerminalActions`, `registerDefaultConfigurations` — each pushes
into `CommandsRegistry` / `KeybindingsRegistry` / `ConfigurationRegistry` rather than being called
by the part that eventually displays it. The status bar does not know who contributed an entry.

Out-of-process features cross the extension-host boundary and can only reach the core through the
narrow surface in `src/extHost/extHostApi.ts` — `registerCompletionItemProvider`,
`registerHoverProvider`, `createDiagnosticCollection` — which lands in
`src/renderer/workbench/api/common/mainThreadLanguageFeatures.ts`.

`extensions/toy-lang/` is the proof. It is a complete LSP client + server pair that the core has no
type for. Delete the folder and the workbench still compiles and runs; the squiggles and
completions simply stop existing. That is the point of the inversion — a feature being absent,
slow, or crashed is not a workbench concern.

### 2. Where exactly does a keystroke go from `KeyboardEvent` to a text buffer mutation?

There are **two** paths, and ordinary typing does not use the keybinding layer at all.

**Path A — the keystroke is a command.** `window` keydown, capture phase
([keybindingService.ts:51](../src/renderer/platform/keybinding/browser/keybindingService.ts#L51))
→ `_handleKeydown` → `eventToChord(e)` →
`KeybindingResolver.resolve(contextKeyService, _currentChords, chord)`. The resolution either
enters a chord (remember it, consume the key) or yields a command id, which runs through
`ICommandService` to its `CommandsRegistry` handler — e.g. the `tab` command at
[editorWidget.ts:730](../src/renderer/editor/browser/editorWidget.ts#L730), which calls
`widget.type('\t')`. Listening on keydown *only* is deliberate: on Windows a keyup can arrive
between the two keydowns of a chord, and clearing chord state there would silently reset it.

**Path B — the keystroke is text.** Editor focus lives in a hidden `<textarea>` kept positioned at
the caret cell ([editContext.ts](../src/renderer/editor/browser/controller/editContext.ts),
`setPosition`) — it sits at the cursor rather than at 0,0 so the OS anchors the IME candidate
window there. The browser turns the key into an `input` event
([editContext.ts:64](../src/renderer/editor/browser/controller/editContext.ts#L64)) → `_onInput`
reads `textarea.value` and **clears it synchronously before any await**, which is what stops fast
typing from dropping characters → `_host.type(text)`.

**Both paths converge on one edit funnel:**

`EditorWidget.type()` ([editorWidget.ts:216](../src/renderer/editor/browser/editorWidget.ts#L216))
→ `_pushEdit(selection, text)` → `model.pushEditOperations(before, [{ range, text }], cursorStateComputer)`
([editorWidget.ts:362](../src/renderer/editor/browser/editorWidget.ts#L362))
→ `TextModel.pushEditOperations` ([textModel.ts:184](../src/common/editor/common/model/textModel.ts#L184))
→ `_validateEditOperations` — throws on an out-of-range line/column, the trust boundary
→ `_applyValidatedEdits` → the line-array mutation in `textBuffer.ts`
→ `_increaseVersionId()` → `_fireChange(modelChanges)`, which is what the view re-renders off
→ `_editStack.pushChange(changes, beforeCursorState, afterCursorState, isEol)`.

The post-edit cursor state is not recorded by the controller; it is *computed from the inverse
operations* by the `cursorStateComputer` the widget passes in, so undo/redo restores the caret
verbatim instead of guessing where it should land.

IME folds into Path B. During composition every `input` is suppressed
([editContext.ts:92](../src/renderer/editor/browser/controller/editContext.ts#L92)) and the model is
not touched at all; on `compositionend` one commit runs bracketed by `pushStackElement()` on both
sides ([editorWidget.ts:216](../src/renderer/editor/browser/editorWidget.ts#L216)), so an entire
composition is exactly one undo unit. The trailing `input` the OS fires after `compositionend` is
deduped by state comparison rather than applied as a second edit.

Undo grouping itself is time- and content-based: consecutive edits merge while they keep arriving
within `CONTINUATION_TIME` (600ms, `editStack.ts:16`), and an edit whose old or new text crosses a
line break forces a new element (`isEol` at `textModel.ts:206`).

### 3. Why is `storage.get` synchronous while `storage.store` is effectively async?

Because the two have different correctness requirements.

`get` is a `Map` lookup against a cache hydrated once by `initialize()` over the IPC channel, so
memory is all it needs to be right. It *must* be sync because its callers are sync: the layout pass
reads part sizes and visibility while building the DOM and cannot await. Making `get` async would
force every layout consumer to become async and would insert a frame boundary into window-state
restore — you would watch the workbench assemble itself instead of seeing it appear.

`store` updates the cache immediately (so an immediately following `get` is read-your-writes
consistent), marks the key dirty, and debounces real persistence — 500ms by default — through the
channel to the main process, which owns the file. Writes are async because durability is I/O in
another process and no caller has a reason to block on it.

The debounce is only safe because of the flush path: `onWillSaveState` / `WillSaveStateReason`
drains dirty keys at shutdown. That is what stops the last 500ms of state from being lost at quit.

### 4. What breaks first at 10× the load, and which reference file solves it?

**The text buffer, decisively.** `src/common/editor/common/model/textBuffer.ts` is an array of line
strings. At 10× the 100k-line budget — a ~1M-line file — three costs arrive together: loading
materializes a million JS strings (GC pressure before a single keystroke); every edit splices that
array, so inserting one character near the top copies a million references; and `getValueInRange`
slices a *joined* value
([textBuffer.ts:108](../src/common/editor/common/model/textBuffer.ts#L108)), so a single range read
can allocate the whole document as one string. Offset↔position conversion is O(lines) whenever the
`PrefixSumComputer` is cold — and it is invalidated on every edit.

The reference answer is the piece tree: `src/vs/editor/common/model/pieceTreeTextBuffer/`
(`pieceTreeTextBuffer.ts` + `pieceTreeBase.ts`). It holds the original file as immutable chunks
referenced by a red-black tree of pieces, with line-start offsets cached per node, so an edit is an
O(log n) node split that copies no text and offsets come off subtree sums.

**Second to break** is the token/render cache. `tokenizer.ts` is a single stateless scanner, and
`viewLines.ts` caches tokens in the *layer*, which dies with it
([viewLines.ts:12](../src/renderer/editor/browser/layers/viewLines.ts#L12)) — so a large file
re-tokenizes its visible lines on every scroll and keeps nothing between views. Upstream's fix is
`src/vs/editor/common/model/textModelTokens.ts`, which persists tokens per line on the model across
view lifetimes.

### 5. Three seams where we changed an interface versus the reference

**(a) `IChannel.call` carries no `CancellationToken`**
([ipc.ts:6](../src/common/base/parts/ipc/ipc.ts#L6)). Upstream threads a token through every channel
call so a long cross-process request can be abandoned. Every channel here is short
request/response — storage init, a log line, a pty spawn, a file stat — where the reply arrives
sooner than the cancellation handshake would. *Defended, with a stated cost:* a slow
language-feature request cannot be abandoned, so its result is discarded late rather than never
computed. The code names the trigger for reversing this (a real search or LSP transport), which is
what makes it a marked seam rather than an oversight.

**(b) Keybindings are rebind-wins instead of `-commandId` removal rules**
([keybindingService.ts:84](../src/renderer/platform/keybinding/browser/keybindingService.ts#L84)).
Upstream keeps every default alive and requires an explicit negative entry to unbind, because
defaults arrive from many contributors and silently dropping one would hide the conflict. Here a
user binding for a command drops that command's *unconditional* defaults, so the old key goes dead
at once. *Defended for this build:* with a single built-in source of rules and no
extension-contributed keybindings, "I rebound it, so the old key should stop working" is what a
user actually expects, and it is a two-line filter instead of a negative-rule grammar. It stops
being defensible the moment extensions can contribute keybindings.

**(c) `IEditContextHost.positionCompositionText` replaces the composition overlay widget**
([editContext.ts:14](../src/renderer/editor/browser/controller/editContext.ts#L14)). Upstream mirrors
in-flight composition text into a dedicated overlay widget; we added a host hook that paints it on
the cursor cell. *Defended:* the overlay widget drags in the whole view-part/overlay-widget
infrastructure to render one transient string, while the hook preserves everything IME correctness
actually requires — text visible at the caret, candidate window anchored to the textarea, one undo
unit per commit. What we give up is styled composition segments (the underlines distinguishing
converted from unconverted text in CJK input), which this build never renders.

Runners-up, both documented in code: no ScanCode/KeyCode split, so keybindings resolve against
`event.code` on a US layout
([keyCodes.ts:4](../src/renderer/platform/keybinding/common/keyCodes.ts#L4)), and `in` taking a list
of literals rather than upstream's `key in valueKey`
([contextkey.ts:10](../src/renderer/platform/contextkey/common/contextkey.ts#L10)).

---

## Part 5 — the one continuation

**Chosen: the in-editor find widget.** Start at `src/vs/editor/contrib/find/` (specifically
`browser/findController.ts` and `browser/findModel.ts`), ported against the view built in 08.

Why this one over the alternatives: it is the only candidate that closes a gap the model *already
admits to*. `textModel.ts:8` records "no in-model search/word helpers" as a deliberate omission, so
find is the shortcut that most visibly limits the editor for a user, and it forces the missing piece
— a model-level search API plus decorations for matches — which snippets, rename and code actions
would all reuse later. Word wrap (candidate 3) is the more instructive port but it touches every
coordinate in 08 and would be a rewrite, not a continuation; preview tabs and the settings UI are
polish on subsystems that already work.
