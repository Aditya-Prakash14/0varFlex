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
| **Folding** | `editor/contrib/folding` | `editor.fold`/`unfold` (Ctrl+Shift+[/]), fold all/unfold all | Indentation-based ranges fold, the gutter shows chevrons, folded state survives scrolling |
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

- **Word wrap** — the real coordinate-system port; touches every geometry call in 08. Start at
  `editor/common/viewModel` (wrapping lines). Expect it to break every pixel assumption.
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

- **B1** — in progress.
  - Comment toggle and line operations: **done**. 9 real command ids in
    `editor/contrib/linesOperations/`, the edit computation in `lineEdits.ts` under 32 tests, and
    all ten "done when" behaviours driven through the real commands in the running app.
  - Bracket matching and auto-closing pairs: next.
- B2–B5 — queued, in the order above.

### Known deltas carried by B1

- Comment tokens come from a built-in extension table, not `language-configuration.json`
  (`shortcut:` in `lineEdits.ts`). An extension cannot define its own comment tokens yet.
- `editor.action.blockComment` works on whole lines, not the exact selection.
- There is no `editor.insertSpaces` setting, so indent/outdent insert a tab, matching the existing
  `tab` command.
