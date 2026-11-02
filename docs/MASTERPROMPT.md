# MASTERPROMPT — closing the gap to VS Code

The running order for the rest of this project. Measured, not guessed: every number below
comes from a `microsoft/vscode` checkout at v1.145.0 (`C:\Users\admin\Desktop\vscode`).

## The gap, measured 2026-11-02

| | VS Code | 0varflex |
|---|---|---|
| TypeScript files | 11,002 (`src/vs`) | 196 |
| Lines | 3,935,299 | ~35,000 |
| **Editor contributions** (`editor/contrib`) | **59** | **4** — find, hover, markerDecorations, suggest |
| **Workbench contributions** (`workbench/contrib`) | **102** | **12** |

0varflex is ~0.9% of VS Code by volume. **"Add everything" is not a plan** — it is ~3.9M lines
across ~145 missing areas. This document is the plan: ordered by *what a developer notices per
line of code written*, so the editor stops feeling broken sooner rather than being 1% more
complete everywhere.

## How to read a batch

Each item names the reference path to port from, the real command ids, and what "done" means.
Rules that hold for every batch:

- **Real ids.** Command ids, setting keys and default keybindings are copied from the reference,
  never invented. Muscle memory is a feature.
- **Pure logic is separated and tested.** The edit computation goes in exported functions; the
  controller only applies them. The DOM is not unit tested.
- **One edit per undo step**, or `pushStackElement` brackets. An action a user can undo in one
  press must be one edit.
- **Route edits through the widget** (`replaceRange`), so the readonly gate and the edit stack
  stay honoured.
- **Deltas get a comment.** Anything knowingly smaller than the reference carries
  `shortcut: <limit>, <when to upgrade>`.

---

## B1 — Editing keystrokes (hourly use, tiny code)

The things whose absence makes an editor feel unfinished within a minute.

| Item | Reference | Ids / keys | Done when |
|---|---|---|---|
| **Toggle line/block comment** | `editor/contrib/comment` | `editor.action.commentLine` (Ctrl+/), `editor.action.blockComment` (Shift+Alt+A) | A selection spanning mixed lines comments all of them; a fully-commented selection uncomments; indentation is preserved |
| **Line operations** | `editor/contrib/linesOperations` | `moveLinesUp/DownAction` (Alt+↑/↓), `copyLinesUp/DownAction` (Shift+Alt+↑/↓), `deleteLines` (Ctrl+Shift+K), `indentLines`/`outdentLines` (Ctrl+]/[) | Each is one undo step, the selection follows the moved text, and the first/last line are no-ops rather than corruption |
| **Bracket matching** | `editor/contrib/bracketMatching` | `editor.action.jumpToBracket` (Ctrl+Shift+\\) | The matching bracket is highlighted and jumpable; nesting is respected |
| **Auto-closing pairs + auto-indent** | language configuration | — | Typing `(` inserts `()`; Enter inside a block indents; typing the closer over an auto-inserted one does not duplicate |

## B2 — Navigation and structure

| Item | Reference | Ids / keys | Done when |
|---|---|---|---|
| **Folding** — *moved to B5, see below* | `editor/contrib/folding` | `editor.fold`/`unfold` (Ctrl+Shift+[/]), fold all/unfold all | Indentation-based ranges fold, the gutter shows chevrons, folded state survives scrolling |
| **Multi-cursor** | `editor/contrib/multicursor` | `insertCursorAbove/Below` (Ctrl+Alt+↑/↓), `addSelectionToNextFindMatch` (Ctrl+D) | Typing edits every cursor as one undo step |
| **Go to next/previous problem** | `editor/contrib/gotoError` | `marker.next` (F8), `marker.prev` (Shift+F8) | Walks the marker list and reveals each |
| **Outline + breadcrumbs** | `workbench/contrib/outline` | `outline.focus` | Symbols listed from the language provider, click reveals |
| **Sticky scroll** | `editor/contrib/stickyScroll` | setting `editor.stickyScroll.enabled` | The enclosing scope stays pinned at the top while scrolling |

## B3 — Code intelligence (needs the LSP client extended)

