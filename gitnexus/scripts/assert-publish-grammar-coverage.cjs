#!/usr/bin/env node
/**
 * Publish guard: every vendored tree-sitter grammar must ship a loadable binding.
 *
 * The npm tarball ships a lean vendor/ allow-list (package.json `files`):
 * prebuilds, the bindings entry, node-types.json, and package metadata — not
 * generated parser.c, except for explicit per-grammar source fallbacks.
 * A grammar is "covered" on a platform-arch tuple if EITHER
 * a prebuild ships for it OR the grammar's full source-build set ships (so the
 * install can source-build it, toolchain permitting). Lean publish is safe ONLY
 * when each source-free grammar has all six prebuilds; dropping source while any grammar
 * still lacks a prebuild would ship a grammar with NO loadable binding.
 *
 * HOW SOURCE INCLUSION IS DECIDED. The `files` allow-list OVERRIDES `.npmignore`
 * for the vendored subtree (verified: an active "vendor/(star-star)/src/parser.c"
 * in .npmignore does NOT drop it from `npm pack`). So `.npmignore` can never
 * exclude vendored source — the ONLY lever is the `files` field. A broad `vendor`
 * ships the whole subtree (source + prebuilds); lean publish narrows `files` to
 * non-source subpaths. This guard therefore reads `files` directly rather than
 * shelling out to `npm pack` (which, in prepack, would re-enter this guard and,
 * on npm versions that don't honor --ignore-scripts for prepare/prepack, run the
 * full build — slow enough to time out and fragile).
 *
 * Wired via `prepack`, so it fails `npm pack` / `npm publish` if the invariant is
 * violated.
 */
const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');

const TUPLES = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];

// Every Node grammar needs these inputs. Additional sources come from
// binding.gyp and their local includes; absent files must not disappear from
// the required set merely because somebody deleted them from the checkout.
const SOURCE_BUILD_REL = [
  'binding.gyp',
  'bindings/node/binding.cc',
  'src/parser.c',
  'src/tree_sitter/parser.h',
];

/**
 * Does the package.json `files` allow-list ship the WHOLE vendor subtree (and
 * therefore the vendored grammar source)? A bare `vendor` (optionally with a
 * trailing slash or `/**`/`/*`) includes everything under vendor/. A lean publish
 * replaces that with narrower subpaths. A false result still permits complete
 * per-grammar source allowlists, which collectGrammars checks independently.
 */
function filesShipsVendorSource(filesField) {
  return filesEntries(filesField).includes('vendor');
}

function normalizeFilesEntry(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\/\*\*?$/, '');
}

function filesEntries(filesField) {
  return (filesField || []).map(normalizeFilesEntry);
}

function filesCoverGrammarPrebuilds(entries, grammarName) {
  if (entries.includes('vendor') || entries.includes('vendor/**/prebuilds')) return true;
  return (
    entries.includes(`vendor/${grammarName}/prebuilds`) || entries.includes(`vendor/${grammarName}`)
  );
}

function filesCoverGrammarBindings(entries, grammarName) {
  if (entries.includes('vendor') || entries.includes('vendor/**/bindings/node/index.js')) {
    return true;
  }
  return (
    entries.includes(`vendor/${grammarName}/bindings/node/index.js`) ||
    entries.includes(`vendor/${grammarName}`)
  );
}

function filesCoverGrammarPackageJson(entries, grammarName) {
  if (entries.includes('vendor') || entries.includes('vendor/**/package.json')) return true;
  return (
    entries.includes(`vendor/${grammarName}/package.json`) ||
    entries.includes(`vendor/${grammarName}`)
  );
}

function filesCoverLeiden(entries) {
  if (entries.includes('vendor') || entries.includes('vendor/leiden')) return true;
  return entries.includes('vendor/leiden/index.cjs') && entries.includes('vendor/leiden/utils.cjs');
}

/**
 * Packed-tarball coverage from `files` globs — not on-disk prebuild counts.
 * Lean publish can leave 6/6 `.node` files in the checkout while omitting
 * them from the pack list.
 */
