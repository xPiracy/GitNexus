# Experimental Luau workspace graph

`gitnexus luau-graph` exports module dependencies through the native
[Luau language server](https://github.com/JohnnyMorganz/luau-lsp). Output is DOT
(Graphviz graph text). This is the first part of a Roblox Luau port: it does not
add Luau to `analyze`, populate LadybugDB, or enable Luau `context`/`impact` queries.

## Roblox usage

Install `luau-lsp` on PATH or pass `--server /path/to/luau-lsp`. This implementation
was verified against **1.63.0**, the version pinned by the referenced Serena
adapter. Executable installation is not automatic.

From the game project directory, generate the mapping between Roblox instances
and local source files using [Rojo](https://rojo.space/docs/v7/):

```sh
rojo sourcemap --include-non-scripts default.project.json --output sourcemap.json
gitnexus luau-graph src/server/init.server.luau > modules.dot
```

The seed must be an existing `.luau` or `.lua` file inside the chosen workspace.
An explicit command invocation treats either extension as Luau; it does not
change GitNexus's language detection. Paths to the seed, definitions, and docs
are relative to `--project` (the current directory by default). A relative
`--server` path is relative to the caller's current directory.

```sh
gitnexus luau-graph src/server/init.server.luau --project /path/to/game
gitnexus luau-graph src/server/init.server.luau --current-file
gitnexus luau-graph src/server/init.server.luau --security-level None --timeout 120
```

By default the export includes the server's indexed workspace, including modules
unreachable from the seed. `--current-file` restricts the request to the seed's
dependency graph. `sourcemap.json` must exist at the Roblox project root; keep it
current when files or the Rojo project change. This command neither runs Rojo nor
connects to Roblox Studio.

## Settings ported from Serena

The launch and initialization settings come from the MIT-licensed
[SolidLSP Luau adapter at e14b025](https://github.com/oraios/serena/blob/e14b02501da872394ada13f0b3f941056d462eee/src/solidlsp/language_servers/luau_lsp.py).
The original copyright and permission notice are retained in `configuration.ts`.

| Setting                 | Default / behavior                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Platform                | `roblox`; `--platform standard` selects standalone Luau                                                   |
| Roblox security level   | `PluginSecurity`, matching Serena; configurable to `None`, `LocalUserSecurity`, or `RobloxScriptSecurity` |
| Definitions             | `--definitions:@roblox=<path>` with the chosen security level                                             |
| Documentation           | Roblox `en-us.json`, or standalone `luau-en-us.json`                                                      |
| Workspace configuration | `{ "platform": { "type": "roblox" } }`, returned once per requested item                                  |
| Initialization          | File URI/workspace root plus Serena's document, navigation, symbol, and workspace capabilities            |

Support files are downloaded from `https://luau-lsp.pages.dev` and reused under
`<GitNexus home>/luau-lsp/`. The existing `GITNEXUS_HOME` setting controls that
location. Downloads allow at most three redirects within the same HTTPS origin,
have a 30-second deadline per file and a 20 MiB size limit, and publish only
complete files. Cached files are not refreshed automatically. Unlike Serena's
best-effort auxiliary downloads, failure here stops the export.

For offline or reproducible use, provide your own support files:

```sh
gitnexus luau-graph src/server/init.server.luau \
  --definitions /path/to/globalTypes.None.d.luau \
  --docs /path/to/en-us.json

gitnexus luau-graph main.luau --platform standard --docs /path/to/luau-en-us.json
```

`--security-level` chooses the downloaded file; when `--definitions` is supplied,
the contents of that file determine the available Roblox API types.

## Lifecycle and limits

Each invocation starts **one native server**, opens the seed, exports the graph,
then sends `shutdown` and `exit`. No Python process is started. A timeout,
interruption, server error, or indexing warning fails the command with a nonzero
status; shutdown is bounded and an unresponsive child is killed. DOT is written
to stdout only after export completes. Messages go to stderr.

The bridge uses the server's ordered configuration/didOpen handling, not a timed
sleep or the early `server initialized!` log, to wait for initial workspace
indexing. See the pinned
[message handler](https://github.com/JohnnyMorganz/luau-lsp/blob/1.63.0/src/LanguageServer.cpp)
and [workspace indexer](https://github.com/JohnnyMorganz/luau-lsp/blob/1.63.0/src/Workspace.cpp).

The graph contains module `require` relationships, not function calls. Its
coverage depends on Luau LSP's indexed files, configuration, resolver, and the
Rojo sourcemap. The server's default 10,000-file cap produces a warning; the
bridge refuses that export. Dynamic module names and runtime-created instances
are not guaranteed to resolve. Type diagnostics are not a completeness check.

This first slice does **not** share servers between invocations or agents, and
does not claim measured memory savings. It also does not port Serena's executable
downloader or its separate directory-walking exclusions.

## Next steps

1. Connect the adapter to a shared HTTP MCP host, with one session per canonical
   worktree, coordinated edits, and bounded idle lifetime.
2. Import symbols and resolved module edges into GitNexus's language/provider
   pipeline without adding language branches to shared ingestion code.
3. Add function-call relationships and source-change invalidation, preserving
   explicit unresolved/partial results.
4. Measure RAM with several agents using the same checkout and separate worktrees.

## Validation

```sh
cd gitnexus
npm test -- test/unit/luau-configuration.test.ts test/unit/luau-session.test.ts test/unit/luau-graph-command.test.ts
npx tsc --noEmit
npm run typecheck:tests
```

The tests use real files and subprocess pipes; a small protocol fixture replaces
the external native server. A separate live smoke test with Luau LSP 1.63.0
verified an unopened, disconnected module pair and an isolated file. Live native
server installation/network access is not required by the unit suite.
