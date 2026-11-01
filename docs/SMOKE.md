# 0varflex — release smoke test

**Product version:** 1.0.2 (`package.json`) · **Tag:** `v1.0.2`
**Date of this pass:** 2026-11-01
**Machine:** Windows 11 Pro 26200, x64 · Node 24.22.1 (per `.nvmrc`)

> **Read this before trusting the boxes below.**
>
> This checklist is specified to run **from the packaged app**, and the packaging pipeline in this
> repo is macOS-only: `scripts/dist.mjs` drives electron-builder to a dmg + zip + `latest-mac.yml`
> and then ad-hoc `codesign`s it, and `scripts/check-dist.mjs` asserts on
> `dist/mac-arm64/0varflex.app`, reads `Info.plist` via `plutil`, and verifies `codesign -dv`.
> None of those tools exist on Windows. **No packaged app can be produced on this machine**, so
> every item that requires one is recorded as `NOT RUN` with its reason rather than checked.
>
> Items requiring a human at a GUI (observing a repaint, switching an input source mid-composition,
> watching a panel after `kill -9`) are also recorded `NOT RUN`. A box is only checked where it was
> actually executed and observed. An unchecked box here is information, not an omission.
>
> `[x]` = run and passed · `[ ]` = NOT RUN (reason given) · `[!]` = run and failed

## Part 1 — the checklist

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Launch from Finder; open a folder; tree populates; status bar shows folder, problems count, cursor, encoding, EOL | `[ ]` | needs packaged app + GUI; also macOS-specific (Finder) |
| 2 | Create `notes.md`; type for a minute with IME on, switching input source mid-flow; undo/redo through it; save; external edit; reload prompt | `[ ]` | needs GUI + human IME interaction |
| 3 | Split editor, same file both panes; cursor/scroll independence; dirty dot sync in both tabs | `[ ]` | needs GUI |
| 4 | `Cmd+Shift+P` → 6 commands incl. `Developer: Reload Window`; reload restores folder + layout | `[ ]` | needs GUI; chord is `Ctrl+Shift+P` on this platform |
| 5 | keybindings.json rebind takes effect live; settings.json broken then recovered | `[ ]` | needs GUI |
| 6 | `kilo-test.cfg` with 30+ diagnostics: squiggles, problems picker, jump-to-line with range selected, completions incl. `isIncomplete` refetch, hover docs | `[ ]` | needs GUI; `extensions/toy-lang/sample.cfg` is the fixture |
| 7 | Terminal: 3 tabs, `vim`, `htop`, `yes` flood, Ctrl+C, resize fights, kill; then `kill -9` the pty host and create a new terminal | `[ ]` | needs GUI; `vim`/`htop`/`yes` absent on Windows, and `terminalProcess.ts:145` liveness shells out to POSIX `ps` |
| 8 | Extension host: run `hello.sayHello`, wordcount updates live; `kill -9` the ext host, keep using the app, reload, clean `ps` | `[ ]` | needs GUI |
| 9 | Quit with a dirty editor → Save dialog → quit; relaunch; update check logs a clean 404 line, not a stack | `[ ]` | needs packaged app (the updater only runs packaged) |
| 10 | `mini .` from a terminal while the app runs → focused + forwarded | `[ ]` | needs the installed CLI shim from the mac bundle |

**Checklist result: 0 of 10 executed on this machine.** The blocker is the platform, not the code.
To complete Part 1 this repo must be smoke-tested on macOS arm64, where `npm run dist` produces the
bundle the checklist is written against.

## Part 1b — what *was* verified here (automated)

These are the parts of the release gate that do not need a bundle or a human. They were actually
run on this machine; results are recorded in the next section.

