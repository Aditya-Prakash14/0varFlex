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
| Editor model | `src/common/editor/common/model/` | `src/vs/editor/common/model/` | piece tree buffer, snapshots, decorations interval tree, persisted token store, bracket-pair colorization (**in-model search now ported**) |
| Editor view | `src/renderer/editor/browser/`, `src/renderer/editor/contrib/find/` | `src/vs/editor/browser/`, `src/vs/editor/contrib/find/` | word wrap, folding, minimap, multi-cursor, custom scrollbar physics, view zones (**find/replace now ported**) |
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

---

## A2 — what needed new *kernel* code (the appendix's own test)

The appendix claims most of "VS Code" is a contribution on top of the kernel, and says that if a
part needs new kernel code, that is a design bug worth writing down. Here is the honest tally.

### A2-1 (source control) — three kernel gaps, all small, all real

1. **`EditorInputCapabilities.Readonly` was declared but never enforced.** Nothing read it, so a
   "readonly" tab was fully editable. Fixed in two places: `EditorWidget.setReadonly()` gates the
   single edit funnel (`_pushEdit`) plus undo/redo, and `TextEditorPane` feeds the input's
   capability to the widget. This was *cheap only because of 07's contract* — all ten mutation
   sites go through `_pushEdit`, so one branch covers typing, paste, Tab, delete and composition
   commits. A design win, not a bug.

2. **`workspace.workspaceFolders` returned `undefined`** — the host had no folder mirror, so an
   extension could not learn which directory it operates on. git-lite cannot find a repository
   without it. Added to `IExtensionHostInitData` plus an `$acceptWorkspaceFoldersChange` push so a
   folder swap re-targets the host. **This one is a genuine design bug**: an extension host that
   cannot name its workspace is not a workspace extension host.

3. **No way for an extension to put text on screen.** There is no `openTextDocument`/
   `showTextDocument` and no `TextDocumentContentProvider`. Rather than add either, the diff rides
   the *existing* commands RPC: the workbench owns a generic
   `workbench.action.openReadonlyContent` ({key, name, content}) command, and `TextEditorInput`
   gained an optional in-memory content source. No new protocol surface was needed — and the
   command is deliberately not git-shaped, so the claim holds.

What did **not** need kernel code, and is the evidence for the appendix's claim: the entire SCM
model, the composite, the status letters and every git concept. `src/renderer/workbench/` contains
no `git` string; the provider registers resources that carry a **command id it owns**, and the view
executes whatever it was handed. Deleting `extensions/git-lite/` removes source control and leaves
the workbench compiling.

The one shortcut worth flagging: git-lite polls (5s + document-change events) because **the host
has no file-watcher API** (`createFileSystemWatcher` does not exist). The real extension watches
`.git/` and the worktree. That is a fourth gap, left open rather than papered over.

### A2-2 (debug/DAP) — one kernel gap, one refactor, one seam worth naming

1. **The framing was buried in an extension.** `Content-Length`-delimited JSON is the *same* base
   protocol for LSP and DAP, but the reader/writer lived in `extensions/toy-lang/client/src/`.
   Moved to `src/common/base/parts/protocol/common/messageFraming.ts`; the old path is a
   re-export so the LSP client is untouched, and `tests/lspFraming.test.ts` now covers the shared
   copy. One implementation, two protocols — the payoff 12's framing tests were written for.

2. **No editor-contribution registry.** The real workbench registers gutter contributions through
   `registerEditorContribution`, so the editor never names them. We have no such registry, so
   `TextEditorPane` takes an *optional* `debugService` and constructs `BreakpointDecorations`
   itself when present. That optionality keeps the editor usable without a debugger, but it is a
   **genuine design gap**: the second gutter contribution will want the registry rather than
   another optional service. Written down rather than papered over.

   What it did *not* need: a new rendering mechanism. Gutter breakpoints reuse 12's margin layer
   (`view.addMarginLayer` + pooled nodes + viewport-space tops) exactly as the marker dots do.

3. **Where the framing lives is a deliberate deviation.** The reference's `RawDebugSession` frames
   in the workbench, because its adapters can be in-process or workbench-spawned. Ours only spawns
   from the extension host (which is Node and already owns child processes), so the host owns the
   pipe and the workbench speaks DAP in DTOs. The workbench still owns the **conversation** —
   which requests, in which order, and what the answers mean — which is the part that matters.

Nothing else was needed. The debug composite, the DAP client, the call stack and variables views
are all contribution code, and the adapter is an extension plus a separate process. Delete
`extensions/toy-debug/` and debugging disappears while the workbench still compiles — the same
test A2-1 passed.

**Verified without a GUI:** `tests/debugAdapter.test.ts` drives the real adapter process through
the full handshake (initialize → setBreakpoints → configurationDone → launch), asserts it stops
*before* executing the breakpoint line with `counter === 2`, steps, continues to termination, and
checks the process actually **exits on disconnect** — the "adapter reaped" acceptance item, as a
test rather than a claim. It found a real bug: `setBreakpoints` arrives before `launch`, so
verification had to read the source named in the request instead of the not-yet-loaded program.

### A2-3 (tasks) — two kernel seams, both one-liners in disguise

1. **The terminal service assumed every process had a UI.** Pty data was routed as
   `getInstance(event.id)?.acceptData(...)`, so a process with no `TerminalInstance` had its
   output silently dropped. Tasks need a hidden process whose bytes go to a text pane, so the
   service now also re-fires `onProcessData`/`onProcessExit` for any listener. Small, but a real
   assumption worth naming: "a process" and "a terminal" were the same thing.

