# Experimental Roblox Luau analysis

Luau now enters GitNexus's regular parser-worker, scope-resolution, graph, and
parse-cache pipeline. Both `.luau` and `.lua` files use the vendored Luau grammar.
Analysis does not start Python or a language-server process. Agents can query the
persisted graph through GitNexus's existing tools and shared HTTP service.

Generate a [Rojo sourcemap](https://rojo.space/docs/v7/) at the project root before
analyzing Roblox instance-based requires:

```sh
rojo sourcemap --include-non-scripts default.project.json --output sourcemap.json
gitnexus analyze
```

For concurrent agents, start one shared MCP server:

```sh
gitnexus mcp --http --port 3111
```

Point each client at `http://127.0.0.1:3111/mcp`; see the existing
[shared-server setup](cli-reference.md#multi-client-setups-use---http-not-stdio).

The native resolver reads root `sourcemap.json`. It resolves proven instance paths
and filesystem-relative string requires; a missing or ambiguous target remains
unresolved. It does not discover `.project.json` files, run Rojo, connect to Studio,
or load `.luaurc` aliases automatically. Keep the map current when the project
changes. Normal repository exclusions and file-size limits still apply: parsing
support does not override ignored files or include dependency folders by itself.

The consumed map has a separate content-hash receipt, including an explicit
absent-file state. `analyze`, CLI `status`, and `analyze --watch` detect its
creation, edits, and deletion even when it is ignored or exceeds the source-file
size limit. MCP's existing staleness field measures `HEAD`; use analysis/watch
and CLI status for working-tree and configuration freshness.

## Native graph coverage

The parser records positional identities for named, nested, and anonymous
functions, type declarations, local bindings, table fields, and record-type
fields. Coordinates distinguish same-named declarations and closures. Call sites
belong to their innermost function, including multiple functions on one line.
Static `require` targets become `IMPORTS` edges through the existing resolver.
Local state reads and writes use `ACCESSES` edges anchored to the original
binding, with the access kind retained in the edge reason. Table and record
members use the existing property/ownership relationships; closure-built objects
do not need invented class declarations. Type-only references remain separate
from runtime calls.

This remains experimental. Capturing a call site does not prove its target.
Runtime-created objects, reassigned values, injected callbacks, and dynamically
selected table keys need explicit resolution evidence. Empty caller results must
not be treated as proof that a symbol is unused. Dedicated error-raise and
test-to-module relationships are not implemented. No full-program completeness
or multi-agent RAM reduction has been measured.

## How Serena informs the design

The implementation studies Serena's document identity, symbol normalization,
reference ownership, and session/cache lifecycle. GitNexus keeps its own native
semantic model and persisted graph; no Serena Python service is required for
analysis. Exact syntax ranges provide nested-function ownership, while workspace
configuration must participate in resolution invalidation.

The optional protocol exporter below preserves an earlier experiment with the
MIT-licensed SolidLSP Luau launch configuration. Its module-only output is separate
from the native graph and is not evidence of function-relationship completeness.

## Optional language-server module export

`gitnexus luau-graph` exports module dependencies through the
[Luau language server](https://github.com/JohnnyMorganz/luau-lsp) as DOT
(Graphviz graph text). This command does not populate the persisted graph.

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
An explicit command invocation treats either extension as Luau.
Paths to the seed, sourcemap, definitions, and docs
are relative to `--project` (the current directory by default). A relative
`--server` path is relative to the caller's current directory.

```sh
gitnexus luau-graph src/server/init.server.luau --project /path/to/game
gitnexus luau-graph src/server/init.server.luau --current-file
gitnexus luau-graph src/server/init.server.luau --security-level None --timeout 120
```

By default the export includes the server's indexed workspace, including modules
unreachable from the seed. `--current-file` restricts the request to the seed's
dependency graph. Roblox exports default to `sourcemap.json` at the project root.
Use `--sourcemap <path>` to select a map generated from the intended production,
development, or test project. The map may be outside the workspace; its canonical
file path is passed to Luau LSP after validating that it contains a JSON object.
Keep it current when files or the Rojo project change. `--platform standard`
rejects this Roblox-only option. This command neither runs Rojo nor connects to
Roblox Studio.

For a development map stored outside the checkout, use absolute source paths:

```sh
rojo sourcemap dev.project.json --absolute --include-non-scripts --output ../dev.sourcemap.json
gitnexus luau-graph src/server/init.server.luau --sourcemap ../dev.sourcemap.json > modules.dot
```

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
| Workspace configuration | Platform plus the selected Roblox `sourcemap.sourcemapFile`, returned once per requested item              |
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

## Validation

```sh
cd gitnexus
npm test -- test/unit/luau-configuration.test.ts test/unit/luau-session.test.ts test/unit/luau-graph-command.test.ts
npx vitest run test/unit/scope-resolution/luau test/unit/luau-module-resolution.test.ts test/integration/luau-provider-cache.test.ts
npx tsc --noEmit
npm run typecheck:tests
```

The native tests exercise the real grammar, parser workers, durable parse-cache
replay, and configuration-only invalidation. Database fixtures separately verify
persisted call targets after a sourcemap edit, deletion, and recreation.

The optional exporter tests use real files and subprocess pipes; a small protocol
fixture replaces the external language server. A separate live smoke test with
Luau LSP 1.63.0 verified an unopened, disconnected module pair and an isolated
file. Language-server installation/network access is not required by the unit
suite.
