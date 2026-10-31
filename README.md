<div align="center">

<pre>
███╗   ███╗  ██╗  ███╗   ██╗  ██╗             ██╗   ██╗  ███████╗   ██████╗    ██████╗   ██████╗   ███████╗
████╗ ████║  ██║  ████╗  ██║  ██║             ██║   ██║  ██╔════╝  ██╔════╝   ██╔═══██╗  ██╔══██╗  ██╔════╝
██╔████╔██║  ██║  ██╔██╗ ██║  ██║   ███████   ██║   ██║  ███████╗  ██║        ██║   ██║  ██║  ██║  █████╗
██║╚██╔╝██║  ██║  ██║╚██╗██║  ██║   ╚══════   ╚██╗ ██╔╝  ╚════██║  ██║        ██║   ██║  ██║  ██║  ██╔══╝
██║ ╚═╝ ██║  ██║  ██║ ╚████║  ██║              ╚████╔╝   ███████║  ╚██████╗   ╚██████╔╝  ██████╔╝  ███████╗
╚═╝     ╚═╝  ╚═╝  ╚═╝  ╚═══╝  ╚═╝               ╚═══╝    ╚══════╝   ╚═════╝    ╚═════╝   ╚═════╝   ╚══════╝
</pre>

**A miniature VS Code, built from scratch and ported from the real architecture — exercise by exercise.**