- `npm run build` — esbuild compile of all six entry bundles (portable; the mac-only `chmod` of
  node-pty's `spawn-helper` is `.catch()`-guarded and no-ops here)
- `npm test` — 26 unit test files bundled by esbuild, run on `node --test`
- app boot — `electron .` starting main + renderer + ext host + pty host without crashing

### Results, measured on this machine 2026-11-02

| Gate | Result | Detail |
|---|---|---|
| `npm ci` | **PASS** | exit 0, 239 packages, Node 24.22.1 |
| `npm run build` | **PASS** | 4s warm (61s cold); all entry bundles emitted to `out/` (`main.js` 697KB, `renderer.js` 1.0MB, `extHost.cjs` 74KB, `ptyHost.cjs` 22KB, `preload.cjs` 2KB, plus the sample extensions) |
| `npm run build --production` | **PASS** | bundle-hygiene checks pass; no Node builtins in `renderer.js` |
| `npm test` | **PASS** | 18s wall clock. **296 passed, 0 failed**, exit 0 — green on three consecutive runs |
| app boot (`electron .`) | `[ ]` NOT RUN | Electron's postinstall never produced `node_modules/electron/dist`; see below |

**The build is genuinely portable.** esbuild compiled every bundle on Windows with no changes, and
the mac-only `chmod` of node-pty's `spawn-helper` no-ops as designed.

#### The suite used to fail 22 of 184 here — and that hid two real bugs

This section previously recorded "162 passed, 22 failed" and concluded that the suite was a
macOS-only gate and that **no product bug was involved**. That conclusion was wrong, and the way
it was wrong is the lesson worth keeping.

The 22 failures did share one root cause in the tests: `URI.fsPath` is platform-dependent, which
is *correct* and matches upstream ([uri.ts:346](../src/common/base/common/uri.ts#L346)), while the
harness keyed its in-memory files by the POSIX string it was handed and looked them up by
`fsPath`. One normalizer in `tests/harness/fileSystem.ts` fixed 11 of them, and making the
`uri` / `fileWatcher` / `terminalEnv` expectations platform-aware fixed the rest.

But with the noise gone, three things surfaced that had been invisible:

- **`watcher.isParent()` hardcoded `/`** — so on Windows a deleted folder never suppressed its
  children's DELETE events. Deleting a folder of 200 files produced 201 events instead of 1, and
  every consumer (explorer refresh, editor mark-deleted) did 201 events' worth of work.
- **`watcher.matchesExclude()` split on `/` only** — so on Windows **every exclude was silently
  ignored**, and changes under `node_modules` and `.git` were all reported.
- **A regression** in the A2-2 framing extraction: the reader's error message was renamed when it
  moved out of the LSP client, breaking a test nobody could see among the 22.

Both watcher bugs are in shared product code and are now covered by tests that use backslash paths,
so they fail on **every** platform rather than only on Windows.

The `storage` test was also genuinely flaky — it passed in isolation and failed under parallel
load because it slept a fixed 100ms for a 30ms debounce. It now waits for the write to happen.

**The standing lesson:** a suite with known-failing tests is not a gate. The 22 were correctly
diagnosed as platform assumptions and incorrectly treated as harmless.

#### Why app boot was not run

`npm ci` exited 0, but `node_modules/electron/dist` and `path.txt` were never created, so no
Electron binary is present to launch (its download cache holds 754MB, but extraction did not
complete). Without that, `electron .` cannot start. Even with it, boot would only have proven the
four processes start without crashing — the checklist items all need a human watching a GUI, which
this environment has no way to provide.


## Part 3 — performance budgets

| Metric | Budget | Measured | How |
|---|---|---|---|
| Cold start to painted workbench | < 1.5s | NOT RUN | needs packaged app; `performance.mark` instrumentation exists in `src/renderer/bootstrap.ts` |
| Ext host ready | < 500ms after renderer | NOT RUN | needs a running app; read from the activation log |
| 100k-line file open | < 300ms | NOT RUN | needs a running app |
| Scroll frame pass (steady state) | < 8ms | NOT RUN | needs a GUI; counter exists in `src/renderer/editor/browser/view.ts` |
| Terminal `yes` flood keeps frames < 16ms | — | NOT RUN | needs GUI; `yes` not present on Windows |
| Full `npm test` | < 60s | **18s — within budget** | measured here; 296 pass / 0 fail, exit 0 |

**No performance fix was owed by a budget.** The only budget measurable here (`npm test`, 18s vs
60s) is well inside it, and the rule is to fix nothing under 2× budget. Two performance fixes were
made anyway, for problems the budgets do not cover: the task output pane re-scanned its whole
buffer every 50ms while a task streamed, and the output cap re-copied 200,000 characters on every
chunk once full. Both are now amortized.

Five of the six budgets are GUI/bundle measurements and are genuinely unmeasured — not estimated,
not inferred. Filling them in is the first task of a macOS pass. The instrumentation they need is
already in the tree (`performance.mark` in `bootstrap.ts`, the render-pass counter in `view.ts`),
so it is a matter of running it, not building it.

## Parts 2, 4, 5

- Part 2 — [ARCHITECTURE.md](ARCHITECTURE.md): delta table (16 subsystems, reference paths verified
  against a real `microsoft/vscode` checkout at v1.145.0) + the five exam answers.
- Part 4 — [SHORTCUTS.md](SHORTCUTS.md): 38-entry debt ledger from `grep -rn "shortcut:"`, each with
  an upgrade trigger, plus the defended first-fix choice.
- Part 5 — the chosen continuation (in-editor find widget, starting at
  `src/vs/editor/contrib/find/browser/findController.ts`) is argued at the end of ARCHITECTURE.md.