| Item | Reference | Ids / keys | Done when |
|---|---|---|---|
| **Rename symbol** | `editor/contrib/rename` | `editor.action.rename` (F2) | Inline input, applies a workspace edit, one undo step |
| **Quick fix / code actions** | `editor/contrib/codeAction` | `editor.action.quickFix` (Ctrl+.) | Lightbulb on a marker, menu applies the edit |
| **Format document** | `editor/contrib/format` | `editor.action.formatDocument` (Shift+Alt+F) | Applies provider edits; no-op without a provider |
| **Snippets** | `editor/contrib/snippet` | tab stops, `$1`/`$0` | Accepting a snippet completion inserts tab stops and Tab walks them |
| **Go to definition** | `editor/contrib/gotoSymbol` | `editor.action.revealDefinition` (F12) | Jumps, including across files |

## B4 — Workbench surfaces

| Item | Reference | Done when |
|---|---|---|
| **Output panel** | `workbench/contrib/output` | Named channels, the log service writes to one, panel tab switches channels |
| **Settings UI** | `workbench/contrib/preferences` | A real editor over 06's registry + schema, rendering enums/min/max |
| **Keybindings UI** | `workbench/contrib/keybindings` | Searchable list, shows source, records a new chord |
| **Themes** | `workbench/contrib/themes` | A theme registry and a colour-token map replacing the hardcoded CSS variables |
| **Diff editor** | `editor/browser/widget/diffEditor` | Two models side by side with aligned changes — closes git-lite's readonly-diff shortcut |
| **Timeline / local history** | `workbench/contrib/localHistory` | Per-file revision list, restore a revision |

## B5 — Engines (deliberately last: large, and nothing above depends on them)

- **Word wrap** — *this document originally had word wrap here and folding in B2, as if they were
  independent. They are not: both need the model-line ↔ view-line mapping, which is why folding
  came with it.* Half of that prerequisite now exists:
  `common/editor/common/viewModel/lineMapping.ts` hides lines, and the geometry consults it.
  Wrap needs the other half — one model line becoming SEVERAL view lines, so `modelToView`
  returns a range rather than a number, and the x ↔ column maths becomes per-view-line. The
  interface is shaped for it. Expect it still to break pixel assumptions, but no longer the
  model-to-row ones.
  - The approach that kept folding from being a rewrite: call sites still pass MODEL line
    numbers and the view model maps them, rather than converting all 16 geometry sites to view
    coordinates. Layers that loop a range call `visibleModelLines(viewport)` so they cannot
    forget to skip a folded line.
- **Piece-tree buffer** — `editor/common/model/pieceTreeTextBuffer`. The documented answer to the
  "what breaks at 10×" question; only worth it once large files are actually opened.
- **Minimap**, **semantic tokens**, **notebooks**, **webviews**, **testing**, **remote/SSH**,
  **extension marketplace (Open VSX)**.

## Explicitly not planned

Telemetry, surveys, experiments, `editTelemetry`, `bracketPairColorizer2Telemetry`,
`emergencyAlert`, `policyExport`, `userDataSync`, `agentsVoice`, `speech`, `canvases`,
`imageCarousel`, `meteredConnection`. These exist for Microsoft's distribution, not for an
editor's usefulness, and porting them would be cargo-culting.

## Status

- **B1 — done.** All four items.
  - Comment toggle and line operations: 9 real command ids in `editor/contrib/linesOperations/`,
    the edit computation in `lineEdits.ts`, and all ten "done when" behaviours driven through the
    real commands in the running app.
  - Bracket matching: `editor.action.jumpToBracket` (Ctrl+Shift+\\) plus a highlight content
    layer in `editor/contrib/bracketMatching/`, over a nesting-aware scan in
    `common/editor/common/model/bracketMatching.ts`.
  - Auto-closing pairs and auto-indent: in the widget's type handler, which is where the
    reference puts them (`cursorTypeOperations.ts`) — a contrib reacting to an edit event is too
    late to change what gets inserted.
  - Language configuration now has one home,
    `common/editor/common/languages/languageConfiguration.ts`: comment tokens, bracket pairs and
    auto-closing pairs. The pane sets it on the widget from the input's resource.
  - 459 tests pass; 63 of them cover B1's pure logic.