[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-177%20passing-brightgreen)](#testing)
[![Exercises](https://img.shields.io/badge/exercises-00%20%E2%86%92%2013-blueviolet)](#the-exercises)
[![Bundler](https://img.shields.io/badge/bundler-esbuild-FFCF00?logo=esbuild&logoColor=black)](https://esbuild.github.io/)

</div>

---

## What is this?

`mini-vscode` is a working miniature of VS Code: a real Electron app with a workbench shell,
editor, explorer, file watcher, extension host, language features and an integrated terminal —
each one **ported in structure from the actual VS Code source** (a local reference tree under
`rebuild-vscode/reference/vscode`), not re-invented from blog posts.

The course it follows builds the editor exercise by exercise (00 → 13 so far). Every exercise is
implemented, unit-tested and then verified by **driving the real app** over the Chrome DevTools
Protocol: synthetic keystrokes, mouse drags, clipboard pastes, process listing, RSS sampling.
Where the port deliberately simplifies something, it says so — see the
[delta sections](#language-features-12-lsp-is-an-extension-pattern) and
[known deltas](#known-deltas-worth-knowing-before-extending).

## What works today

**Workbench shell** — titlebar, activity bar, sidebar, editor area (split groups + tabs), panel,
status bar; draggable sashes with persisted sizes; focus tracking through context keys.

**Editor** — virtualized line rendering (the 100 000-line gate), cursor/selection with mouse,
double-click-word, drag-select, keyboard movement (word/line/page/home-toggle arrows), IME
composition, undo/redo with cursor-state restore and save points, per-tab view state, dirty
tabs, line numbers (`on`/`off`/`relative`), live font/tab settings.

**Text model** — UTF-16 offsets, atomic edit operations with inverse operations, version ids,
CRLF detection, save points (Alt-editing semantics).

**Files & workspace** — a main-process file service behind one `file` channel; atomic saves
(temp + fsync + rename); deletes to the OS trash; a recursive watcher with 100 ms coalescing and
a stale-delete guard; Explorer with create/rename/delete/refresh; a single-folder workspace
(`.mini/settings.json`), restored on relaunch; external-change reloads and dirty-file warnings.

**Configuration** — registry-driven defaults, user `settings.json`, workspace settings, live
reload, `keybindings.json` with rebind-wins semantics, chord support with a pending-chord
indicator.

**Commands & keys** — command registry with metadata, context keys, quick pick, command palette,
and a real keybinding resolver (weights + when-clauses + user overrides).

**Extensions** — an extension host in its own `utilityProcess`, activation events
(`onStartupFinished`, `onCommand:…`, `onLanguage:…`), a `vscode` API subset (commands, window
toasts/status bar, workspace configuration/documents, languages providers + diagnostics, env),
console forwarding, clean shutdown on reload. Samples: `hello`, `wordcount`, and `toy-lang`
(a real LSP client/server pair).

**Language features** — owner-isolated markers/diagnostics, squiggles + gutter dots, a suggest
widget (trigger characters, filtering, `isIncomplete` refetch, cancelling superseded fetches),
hover tooltips with markdown-lite, and a problems picker driven from the status bar.

**Terminal** — a separate pty host process owning `node-pty` sessions, 5 ms data batching, real
flow control (pause/resume watermarks + acks), xterm.js front end, multiple terminals, tabs with
kill/respawn, resize propagation, config-driven fonts, exit banners.

## Architecture

```
      renderer (the workbench: parts · editor · explorer · terminal · suggest/hover)
        │                        │                           │
        │ window channel (IPC)   │ MessagePort               │ MessagePort
        │                        │ (direct — main relays     │ (direct)
        ▼                        ▼  neither end)             ▼
   main process            extension host               pty host
   window · storage        (utilityProcess)             (utilityProcess)
   file service+watcher    the `vscode` API for         node-pty sessions
   scanner · menus         the sample extensions        batching + flow control
        │                        ▲                           ▲
        └────── utilityProcess.fork ───────────────────────────┘
```

- **main** owns the OS: windows, the file system + watcher, dialogs, the extension scanner and
  the two utility processes. Cross-process RPC rides one hand-written proxy-channel IPC (02).
- **renderer** is the workbench; it talks to main over the `window`/`storage`/`file` channels,
  and to the extension/pty hosts over transferred `MessagePort`s (no relaying through main).
- **utility processes** keep native/risky work out of the UI thread: extensions can crash
  without taking the window down, and `yes` floods the pty host, not the renderer.

## Repository layout

```
mini-vscode/
├── src/
│   ├── common/                 # shared: base (lifecycle, events, uri, ipc),
│   │                           # platform (configuration, files, storage, log, window,
│   │                           #           extensions, terminal), editor model core
│   ├── main/                   # Electron main: window channels, file service, menu,
│   │                           # extension scanner, utility-process starters
│   ├── preload/                # the contextBridge surface (IPC + MessagePort bridges)
│   ├── renderer/               # the workbench
│   │   ├── base/               # DOM helpers, split view
│   │   ├── platform/           # renderer platform: commands, context keys, keybindings,
│   │   │                       # quick input
│   │   ├── editor/             # the code editor: view, layers, controllers, contribs
│   │   │                       # (suggest, hover, marker decorations)
│   │   └── workbench/          # contrib (files, problems, terminal), services (editor,
│   │                           # markers, extensions, languages), parts, bootstrap
│   ├── extHost/                # the extension host entry + the `vscode` API shim
│   └── ptyHost/                # the pty host: node-pty wrapper, process registry, entry
├── extensions/
│   ├── hello/                  # toast round-trip sample
│   ├── wordcount/              # status-bar + config sample
│   └── toy-lang/               # the exercise-12 language: client (LSP) + server + grammar
├── scripts/
│   ├── build.mjs               # esbuild bundles (main · preload · renderer · hosts · samples)
│   └── test.mjs                # bundles tests with esbuild, runs `node --test`
└── tests/                      # 177 unit tests over the pure logic (plus a file-system harness)
```

The read-only VS Code reference tree lives alongside the repo
(`../rebuild-vscode/reference/vscode`) and every ported file cites paths into it.

## Getting started

**Requirements:** Node 22+ (developed on Node 26), macOS. The port targets macOS defaults
(`Cmd` bindings, `$SHELL`, running the pty host under Electron's node); Windows/Linux would
need their platform defaults in a handful of files.

```bash
npm install          # electron, esbuild, typescript, node-pty, @xterm/xterm
npm start            # build + launch the app
# or, for iteration:
npm run build        # one-off build into out/
npm run watch        # rebuild on change (keep it running in a second terminal)
npm test             # bundle + run the unit tests (node's built-in runner, zero deps)
npx tsc --noEmit     # strict typecheck
```

First run: the app creates `~/Library/Application Support/mini-vscode/` (its `settings.json`,
`keybindings.json`, `storage.json` and the extension-scan cache). The bundled samples under
`extensions/` are scanned from the app directory — nothing to install.

A few things to try:

- open a folder (Explorer → Open Folder) and edit a file; watch the dirty dot and `Cmd+S`;
- `Cmd+Alt+P` for the command palette (from `keybindings.json`), `Cmd+J` for the terminal;
- open `extensions/toy-lang/sample.cfg` (shipped with the toy language) to watch the LSP server
  produce diagnostics, completions and hover docs — the last three lines are deliberately wrong;
- type `yes` in the terminal for a few seconds and watch the flow-control pauses in the log.

> **node-pty note:** newer npm versions ask before running install scripts. If the terminal
> fails with `posix_spawnp failed`, run `npm install-scripts approve node-pty` (or
> `chmod +x node_modules/node-pty/prebuilds/<platform>/spawn-helper`). `scripts/build.mjs`
> re-applies the `+x` on every build, so a plain rebuild also heals it.

## Testing

Two layers, both part of the workflow:

1. **Unit tests** (`npm test`) over the pure logic: the text model and its edit/undo semantics,
   the keybinding resolver (including the terminal `Cmd+K` chord matrix), the marker service's
   owner isolation, the toy grammar, LSP framing (byte lengths, coalesced frames, >64 KB
   payloads), terminal batching and flow-control watermarks, env curation, the file watcher,
   the in-memory file-system harness, and more — **177 tests**, no test dependencies (esbuild
   bundles, `node --test` runs).
2. **Live acceptance** — every exercise was verified against the running app over CDP:
   synthetic typing and keybindings, mouse drags on sashes, clipboard pastes, screenshots,
   `ps`/RSS sampling and log greps. Examples of what that caught: the occluded-window
   `requestAnimationFrame` hang (a reload could never finish in a background window), the
   size-observer that swallowed resizes, a missing `port.start()` on the pty host's MessagePort,
   and extension-contributed settings never reaching the host.

## The exercises

Each commit is one exercise: implementation + tests + live acceptance + documented deltas.

| # | Commit | What it builds |
| --- | --- | --- |
| 01 (+ 00) | `instantiation core + lifecycle/event/uri primitives` | the DI container, disposables, events, URI, platform primitives |
| 02 | `proxy-channel IPC across main and renderer` | channels, proxies, the wire envelope, preload bridge |
| 03 | `workbench shell with parts and split views` | titlebar/activitybar/sidebar/editor/panel/statusbar, sashes, layout state |
| 04 | `commands, context keys, quick pick and command palette` | the command registry, context keys, quick input, palette |
| 05 | `keybinding resolution with chords and user overrides` | the resolver (weights, when-clauses, chords), `keybindings.json` |
| 06 | `configuration layering, live reload, storage service` | defaults < user < workspace settings, live push, storage |
| 07 | `text model with edits, undo stack and save points` | the buffer, edit operations, undo/redo, versions |
| 08 | `editor view with cursor, selection, input and virtualization` | the rendering layers, controllers, IME, perf gate |
| 09 | `editor service, groups, tabs and dirty lifecycle` | open/reuse/close, groups, tabs, dirty + save flows |
| 10 | `file service, watcher, explorer, workspace` | the file channel, atomic writes, watcher, tree, workspace folder |
| 11 | `extension host, API subset, sample extensions` | the utility-process host, `vscode` API shim, activation events |
| 12 | `markers, suggest, hover and an LSP toy language` | providers ↔ LSP, diagnostics, the suggest/hover widgets, problems |
| 13 | `pty host, flow-controlled terminal, xterm panel` | the pty process, batching + acks, xterm tabs, resize |
| 14 | `packaged app, CLI, updates` | the production build gate, electron-builder, the `mini` CLI + single instance, About, the update loop |

(Exercise 00's primitives — lifecycle, events, URI, instantiation — landed in the first commit
alongside 01.)

## How this was built

- **Port from the reference, not from memory.** Every ported file cites the reference paths in
  its header; constants (flow-control watermarks, batching intervals, severity bit flags, default
  keybindings, font sizes) were read out of the reference revision rather than guessed. Where the
  exercise prose and the reference disagree, the reference wins and the deviation is noted in
  code; where the course pins a classic behavior the revision has since dropped (the terminal's
  exit banner), the pin wins and the delta is documented.
- **Deltas are first-class.** The sections below list every deliberate simplification, so
  extending the project starts from an honest map instead of archaeology.
- **Acceptance drives the last mile.** Unit tests prove the logic; the CDP runs prove the
  product (focus states, layout timing, process lifecycles, IPC ports — the class of bug that
  unit tests never see).

---

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

## The terminal (13): pty host + flow control + xterm

Real architecture, real constants:

- **A separate pty host process** (`src/ptyHost/`, forked by `src/main/terminal/ptyHostStarter.ts`)
  owns the `node-pty` sessions. The MessagePort dance is 11's, done twice (main keeps neither
  end); the renderer talks to `IPtyHostService` through 02's proxy channels — `$createProcess`,
  `$start`, `$input`, `$ackData`, `$resize`, `$shutdown` and the `onProcessData/Ready/Exit`
  events, the ported channel shape.
- **Flow control is the real thing**: `FlowControlConstants` ported verbatim (pause above
  100 000 unacknowledged chars, resume below 5 000, ack every 5 000). The renderer acks from the
  `xterm.write` CALLBACK (parsed, not received — acking on receive makes the mechanism
  decorative). A `yes` flood measures ~600 pause/resume pairs per 5s with bounded RSS.
- **Batching** is `TerminalDataBufferer`'s 5ms window (pty → buffer → flush), the layer that
  keeps the IPC from drowning in one message per pty read.
- The **start order** is the ported one: open xterm → fit → `$createProcess(cols, rows)` →
  `$start`, then an explicit resize so the pty matches the fitted grid (the classic
  zsh-first-prompt fix). Fitting is guarded to visible, sized terminals (#1 multi-terminal bug).
- **`attachCustomKeyEventHandler`** implements the ported rule: the workbench keybindings get
  first refusal on every keypress; only otherwise does xterm consume it. That is what makes
  `Cmd+K` clear work inside the terminal and the `Cmd+K Cmd+A` chord work in the editor.
- Killing the pty host externally marks every terminal dead with the reference's message; the
  next `createTerminal` lazily respawns the host (real restores sessions — delta).

Deltas specific to 13:

- **Exit handling**: this reference revision DISPOSES a terminal whose process exits; the course
  pins the classic behavior, so the tab persists with the ported `formatMessageForTerminal`
  banner (` * [exited with code N] `) and stdin is disabled (the real `disableStdin` too).
- Shell resolution is `$SHELL` (no profiles/shell integration/`$PS1` injection); no reconnect,
  no webgl renderer, no images protocol, no link handling beyond xterm's defaults, no
  `terminal.integrated.commandsToSkipShell` interpretation.
- `terminal.integrated.fontFamily` defaults to a fixed monospace stack (the real one defaults to
  the editor font family); `fontSize` is 12 on macOS / 14 elsewhere (the reference constant).
  A scrollback change resizes xterm's buffer live and trims content beyond the new cap.
- The xterm theme is a fixed palette from the workbench colors (no theme registry yet);
  `xterm.css`'s black viewport is overridden in `workbench.css` (load order matters).
- `confirmOnKill` ports the reference enum (`never/editor/panel/always`, default `editor`).
  Our terminals live only in the panel, so `editor` never asks; `panel`/`always` ask only when
  the pty shell has child processes (a lazy `ps` scan — the real one monitors continuously).
- **Occluded-window lesson** (found by the reload acceptance): `requestAnimationFrame` never
  fires in a background window. `scheduleAtNextAnimationFrame` now backstops with a timer (the
  same trick 08's view used), the bootstrap's `onStartupFinished` wait is a rAF/timer race, and
  the panel fits on the part's synchronous `layout()` instead of relying on observers.
- node-pty is native: esbuild keeps it external (`out/ptyHost.cjs` requires it from
  `node_modules`) and `scripts/build.mjs` re-applies `+x` to its `spawn-helper` (some npm
  installs skip the postinstall — without it every spawn fails with `posix_spawnp failed`).

## Shipping (14): packaged app, CLI, updates

Four products, each ported in shape from the reference:

- **Production build** — `scripts/build.mjs --production` minifies, drops sourcemaps, defines
  `process.env.NODE_ENV`, and gates the result: per-entry bundles only, per-bundle size caps and
  a marker table asserting nothing crosses lanes (no xterm in main, no `node-pty` outside the
  pty host, `require("node-pty")` stays external). The metafile lands in `out/build-meta.json`.
  A `createRequire` banner gives the ESM main bundle a real `require` for the bundled CJS
  updater — without it the updater dies with "Dynamic require of 'fs' is not supported".
- **The bundle** — `electron-builder.config.cjs` + `scripts/dist.mjs`: an explicit asar
  allowlist, `dmg` + `zip` (the updater consumes the zip + `latest-mac.yml`), and the generic
  publish feed at `http://localhost:8123` (`scripts/updates-server.mjs` serves `dist/`).
  Ad-hoc signing runs in electron-builder's `afterPack` hook so the ZIP carries the same
  signature as the installed app. `scripts/check-dist.mjs` asserts Info.plist ↔ product.json
  equality, the asar contents, the unpacked spawnables, the feed file and the signature.
- **The `mini` CLI** — `resources/cli/mini` ports `code`'s symlink-chain `app_realpath`; the main
  process owns the argv decision table (`common/platform/cli/common/cliArgs.ts`, unit-tested):
  `--open-folder` / `--open-file` / bare paths open as workspace or editor once ready, and a
  nonexistent path reports cleanly. A second launch forwards through
  `app.requestSingleInstanceLock()` + the `second-instance` event (the real CLI talks to the
  running instance over a socket — delta). `Shell Command: Install 'mini' command in PATH`
  symlinks into `/usr/local/bin` with a `~/bin` fallback ("install" state: this machine's
  `/usr/local/bin` needs admin rights, so `~/bin` is what the acceptance exercises).
- **Updates + About** — `src/main/update/updateService.ts` keeps the reference's state-machine
  vocabulary (idle → checking → available → downloading → ready → updating), checks on a 30s
  timer and on demand (`workbench.action.checkForUpdates`), and surfaces "Update available: vX"
  as 11's toast with a "Restart to Update" action plus a status-bar `⇧ restart to update` entry
  (the real release badges the gear — delta). `workbench.action.showAboutDialog` opens an HTML
  modal with product.json + runtime versions; Copy goes through the main process clipboard so
  it works without a trusted user gesture. A pre-window startup failure shows a native
  `Copy Error` dialog (the reference's startup-error path).

Deltas specific to 14:

- **Ad-hoc signatures cannot auto-update on macOS.** Squirrel.Mac derives its requirement from
  the running app's code signature — for an ad-hoc signature that requirement is the app's
  cdhash, which no rebuilt bundle can satisfy. The service detects an ad-hoc signature and, on
  "Restart", installs the already-downloaded zip locally (a detached script waits for the exit,
  swaps the bundle, relaunches with the original argv). A Developer-ID-signed build takes the
  normal `quitAndInstall` path; the user-visible flow is identical. `build/README.md` carries
  the full signing story.
- node-pty ships OUTSIDE the asar as an extraResource: its own asar workaround rewrites
  `app.asar` → `app.asar.unpacked`, which corrupts a path that already contains
  `app.asar.unpacked` — a packaged pty host fails with `posix_spawnp failed` otherwise.
- The CLI is mac-only (no Windows `.cmd` launcher), no portable mode, no universal/x64 or
  Windows/Linux artifacts, no notarization pipeline, no update-server signing or staged
  rollouts (all listed again in `build/README.md`).

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