function findPackedFilesProblems({ filesField, grammarNames }) {
  const entries = filesEntries(filesField);
  const problems = [];
  for (const name of grammarNames || []) {
    if (!filesCoverGrammarPrebuilds(entries, name)) {
      problems.push(`${name}: package.json files does not cover vendor/${name}/prebuilds`);
    }
    if (!filesCoverGrammarBindings(entries, name)) {
      problems.push(
        `${name}: package.json files does not cover vendor/${name}/bindings/node/index.js`,
      );
    }
    if (!filesCoverGrammarPackageJson(entries, name)) {
      problems.push(`${name}: package.json files does not cover vendor/${name}/package.json`);
    }
  }
  if (!filesCoverLeiden(entries)) {
    problems.push('package.json files does not cover vendor/leiden/index.cjs and utils.cjs');
  }
  return problems;
}

/** Required sources plus the transitive closure of their local C/C++ includes. */
function sourceBuildSet(grammarDir) {
  const required = new Set(SOURCE_BUILD_REL);
  const gyp = path.join(grammarDir, 'binding.gyp');
  if (fs.existsSync(gyp)) {
    // Gyp permits comments and commands, so it is not plain JSON. Only literal
    // source paths are needed here; never evaluate its commands in a guard.
    const contents = fs.readFileSync(gyp, 'utf8');
    for (const match of contents.matchAll(/["']([^"'\n]+\.(?:c|cc|cpp|cxx|m|mm))["']/g)) {
      required.add(match[1].replace(/\\/g, '/'));
    }
  }
  const queue = [...required].filter((rel) => rel !== 'binding.gyp');
  while (queue.length) {
    const relative = queue.pop();
    if (relative.startsWith('../') || path.isAbsolute(relative)) continue;
    const file = path.join(grammarDir, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(/^\s*#\s*include\s+"([^"\n]+)"/gm)) {
      const include = match[1].replace(/\\/g, '/');
      const beside = path.posix.normalize(path.posix.join(path.posix.dirname(relative), include));
      const underSrc = path.posix.normalize(path.posix.join('src', include));
      const dependency = fs.existsSync(path.join(grammarDir, beside))
        ? beside
        : fs.existsSync(path.join(grammarDir, underSrc))
          ? underSrc
          : beside;
      if (!required.has(dependency)) {
        required.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...required].sort();
}

/** All declared build inputs must exist, including scanner helper headers. */
function isBuildableFromSource(grammarDir) {
  return sourceBuildSet(grammarDir).every(
    (rel) =>
      !rel.startsWith('../') &&
      !path.isAbsolute(rel) &&
      fs.existsSync(path.join(grammarDir, rel)) &&
      fs.statSync(path.join(grammarDir, rel)).isFile(),
  );
}

/** Expand vendor allowlists once; directory entries also include descendants. */
function packedVendorMatcher(filesField, packageRoot) {
  const included = new Set();
  const excluded = new Set();
  for (const value of filesField || []) {
    const entry = String(value).replace(/\\/g, '/');
    const negative = entry.startsWith('!');
    const pattern = negative ? entry.slice(1) : entry;
    if (!/^vendor(?:\/|$)/.test(pattern)) continue;
    const target = negative ? excluded : included;
    for (const match of globSync(pattern, { cwd: packageRoot, dot: true })) {
      target.add(match.replace(/\\/g, '/').replace(/\/+$/, ''));
    }
  }
  const covers = (entries, relative) => {
    for (let current = relative; current !== '.'; current = path.posix.dirname(current)) {
      if (entries.has(current)) return true;
    }
    return false;
  };
  return (relative) => covers(included, relative) && !covers(excluded, relative);
}

/** Count platform-arch tuples with a committed prebuilt .node on disk. */
function countPrebuiltTuples(grammarDir) {
  const pdir = path.join(grammarDir, 'prebuilds');
  let n = 0;
  for (const t of TUPLES) {
    const td = path.join(pdir, t);
    try {
      if (fs.statSync(td).isDirectory() && fs.readdirSync(td).some((f) => f.endsWith('.node'))) {
        n++;
      }
    } catch {
      /* tuple dir absent — not covered */
    }
  }
  return n;
}

/**
 * Pure core (exported for tests). `grammars` is a list of
 * `{ name, prebuilt: 0..6, shipsSource: boolean }`. Returns human-readable
 * problem strings; an empty array means the pack is publish-safe.
 */
function findCoverageProblems({ grammars }) {
  const problems = [];
  for (const g of grammars) {
    if (g.prebuilt < 6 && !g.shipsSource) {
      const missing = 6 - g.prebuilt;
      problems.push(
        `${g.name}: ${g.prebuilt}/6 prebuilds and its vendored source is not shipped ` +
          `(the package.json \`files\` field excludes it, or it is not buildable) — would ship ` +
          `with no loadable binding on ${missing} platform-arch tuple(s).`,
      );
    }
  }
  return problems;
}

/**
 * Stray local source-build outputs under `vendor/<name>/build/`. These would
 * ship in the tarball (`files: ["vendor"]` overrides .gitignore/.npmignore) AND
 * shadow the committed prebuilds — `node-gyp-build` resolves `build/Release`
 * BEFORE `prebuilds/`, so a consumer on the publisher's platform would load the
 * stray (possibly stale/wrong) binding instead of the curated prebuild. The
 * build dir is gitignored and only appears if a maintainer source-built locally
 * (e.g. on a no-prebuild platform); refuse to publish it. (#2144 review.)
 */
function findStrayBuildArtifacts(vendorDir) {
  if (!fs.existsSync(vendorDir)) return [];
  return fs
    .readdirSync(vendorDir)
    .filter((d) => /^tree-sitter-/.test(d))
    .filter((d) => fs.existsSync(path.join(vendorDir, d, 'build')))
    .map((d) => `vendor/${d}/build`);
}

function collectGrammars(vendorDir, filesField) {
  if (!fs.existsSync(vendorDir)) return [];
  const isPacked = packedVendorMatcher(filesField, path.dirname(vendorDir));
  return fs
    .readdirSync(vendorDir)
    .filter((d) => /^tree-sitter-/.test(d))
    .map((name) => {
      const dir = path.join(vendorDir, name);
      const sourceInputs = sourceBuildSet(dir);
      const missingSourceInputs = sourceInputs.filter(
        (rel) =>
          rel.startsWith('../') ||
          path.isAbsolute(rel) ||
          !fs.existsSync(path.join(dir, rel)) ||
          !fs.statSync(path.join(dir, rel)).isFile() ||
          !isPacked(`vendor/${name}/${rel}`),
      );
      return {
        name,
        prebuilt: countPrebuiltTuples(dir),
        shipsSource: missingSourceInputs.length === 0,
        missingSourceInputs,
      };
    });
}

function main() {
  const gitnexusRoot = path.join(__dirname, '..');
  const vendorDir = path.join(gitnexusRoot, 'vendor');
  const pkg = JSON.parse(fs.readFileSync(path.join(gitnexusRoot, 'package.json'), 'utf8'));
  const grammars = collectGrammars(vendorDir, pkg.files);
  if (grammars.length === 0) {
    console.error(`[publish-guard] No vendored tree-sitter grammars found under ${vendorDir}.`);
    process.exit(1);
  }

  const stray = findStrayBuildArtifacts(vendorDir);
  if (stray.length > 0) {
    console.error(
      '[publish-guard] Refusing to publish — stray source-build output under vendor/ would\n' +
        'ship and shadow the committed prebuilds (node-gyp-build loads build/Release before\n' +
        'prebuilds/):',
    );
    for (const s of stray) console.error(`  - ${s}`);
    console.error('\nFix: remove it before packing, e.g. `rm -rf gitnexus/vendor/*/build`.');
    process.exit(1);
  }

  const problems = [
    ...findCoverageProblems({ grammars }),
    ...findPackedFilesProblems({
      filesField: pkg.files,
      grammarNames: grammars.map((g) => g.name),
    }),
  ];
  if (problems.length > 0) {
    console.error('[publish-guard] Refusing to publish — a vendored grammar would ship unusable:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix: either commit the missing prebuilds (run the build-tree-sitter-prebuilds\n' +
        'workflow) or keep the vendored source in the package.json `files` field.',
    );
    process.exit(1);
  }

  const sourceShippers = grammars.filter((g) => g.shipsSource).length;
  console.log(
    `[publish-guard] OK — ${grammars.length} vendored grammar(s) covered ` +
      `(${sourceShippers} shipping source, ${grammars.length - sourceShippers} prebuilds-only).`,
  );
}

if (require.main === module) main();

module.exports = {
  findCoverageProblems,
  findPackedFilesProblems,
  findStrayBuildArtifacts,
  filesShipsVendorSource,
  filesCoverGrammarPrebuilds,
  filesCoverGrammarBindings,
  filesCoverGrammarPackageJson,
  filesCoverLeiden,
  isBuildableFromSource,
  sourceBuildSet,
  countPrebuiltTuples,
  collectGrammars,
  TUPLES,
  SOURCE_BUILD_REL,
};