- **B2 — in progress.**
  - Go to next/previous problem: **done.** `editor.action.marker.next` / `.prev` (F8 / Shift+F8)
    in `editor/contrib/gotoError/`, over a tested walk in `markerNavigation.ts`.
  - Sticky scroll: **done.** `editor/contrib/stickyScroll/` over
    `common/editor/common/model/indentRanges.ts`, with the real `editor.stickyScroll.enabled` and
    `editor.stickyScroll.maxLineCount` settings.
  - Folding: **done**, and with it the view-line mapping it needed. `editor.fold`/`unfold`
    (Ctrl+Shift+[/]), `foldAll`/`unfoldAll` (Ctrl+K Ctrl+0 / Ctrl+K Ctrl+J), `toggleFold`, plus
    gutter chevrons. See the B5 note: the mapping is the half of the word-wrap prerequisite that
    is now built.
  - Multi-cursor: **done.** `insertCursorAbove`/`Below` (Ctrl+Alt+↑/↓),
    `addSelectionToNextFindMatch` (Ctrl+D), `insertCursorAtEndOfEachLineSelected` (Shift+Alt+I),
    `removeSecondaryCursors` (Escape). The controller keeps one primary plus secondaries, so
    `getSelection()` still means the primary at all 52 call sites that already use it, and
    typing is one edit per cursor in a single undo step.
  - **Outline + breadcrumbs: blocked, honestly.** The done-when is "symbols listed from the
    language provider" and there is no document-symbol provider: `languageFeatures` carries
    completion and hover only. It needs a new provider chain (extHost API, wire protocol,
    registry) before any UI is worth writing. An indentation-guessed outline would look like the
    feature without being it.
  - 561 tests pass.

### Known deltas carried by B1

- One built-in table keyed on file extension, not `language-configuration.json` (`shortcut:` in
  `languageConfiguration.ts`). An extension cannot bring or override a language's syntax yet.
- **Bracket matching is text-only.** There is no tokenizer, so a bracket inside a string or a
  comment counts as a bracket. The same gap is why auto-closing uses `autoCloseBefore` rather than
  the reference's `notIn: ['string', 'comment']` rules. Closed by B5's semantic tokens.
- `editor.action.blockComment` works on whole lines, not the exact selection; there is no
  "surround the selection with a pair" either.
- There is no `editor.insertSpaces` setting, so indentation inserts a tab, matching the existing
  `tab` command.

### Known deltas carried by B2

- F8 shows a one-line banner, not the reference's peek widget with related-information links and
  next/previous buttons (`shortcut:` in `gotoErrorController.ts`).
- F8 walks the open file only; the reference also has `marker.nextInFiles`.
- Sticky scroll's pinned rows have no line numbers and do not follow horizontal scrolling. Both
  want the same gutter work folding does.
- Scope detection is indentation-based. The reference prefers a language-aware provider and falls
  back to indentation; we only have the fallback.
- **Arrow keys collapse the cursor set** instead of moving every cursor (`shortcut:` in
  `cursorController.ts`). The reference runs the whole move computation per cursor; that needs the
  move helpers to take a selection parameter. Typing, Ctrl+D and the insert-cursor commands all
  work on the full set — only motion is single-cursor.
- Auto-closing pairs are skipped while several cursors are active: it is a single-cursor behaviour
  in the reference too, and mixing them needs a per-cursor decision.
- **Collapsed regions are remembered by header line number** (`shortcut:` in
  `foldingController.ts`), so an edit *above* a fold shifts what is collapsed. The reference
  tracks them with decorations that move with the text. The fix is a decoration id per region.
- Folding is indentation-based, so a region ends at its last deeper line and the closing brace
  stays visible. That matches the reference's indentation provider; a language-aware provider
  would fold the brace too.

### Bugs found by driving the real app (not by the tests)

Three, all pre-existing and none visible from a unit test:

1. **Every atomic write failed on Windows.** The temp file was opened `'r'` and then `fsync`ed;
   Windows returns `EPERM` for `FlushFileBuffers` on a read-only handle. Atomic writes are how
   settings are saved, so no setting had ever persisted on this platform. The course was written
   on macOS, where fsync on a read handle is allowed.
2. **`writeFile` never created the parent directory.** The settings file lives in a directory
   nothing else creates, so a fresh profile failed with `ENOENT` before even reaching (1).
3. **The failure was invisible** because the only caller discarded the rejection with `void`.

(1) and (2) now have tests, which needed `electron` marked external in the test build — the disk
provider imported it at module load, so it could not be imported from a test at all. That is why
the file had no tests.
