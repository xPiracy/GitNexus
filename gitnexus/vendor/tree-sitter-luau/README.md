## GitNexus vendor notice

This runtime package vendors the MIT-licensed
[polychromatist/tree-sitter-luau](https://github.com/polychromatist/tree-sitter-luau)
grammar at commit
[`71b03e66b2c8dd04e0133c9b998a54a58f239ca4`](https://github.com/polychromatist/tree-sitter-luau/commit/71b03e66b2c8dd04e0133c9b998a54a58f239ca4).
Its upstream version is `0.3.0`; this maintained patch is
`0.3.0-g71b03e6-gitnexus.1`. The parser is generated with Tree-sitter CLI
`0.25.1`, targeting grammar ABI **14**, and uses GitNexus's Tree-sitter
**0.25.1** runtime.

### Local changes

The exact handwritten grammar/scanner changes are in
`patches/gitnexus.patch`. Generated `src/parser.c`, `src/grammar.json`, and
`src/node-types.json` are refreshed from that grammar. Changes cover:

- Generic packs in vararg annotations and tuple tails; empty generic applications.
- `read` and `write` as table-property names alongside access qualifiers.
- `const` variables/functions while preserving contextual words as identifiers.
- Explicit method type arguments, such as `object:method<<number>>()`.
- Scanner rewind after a failed long-string probe, including `[false]`,
  `[function() end]`, and `[if flag then 1 else 2]`.
- Complete identifier scanning when a keyword prefix is followed by digits.
- Safe allocation growth for long identifiers; unsigned scanner-state bytes
  for long delimiters; a per-call string handler for concurrent parser workers.

Bindings follow GitNexus's existing vendored-grammar pattern: synchronous
CommonJS loader, Node-API language tag, source-build inputs, and Windows C11
compiler settings. The package has no install script or nested dependencies.
GitNexus supplies `node-addon-api` and `node-gyp-build`.

### Public regression tests

From the `gitnexus/` package directory, run:

```sh
node --test vendor/tree-sitter-luau/test/syntax.test.cjs
```

Fixtures are abstract, public examples. Tests exercise syntax, body/signature
distinction, UTF-16 positions, CRLF, scanner limits, incremental edits, recovery,
and parallel workers. A syntax tree without errors establishes syntax coverage;
it does not establish type correctness or resolve dynamic calls.

### Known bounds

The opt-in Luau parser features `if local` / `if const` and exported values
(`export const`, `export local`, `export function`) are not implemented. Their
fixtures remain explicit unsupported cases. This package does not claim every
experimental or future Luau grammar version. `export type`, including exported
type functions, is supported. Consumers must surface `ERROR`/missing nodes
instead of treating a recovered tree as a complete parse.

With the Node runtime's JavaScript-string input, `startIndex`, `endIndex`, and
position columns use **UTF-16 code units**. They can index JavaScript strings
directly. Official Luau AST coordinates and UTF-8 byte offsets require an
explicit conversion; never substitute one coordinate system for the other.

### Rebuilding and updating

1. Pin and record the upstream commit; retain its MIT license.
2. Rebase `patches/gitnexus.patch` and run `tree-sitter generate --abi 14`
   with CLI `0.25.1`.
3. Build the `tree_sitter_luau_binding` gyp target and run the public tests.
4. Build and validate prebuilds for each GitNexus-supported platform/architecture.
   The loader expects `prebuilds/<platform>-<arch>/tree-sitter-luau.node`.
5. Bump this package's version when generated sources or scanner behavior change.

Only the Linux x64 prebuild was built in the initial local verification.
Other platform prebuilds require the existing grammar-build CI matrix before
claiming toolchain-free installation on those targets. All source-build inputs
are included here; source builds still require the host compiler toolchain.
