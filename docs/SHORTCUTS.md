# 0varflex — shortcut ledger

Generated from `grep -rn "shortcut:" src extensions tests` — 38 entries. Each row is a limit that
was taken knowingly, plus the condition that should make us pay it back. Nothing here is a bug;
these are priced decisions. Deltas marked `delta:` in the source (18 more) are design divergences
rather than debt and are covered in [ARCHITECTURE.md](ARCHITECTURE.md) instead.

## base — events, IPC

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 1 | `src/common/base/common/event.ts:46` | `Event.map`/`filter`: every listener subscribes the source event; upstream shares one subscription via a snapshot emitter | listener counts on a hot event (render, scroll, model change) start to matter |
| 2 | `src/common/base/parts/ipc/ipc.electron.ts:18` | Everything on the wire must be JSON-safe — URIs, Dates, classes and functions do not survive; no `IURITransformer` | any channel needs to pass a `URI` or `Date` without hand-serializing at the boundary |
| 3 | `src/common/base/parts/ipc/ipc.ts:6` | `IChannel.call` carries no `CancellationToken`, so no cross-process cancellation | a real search backend or LSP transport lands and long calls need abandoning |
| 4 | `src/common/base/parts/ipc/ipc.ts:318` | Channel events are subscribed lazily; emissions before anyone listens are **lost** (upstream buffers via `Event.buffer`) | any channel needs replay — i.e. a consumer that must not miss startup events |

## editor model

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 5 | `src/common/editor/common/model/textBuffer.ts:9` | One EOL kind per buffer; mixed `\r\n`/`\n` files coalesce to the first-seen EOL on load | a file with genuinely mixed line endings must round-trip byte-for-byte |
| 6 | `src/common/editor/common/model/textBuffer.ts:108` | `getValueInRange` slices the whole joined value — fine for visible ranges, allocates the document for a large one | a hot path reads ranges from big files; the upgrade is a column-range join |
| 7 | `src/common/editor/common/model/textModel.ts:6` | No `createSnapshot`/`applySnapshot`, no `TextModelPart` decomposition; async consumers re-read by range | an async consumer needs a stable view of the document while it is being edited |
| 8 | `src/common/editor/common/model/textModel.ts:8` | No in-model search or word helpers | **the find widget lands — this is the chosen next step** |

## platform — files, DI, log, storage

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 9 | `src/common/platform/files/common/watcher.ts:7` | Single-watcher, no correlation ids: a DELETE arriving within `STALE_DELETE_WINDOW` after an ADD/UPDATE for the same path is dropped as a save-as race artifact | a real deletion gets swallowed, or a second watcher appears |
| 10 | `src/common/platform/files/common/watcher.ts:133` | "Correlation-lite" — the drop is by path+time, where the real watcher correlates request ids | same as 9; this is the implementation site |
| 11 | `src/common/platform/instantiation/common/descriptors.ts:4` | Sync-only DI; `supportsDelayedInstantiation` is a marker that the service rejects | a service genuinely must be constructed lazily or asynchronously |
| 12 | `src/common/platform/instantiation/common/instantiationService.ts:4` | Sync-only DI, no delayed instantiation, no tracing/profiling hooks | startup cost needs attributing per service, or 11 arrives |
| 13 | `src/common/platform/log/common/logService.ts:48` | Log `args` are dropped at the wire; main receives the message string only | structured log data needs to reach the main-process log file |
| 14 | `src/common/platform/storage/common/storageIpc.ts:9` | Single JSON files per scope; no SQLite backend, no migration framework | the stored shape changes in a way that must not break existing users' state |

## terminal / pty

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 15 | `src/main/terminal/ptyHostStarter.ts:7` | No reconnect: if the pty host dies, the renderer only lazily respawns on the next `createTerminal`; existing terminals are zombies | the pty host crashing in front of a user becomes a real complaint (see first-fix below) |
| 16 | `src/ptyHost/terminalProcess.ts:77` | "Ready" fires on first data, where the real one matches shell prompt markers | shell integration lands, or a slow-starting shell mis-reports ready |
| 17 | `src/ptyHost/terminalProcess.ts:144` | Liveness is one synchronous `ps` scan on demand (and `ps` is POSIX-only — this does not run on Windows) | the app must run on Windows, or liveness needs continuous monitoring |

