# Vendored from microsoft/vscode

Files in this directory are **taken verbatim** from the `microsoft/vscode` repository and are
licensed under the MIT License — see `LICENSE.txt` here, which is Microsoft's own, copied with
them.

Copyright (c) 2015 - present Microsoft Corporation.

## Why some files are vendored and others are ported by hand

The rest of this project *ports* VS Code: it reads the reference and reimplements behaviour on its
own smaller kernel. That is unavoidable for anything touching VS Code's service layer, because the
transitive import closure of such a file is their whole product. Measured, on this checkout:

| Reference file | Files its imports pull in | Lines |
|---|---|---|
| `editor/contrib/snippet/browser/snippetParser.ts` | **2** | 1,606 |
| `editor/common/diff/.../defaultLinesDiffComputer.ts` | 96 | 31,450 |
| `editor/common/model/pieceTreeTextBuffer/...` | 264 | 92,526 |
| `editor/contrib/folding/browser/folding.ts` | 333 | 115,375 |
| `editor/browser/widget/codeEditor/codeEditorWidget.ts` | 506 | 168,758 |
| `workbench/contrib/notebook/browser/notebookEditorWidget.ts` | **2,360** | 800,985 |

Taking `folding.ts` means taking 333 files — their text model, services and instantiation. At that
point you do not have this editor with folding; you have VS Code. Taking `snippetParser.ts` means
taking two files that import nothing outside themselves.

So the rule is **closure, not preference**:

- **Closure of roughly a dozen files or fewer → vendor it here, verbatim.** Self-contained
  algorithms. Do not retype them: the upstream version is more complete and better tested than
  anything hand-written to the same deadline.
- **Closure in the hundreds → port the behaviour by hand.** The adaptation to this project's
  kernel *is* the work, and vendoring would import the kernel it is supposed to adapt to.

## Rules for this directory

- **Do not edit these files.** Keeping them byte-identical to upstream is the entire point: it is
  what makes them replaceable with a newer copy. Adaptations belong in a wrapper outside this
  directory.
- Record each file's upstream path and why it was taken, in the table below.
- A wrapper that adapts a vendored file to this project's types goes next to its consumer, not
  here.

## What is here

| Vendored file | Upstream path | Taken because |
|---|---|---|
| `editor/contrib/snippet/snippetParser.ts` | `src/vs/editor/contrib/snippet/browser/snippetParser.ts` | Full snippet syntax — placeholders, choices, variables, transforms, format strings. The hand-written replacement it replaced was 234 lines and carried three `shortcut:` comments admitting it supported none of those. |
| `base/common/charCode.ts` | `src/vs/base/common/charCode.ts` | The only dependency of the above. |
