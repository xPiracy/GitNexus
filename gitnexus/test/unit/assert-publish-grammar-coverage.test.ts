import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { globSync } from 'glob';

/**
 * Coverage for the publish guard `scripts/assert-publish-grammar-coverage.cjs`.
 *
 * The guard refuses to pack/publish if a vendored grammar would ship with no
 * loadable binding — i.e. the package.json `files` field was narrowed to drop the
 * vendored source while a grammar still lacks 6/6 prebuilds. (`.npmignore` can't
 * exclude the vendored subtree — `files` overrides it — so `files` is the only
 * lever, and the guard reads it directly rather than shelling out to `npm pack`.)
 * We test the pure decision core + the `files` check directly, and assert the real
 * repo state is publish-safe (catching a premature narrowing in CI).
 */
const requireCjs = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(
  new URL('../../scripts/assert-publish-grammar-coverage.cjs', import.meta.url),
);
const {
  findCoverageProblems,
  findPackedFilesProblems,
  filesShipsVendorSource,
  findStrayBuildArtifacts,
  collectGrammars,
} = requireCjs(SCRIPT);

describe('findCoverageProblems (pure decision core)', () => {
  it('passes when source ships, even with incomplete prebuilds (transitional state)', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 0, shipsSource: true }];
    expect(findCoverageProblems({ grammars })).toEqual([]);
  });

  it('fails when source is not shipped and a grammar lacks 6/6 prebuilds', () => {
    const grammars = [{ name: 'tree-sitter-kotlin', prebuilt: 4, shipsSource: false }];
    const problems = findCoverageProblems({ grammars });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('tree-sitter-kotlin');
    expect(problems[0]).toContain('not shipped');
    expect(problems[0]).toContain('2 platform-arch tuple(s)');
  });

  it('passes when source is not shipped but every grammar has all 6 prebuilds', () => {
    const grammars = [
      { name: 'tree-sitter-swift', prebuilt: 6, shipsSource: false },
      { name: 'tree-sitter-c', prebuilt: 6, shipsSource: false },
    ];
    expect(findCoverageProblems({ grammars })).toEqual([]);
  });

  it('fails when a grammar has neither prebuilds nor shipped source', () => {
    const grammars = [{ name: 'tree-sitter-x', prebuilt: 0, shipsSource: false }];
    const problems = findCoverageProblems({ grammars });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no loadable binding');
  });
});

describe('findPackedFilesProblems (files globs, not on-disk counts)', () => {
  const grammars = ['tree-sitter-c', 'tree-sitter-kotlin'];
  const lean = [
    'vendor/**/prebuilds/**',
    'vendor/**/bindings/node/index.js',
    'vendor/**/package.json',
    'vendor/leiden/index.cjs',
    'vendor/leiden/utils.cjs',
  ];

  it('passes the current lean files list', () => {
    expect(findPackedFilesProblems({ filesField: lean, grammarNames: grammars })).toEqual([]);
  });

  it('fails when files only covers FTS plus one grammar prebuild', () => {
    const problems = findPackedFilesProblems({
      filesField: ['vendor/lbug-fts/prebuilds/**', 'vendor/tree-sitter-c/prebuilds/**'],
      grammarNames: grammars,
    });
    expect(problems.some((p: string) => p.includes('tree-sitter-kotlin'))).toBe(true);
    expect(problems.some((p: string) => p.includes('bindings/node/index.js'))).toBe(true);
    expect(problems.some((p: string) => p.includes('leiden'))).toBe(true);
  });

  it('fails when only one grammar binding is listed explicitly', () => {
    const problems = findPackedFilesProblems({
      filesField: [
        'vendor/**/prebuilds/**',
        'vendor/tree-sitter-c/bindings/node/index.js',
        'vendor/**/package.json',
        'vendor/leiden/index.cjs',
        'vendor/leiden/utils.cjs',
      ],
      grammarNames: grammars,
    });
    expect(problems.some((p: string) => p.includes('tree-sitter-kotlin'))).toBe(true);
    expect(problems.some((p: string) => p.includes('bindings/node/index.js'))).toBe(true);
  });

  it('fails when per-grammar package.json is omitted', () => {
    const problems = findPackedFilesProblems({
      filesField: [
        'vendor/**/prebuilds/**',
        'vendor/**/bindings/node/index.js',
        'vendor/leiden/index.cjs',
        'vendor/leiden/utils.cjs',
      ],
      grammarNames: grammars,
    });
    expect(problems.some((p: string) => p.includes('package.json'))).toBe(true);
  });

  it('fails when Leiden entrypoints are dropped', () => {
    const problems = findPackedFilesProblems({
      filesField: ['vendor/**/prebuilds/**', 'vendor/**/bindings/node/index.js'],
      grammarNames: grammars,
    });
    expect(problems.some((p: string) => p.includes('leiden'))).toBe(true);
  });
});