## renderer — editor view & input

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 18 | `src/renderer/base/browser/ui/splitview/splitview.ts:149` | `addView` is append-only; middle insert/remove would need the sashes re-indexed | the workbench arrangement stops being fixed (dynamic panels, real grid docking) |
| 19 | `src/renderer/bootstrap.ts:610` | Temporary config-debug wiring | the editor and sidebar read `editor.fontSize` / `workbench.colorTheme` for real; then delete it |
| 20 | `src/renderer/editor/browser/controller/mouseHandler.ts:10` | No `mouseTarget.ts` hit-test layer, no word-wise drag extension | selection gestures beyond click + drag are needed |
| 21 | `src/renderer/editor/browser/controller/mouseHandler.ts:46` | Right-click is a placeholder that only calls `preventDefault()` | the editor context menu is implemented |
| 22 | `src/renderer/editor/browser/core/cursorColumns.ts:7` | No `Intl.Segmenter` word segmentation; a character classifier stands in | CJK word-wise motion must be correct |
| 23 | `src/renderer/editor/browser/layers/viewLines.ts:12` | No model-level token store — the token cache dies with the view layer | large files make re-tokenizing on scroll visible |
| 24 | `src/renderer/editor/browser/tokenizer.ts:4` | A single stateless scanner, where the real pipeline is per-language and stateful | grammar coverage grows; upgrade path is Monarch/TextMate grammars |
| 25 | `src/renderer/editor/browser/view.ts:13` | Native scrollbars; no smooth-scroll physics, no `alwaysConsumeMouseWheel` | scroll feel matters, or a nested scrollable needs wheel containment |

## renderer — language features

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 26 | `src/renderer/editor/contrib/hover/hoverController.ts:9` | No full markdown renderer in hovers | a provider returns markdown richer than paragraphs, inline code and fences |
| 27 | `src/renderer/editor/contrib/hover/hoverController.ts:245` | `renderMarkdownLite` handles paragraphs, `inline code` and ``` fences only | same as 26; this is the implementation site |
| 28 | `src/renderer/editor/contrib/suggest/suggestController.ts:141` | A provider range extending past the cursor is truncated to it | mid-word completion ranges are needed; requires per-keystroke range recomputation |

## renderer — contextkey, keybinding, quick input

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 29 | `src/renderer/platform/contextkey/common/contextkey.ts:8` | `And` does not distribute `Or` children; serialization parenthesizes instead | an optimizer or a consumer requires disjunctive normal form |
| 30 | `src/renderer/platform/contextkey/common/contextkey.ts:10` | `in` takes a list of literals (old grammar), not upstream's `key in valueKey` | file context keys (`ResourceContextKey`-style set references) are needed |
| 31 | `src/renderer/platform/contextkey/common/contextKeyService.ts:5` | Cached expressions invalidate on key change but are never GC'd; no weak-ref bookkeeping | expression churn makes the cache grow without bound |
| 32 | `src/renderer/platform/keybinding/browser/keybindingService.ts:84` | Rebind-wins: a user binding drops that command's unconditional defaults | extensions can contribute keybindings, which makes silent default-dropping dangerous |
| 33 | `src/renderer/platform/keybinding/common/keybindingResolver.ts:10` | `-commandId` removal rules are not resolved | 32 is paid back |
| 34 | `src/renderer/platform/keybinding/common/keybindingsRegistry.ts:5` | No `-commandId` removal rules; no contribution args beyond one optional `args` | a feature needs multi-arg keybinding contributions |
| 35 | `src/renderer/platform/keybinding/common/keyCodes.ts:4` | No ScanCode split and no keyboard-layout service — resolves against `event.code` on a US layout | non-US keyboard layouts must work correctly |
| 36 | `src/renderer/platform/keybinding/common/userKeybindings.ts:5` | Parses only the shapes our rules use: no `-commandId` unbinding, no `systemWide`, no bubble `^` prefix | 32–34 are paid back, or users hit the missing syntax |
| 37 | `src/renderer/platform/quickinput/browser/commandsQuickAccess.ts:6` | Subsequence scorer with prefix/word-start/consecutive bonuses, not upstream's TF-IDF + `fuzzyScore` | the palette has enough commands that ranking quality degrades |

## tests

| # | Location | The limit | Upgrade when |
|---|---|---|---|
| 38 | `tests/offsetFuzz.test.ts:85` | Offset fuzzing runs against the canonical EOL, since mixed files coalesce | 5 is paid back and mixed EOLs become representable |

---

## If this had ten users, I would fix #9/#10 first — the watcher's stale-DELETE heuristic

The file watcher drops any DELETE that arrives within `STALE_DELETE_WINDOW` of an ADD or UPDATE for
the same path, because atomic saves ("save-as dance") legitimately produce that sequence and would
otherwise flicker the explorer. The problem is that the heuristic keys on path and time, not on
*which request* produced the event — so it cannot tell a save artifact from a real deletion that
happens to land shortly after a save. Save a file, then delete it within the window, and the
explorer keeps showing a file that is gone. An editor still open on it can then write the path back
into existence.

I would fix this first for one reason: it is the only shortcut in the ledger that makes the app
**silently wrong about the user's files**. Everything else here either degrades gracefully (a worse
fuzzy score, a plainer hover, no smooth scrolling) or fails loudly enough to be reported
accurately. Silent wrongness about the filesystem produces bug reports that cannot be reproduced
and erodes trust in everything the explorer says. The fix is also well-defined rather than
open-ended — upstream already solved it with request correlation ids, so this is a port, not a
design exercise.

Runner-up is #15, the pty host's missing reconnect: more likely to be hit, and it loses a running
shell session. It loses to the watcher because it fails *visibly* — the user sees a dead terminal,
knows something broke, and can open a new one. A loud failure with a workaround is cheaper than a
quiet one without.
