# toy-lang

The exercise-12 toy language, built the real way: this extension is only the CLIENT. It spawns
`out/server.js` (a separate process, `vscode-languageserver`) and speaks LSP to it with a
hand-rolled JSON-RPC client (`Content-Length` framing over stdio). The workbench itself knows
nothing about LSP — it only sees the providers this extension registers.

## The toy language (toycfg, `*.cfg`)

```
# a comment
[path.to.section]
name = auto
entry = true
timeout = 30

[log]
level = auto        # ← unknown keys and bad values get squiggles
```

- lines are `key = value`;
- `[path.to.section]` starts a section (`log.level` addresses a key in a section);
- `# …` comments run to the end of the line;
- known keys: `name`, `entry`, `timeout`, `workers`, `log.level`, `flags`
  (in a section, the section name is prefixed: `[log]` + `level` = `log.level`);
- values: `true` / `false` / `auto` or a number — nothing else is a valid value.

## Diagnostics

| case | severity |
| --- | --- |
| line without `=` | Error — `Expected 'key = value'` |
| key not in the known list | Warning — `Unknown key 'x'` |
| the same key twice in one section | Warning — `Duplicate key 'x'` |
| value that is not `true`/`false`/`auto`/number | Warning — `Invalid value 'x'` |

`toyLang.maxNumberOfProblems` (default 100) truncates the list; the server logs the truncation
to stderr.

## Completions & hover

- at line start (or after a section header): the known key names plus `[` for a new section;
- after `=`: `true`, `false`, `auto` and a number — returned with `isIncomplete: true`, so the
  client re-queries while you type (watch the server log);
- hovering a known key shows its description and allowed values as markdown.

## Client capabilities declared to the server

`textDocumentSync: Full`, `completion` (with `triggerCharacters: ['=', '[', ' ']`),
`hover`, `publishDiagnostics`. Nothing else — those are the four features this exercise wires.