describe('filesShipsVendorSource', () => {
  it('ships when a broad vendor entry is present', () => {
    expect(filesShipsVendorSource(['dist', 'vendor', 'web'])).toBe(true);
    expect(filesShipsVendorSource(['vendor/'])).toBe(true);
    expect(filesShipsVendorSource(['vendor/**'])).toBe(true);
    expect(filesShipsVendorSource(['vendor/*'])).toBe(true);
  });

  it('does NOT ship when files is narrowed to non-source subpaths (lean publish)', () => {
    expect(
      filesShipsVendorSource([
        'dist',
        'vendor/**/prebuilds/**',
        'vendor/**/package.json',
        'vendor/**/bindings/node/index.js',
      ]),
    ).toBe(false);
    expect(filesShipsVendorSource([])).toBe(false);
    expect(filesShipsVendorSource(undefined)).toBe(false);
  });
});

describe('per-grammar source fallback', () => {
  const prefix = 'vendor/tree-sitter-fixture';
  const sourceFiles = [
    `${prefix}/binding.gyp`,
    `${prefix}/bindings/node/binding.cc`,
    `${prefix}/src/parser.c`,
    `${prefix}/src/scanner.c`,
    `${prefix}/src/tree_sitter/**`,
    `${prefix}/src/helper.h`,
    `${prefix}/src/nested.h`,
  ];

  function withGrammar(run: (vendorDir: string, grammarDir: string) => void): void {
    const root = mkdtempSync(path.join(tmpdir(), 'vguard-source-'));
    const grammarDir = path.join(root, prefix);
    const contents: Record<string, string> = {
      'binding.gyp': JSON.stringify({
        targets: [{ sources: ['bindings/node/binding.cc', 'src/parser.c', 'src/scanner.c'] }],
      }),
      'bindings/node/binding.cc': '#include <napi.h>\n',
      'src/parser.c': '#include "tree_sitter/parser.h"\n',
      'src/scanner.c': '#include "tree_sitter/alloc.h"\n#include "helper.h"\n',
      'src/tree_sitter/parser.h': '',
      'src/tree_sitter/alloc.h': '',
      'src/helper.h': '#include "nested.h"\n',
      'src/nested.h': '',
    };
    for (const [relative, source] of Object.entries(contents)) {
      const target = path.join(grammarDir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    try {
      run(path.join(root, 'vendor'), grammarDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('accepts an explicit source set without broadening all vendor packages', () => {
    withGrammar((vendorDir) => {
      const grammars = collectGrammars(vendorDir, sourceFiles);
      expect(grammars[0]).toMatchObject({ prebuilt: 0, shipsSource: true });
      expect(findCoverageProblems({ grammars })).toEqual([]);
    });
  });

  it.each(['bindings/node/binding.cc', 'src/scanner.c', 'src/helper.h', 'src/nested.h'])(
    'rejects a source set that omits %s from the tarball',
    (missing) => {
      withGrammar((vendorDir) => {
        const files = sourceFiles.filter((entry) => entry !== `${prefix}/${missing}`);
        const grammars = collectGrammars(vendorDir, files);
        expect(grammars[0].shipsSource).toBe(false);
        expect(findCoverageProblems({ grammars })).toHaveLength(1);
      });
    },
  );

  it('rejects a set that omits included Tree-sitter headers', () => {
    withGrammar((vendorDir) => {
      const files = sourceFiles.filter((entry) => !entry.endsWith('tree_sitter/**'));
      expect(collectGrammars(vendorDir, files)[0].shipsSource).toBe(false);
    });
  });

  it.each(['bindings/node/binding.cc', 'src/scanner.c', 'src/helper.h', 'src/nested.h'])(
    'rejects missing on-disk build input %s even under a broad allowlist',
    (missing) => {
      withGrammar((vendorDir, grammarDir) => {
        rmSync(path.join(grammarDir, missing));
        const grammars = collectGrammars(vendorDir, ['vendor']);
        expect(grammars[0].shipsSource).toBe(false);
        expect(findCoverageProblems({ grammars })).toHaveLength(1);
      });
    },
  );

  it('does not credit source allowances for another grammar', () => {
    withGrammar((vendorDir) => {
      const otherFiles = sourceFiles.map((entry) =>
        entry.replace('tree-sitter-fixture', 'tree-sitter-other'),
      );
      expect(collectGrammars(vendorDir, otherFiles)[0].shipsSource).toBe(false);
    });
  });

  it('honors an explicit exclusion inside a source directory allowance', () => {
    withGrammar((vendorDir) => {
      const files = [`${prefix}/**`, `!${prefix}/src/helper.h`];
      expect(collectGrammars(vendorDir, files)[0].shipsSource).toBe(false);
    });
  });
});

describe('findStrayBuildArtifacts (stray vendor build dirs that would ship + shadow prebuilds)', () => {
  const mkVendor = (): string => mkdtempSync(path.join(tmpdir(), 'vguard-'));

  it('returns [] when no grammar has a build/ dir', () => {
    const dir = mkVendor();
    try {
      mkdirSync(path.join(dir, 'tree-sitter-y', 'prebuilds', 'linux-x64'), { recursive: true });
      writeFileSync(path.join(dir, 'tree-sitter-y', 'prebuilds', 'linux-x64', 'y.node'), '');
      expect(findStrayBuildArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a grammar that carries a stray build/ output (would shadow the prebuild)', () => {
    const dir = mkVendor();
    try {
      mkdirSync(path.join(dir, 'tree-sitter-x', 'build', 'Release'), { recursive: true });
      mkdirSync(path.join(dir, 'tree-sitter-y', 'prebuilds'), { recursive: true });
      expect(findStrayBuildArtifacts(dir)).toEqual(['vendor/tree-sitter-x/build']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-grammar dirs and a missing vendor dir', () => {
    const dir = mkVendor();
    try {
      mkdirSync(path.join(dir, 'leiden', 'build'), { recursive: true }); // not tree-sitter-*
      expect(findStrayBuildArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(findStrayBuildArtifacts(path.join(tmpdir(), 'vguard-does-not-exist'))).toEqual([]);
  });
});

describe('real repo publish-safety (prebuilds plus explicit source fallbacks)', () => {
  const GITNEXUS_ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const VENDORED = [
    'tree-sitter-c',
    'tree-sitter-dart',
    'tree-sitter-kotlin',
    'tree-sitter-objc',
    'tree-sitter-proto',
    'tree-sitter-swift',
    'tree-sitter-zig',
  ] as const;
  const TUPLES = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64',
  ] as const;

  const simulatePackedVendorFiles = (filesField: string[]): string[] => {
    const packed = new Set<string>();
    for (const pattern of filesField) {
      const n = String(pattern).replace(/\\/g, '/');
      if (!n.startsWith('vendor')) continue;
      for (const match of globSync(n, { cwd: GITNEXUS_ROOT, nodir: true, dot: false })) {
        packed.add(match.replace(/\\/g, '/'));
      }
    }
    return [...packed];
  };

  it('the script exits 0 against the committed repo state', () => {
    // Deterministic: reads package.json + walks vendor/ — no npm pack, fast.
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[publish-guard] OK');
    expect(r.stdout).toContain('prebuilds-only');
  });

  it('keeps existing grammars lean and includes every Luau fallback input', () => {
    const pkg = JSON.parse(readFileSync(path.join(GITNEXUS_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(filesShipsVendorSource(pkg.files)).toBe(false);
    expect(pkg.files).not.toContain('vendor');
    expect(pkg.files).toContain('vendor/**/prebuilds/**');
    expect(pkg.files).toContain('vendor/leiden/index.cjs');
    expect(pkg.files).toContain('vendor/leiden/utils.cjs');
    expect(pkg.files).toContain('vendor/lbug-fts/manifest.json');

    const packed = simulatePackedVendorFiles(pkg.files);
    const existing = packed.filter((p) => !p.startsWith('vendor/tree-sitter-luau/'));
    expect(existing.some((p) => /vendor\/tree-sitter-[^/]+\/src\/parser\.c$/.test(p))).toBe(false);
    expect(existing.some((p) => /vendor\/tree-sitter-[^/]+\/src\/scanner\.c$/.test(p))).toBe(false);
    expect(existing.some((p) => p.endsWith('binding.gyp'))).toBe(false);
    for (const relative of [
      'binding.gyp',
      'bindings/node/binding.cc',
      'src/parser.c',
      'src/scanner.c',
      'src/tree_sitter/parser.h',
      'src/tree_sitter/alloc.h',
      'src/luauts_pcg_hash_table.h',
    ]) {
      expect(packed).toContain(`vendor/tree-sitter-luau/${relative}`);
    }

    for (const name of VENDORED) {
      expect(packed, name).toContain(`vendor/${name}/package.json`);
      expect(packed, name).toContain(`vendor/${name}/bindings/node/index.js`);
      expect(packed, name).toContain(`vendor/${name}/src/node-types.json`);
      for (const tuple of TUPLES) {
        expect(
          packed.some(
            (p) => p.startsWith(`vendor/${name}/prebuilds/${tuple}/`) && p.endsWith('.node'),
          ),
          `${name} ${tuple}`,
        ).toBe(true);
      }
    }

    expect(packed).toContain('vendor/leiden/index.cjs');
    expect(packed).toContain('vendor/leiden/utils.cjs');
    expect(packed).toContain('vendor/lbug-fts/manifest.json');
    for (const tuple of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
      expect(packed).toContain(`vendor/lbug-fts/prebuilds/${tuple}/libfts.lbug_extension`);
    }
  });
});