2. **The panel could only host one kind of pane.** `PanelPart` had a tab strip the terminal
   contrib filled directly, so a second tenant would have fought it for visibility. Added
   `registerTabGroup`/`activateTabGroup`: each contrib supplies a `setVisible` callback and the
   *part* arbitrates, so the terminal and task panes never reference each other. This is the same
   shape the sidebar got in A1 and what the reference's `paneCompositePart` does properly.

What did **not** need changing, and is the headline: `ICreateProcessOptions` already carried
`shell`/`shellArgs`/`cwd`, so a task spawns its command **directly** — with no pty-host change at
all, and the exit code belongs to the task rather than to a wrapping shell. Problems go through
12's marker service under the owner `task`, which means they appear in the Problems view *and* as
squiggles with no new rendering code. The picker reuses 04's quick input and its `fuzzyScore`.

One non-obvious bug the tests caught: a pty colours its output, and a greedy `(.*)` in a problem
pattern **swallows the ANSI escape into the captured path**, so the matcher reports a problem
against a file that does not exist. Failing to match would have been obvious; matching with a
poisoned path is not. `stripAnsi` runs before matching, and the test asserts that exact failure
mode rather than just the happy path.

### A2 verdict on the appendix's claim

The claim holds, with four honest exceptions — all of them *missing generic seams*, never missing
feature code:

| Gap | Kind | Severity |
|---|---|---|
| `workspace.workspaceFolders` returned `undefined` | missing API | **real bug** — a workspace extension host that cannot name its workspace |
| `EditorInputCapabilities.Readonly` not enforced | declared, unimplemented | real, cheap to fix (one gate, thanks to 07) |
| No editor-contribution registry | missing registry | real; the second gutter contribution will force it |
| No file-watcher API for extensions | missing API | real; git-lite polls instead (left open) |
| Panel/sidebar multi-tenancy | missing registry | expected — 03 deferred it explicitly |
| Terminal data routing assumed a UI | wrong assumption | minor |

Every git concept, every DAP concept and every npm concept lives in an extension or a contrib.
`src/renderer/workbench/` names none of them. Delete `extensions/git-lite/`,
`extensions/toy-debug/` or the tasks contrib and the corresponding feature disappears while the
workbench still compiles — which was the thing to test.

---

## Measured against VS Code (v1.145, cloned 2026-11-01)

| | VS Code (`src/vs`) | 0varflex (`src` + `extensions`) |
|---|---|---|
| TypeScript files | 11,002 | 190 |
| Lines of code | 3,935,299 | ~33,000 |
| Feature areas (`workbench/contrib`) | 102 | 11 |

0varflex is roughly **0.8%** of VS Code by volume. "Add every missing feature" is ~3.9M lines
across 92 feature areas, so the delta is worked through by priority, not by completion. The
subsystem table at the top of this document is the per-area version of this comparison.

Worth knowing: VS Code already ships the AI scaffolding this project had to build from scratch —
its contrib list contains `chat`, `inlineChat`, `inlineCompletions`, `mcp`, `agentsVoice`,
`remoteCodingAgents` and `welcomeAgentSessions`.

## The built-in coding agent

The editor's own agent, not an extension. It is the one feature deliberately **not** pushed out
to the extension host, for two reasons that both come down to where things are allowed to live:

- **The credential.** The renderer is a browser context and its bundle is shipped. An API key
  must never be reachable from it. The agent runs in the **main process**, and the production
  bundle check confirms the SDK does not appear in `renderer.js`.
- **The tools.** Reading, writing and running things needs Node. Main already owns the
  `FileService`, the search engine and child processes; the extension-host API has no file-write
  or terminal surface, so an agent extension could not edit anything without first growing a
  large new API.

The split: main runs the loop and the tools, the renderer gets a chat composite over the `agent`
channel — the same shape the `search` channel uses.

### What makes it safe rather than merely working

A tool input is **untrusted model output**. Schema validation proves the shape; it says nothing
about where a path points. `confinePath` is the gate, and it is the most-tested function in the
feature:

- absolute paths and `..` traversal are refused;
- `realpath` runs on the resolved path, so a symlink pointing out of the workspace is refused
  even though the lexical check passes — this is the case a naive implementation misses;
- a file that does not exist yet (the agent creating one) canonicalizes the **parent** instead,
  so creation works without opening the hole back up. A new file under a symlinked-out directory
  is still refused.

Beyond paths: `run_command` is gated on `agent.allowCommands` (default **false**) and is not even
advertised to the model when off; it uses `execFile` with an argument array, so there is no shell
and nothing to inject into. Every tool has a hard output cap, because a tool result goes straight
into the context window. `edit_file` replaces one **exact unique** string rather than a line
range — a stale line number silently edits the wrong code, while a missing or ambiguous string
fails loudly and changes nothing.

### Loop details that are easy to get wrong

Written against the streaming manual loop rather than the SDK's beta tool runner, because the
loop has to re-publish every event over IPC and gate each tool before it runs. The rules it
obeys, each of which is a real failure mode:

- all `tool_result` blocks for one assistant turn go back in **one** user message — splitting
  them teaches the model to stop making parallel calls;
- `refusal` can cut a tool input off mid-stream, so that turn's tools never run;
- `max_tokens` on a tool-calling turn means the arguments are truncated but often still parse,
  so the call is refused rather than run on partial input;
- `pause_turn` is not an end — the assistant turn is appended and sent back;
- the whole `content` array is appended, not just the text, so thinking blocks travel back
  unchanged;
- tool inputs are re-validated locally, because eager input streaming turns server-side
  validation off and the tolerant parser can return a silently truncated object.

**Still open:** `run_command` is one setting rather than a per-call approval prompt (the model
proposes, the user clicks). That is the upgrade for using the agent on code the user does not
fully trust. There is no inline chat, no slash commands, no @-file references, no markdown
rendering in the transcript, and no diff preview before an edit lands — the agent writes
directly and the open editor reloads.
