import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadLuauResolutionConfig,
  loadRojoModuleMap,
  resolveLuauModule,
  type LoadRojoModuleMapOptions,
  type LuauStaticExpression,
} from '../../src/core/ingestion/languages/luau/module-resolution.js';

interface TestNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: TestNode[];
}

const game: LuauStaticExpression = { kind: 'game' };
const script: LuauStaticExpression = { kind: 'script' };
const member = (base: LuauStaticExpression, name: string): LuauStaticExpression => ({
  kind: 'member',
  base,
  name,
});
const service = (name: string): LuauStaticExpression => ({ kind: 'getService', base: game, name });
const literal = (value: string): LuauStaticExpression => ({ kind: 'string', value });
const binding = (name: string): LuauStaticExpression => ({ kind: 'binding', name });
const moduleNode = (name: string, file: string): TestNode => ({
  name,
  className: 'ModuleScript',
  filePaths: [file],
});

describe('Luau module resolution', () => {
  let root: string;
  let project: string;
  let sourceFiles: string[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gitnexus-luau-modules-')));
    project = path.join(root, 'project');
    await mkdir(project);
    sourceFiles = [];
    await source('src/main.luau');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function source(file: string) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), 'return {}\n');
    sourceFiles.push(file);
    return file;
  }

  async function map(children: TestNode[], options: Partial<LoadRojoModuleMapOptions> = {}) {
    // The artifact lives outside the project, while its filePaths are project-relative.
    const sourcemapPath = path.join(root, 'generated-map.json');
    await writeFile(
      sourcemapPath,
      JSON.stringify({ name: 'Synthetic', className: 'DataModel', children }),
    );
    return loadRojoModuleMap({ projectPath: project, sourcemapPath, sourceFiles, ...options });
  }

  it('anchors map paths to the project and resolves a module backed by init.luau', async () => {
    await source('src/library/init.luau');
    const config = await map([
      {
        name: 'ReplicatedStorage',
        className: 'ReplicatedStorage',
        children: [moduleNode('Library', 'src/library/init.luau')],
      },
    ]);
    const result = resolveLuauModule(config, {
      fromFile: 'src/main.luau',
      expression: member(service('ReplicatedStorage'), 'Library'),
    });
    expect(result).toMatchObject({ status: 'resolved', filePath: 'src/library/init.luau' });
    expect(result.candidates[0].instanceIds).toHaveLength(1);
    expect(config.instancesByFile.get('src/library/init.luau')).toHaveLength(1);
  });

  it('follows only supplied lexical aliases and literal child lookups', async () => {
    await source('src/dep.luau');
    const config = await map([
      {
        name: 'ReplicatedStorage',
        className: 'ReplicatedStorage',
        children: [moduleNode('Main', 'src/main.luau'), moduleNode('Dependency', 'src/dep.luau')],
      },
    ]);
    const bindings = new Map<string, LuauStaticExpression>([
      ['siblings', member(script, 'Parent')],
      ['storage', service('ReplicatedStorage')],
    ]);
    for (const kind of ['findFirstChild', 'waitForChild'] as const) {
      expect(
        resolveLuauModule(config, {
          fromFile: 'src/main.luau',
          bindings,
          expression: {
            kind,
            base: binding(kind === 'findFirstChild' ? 'siblings' : 'storage'),
            name: 'Dependency',
          },
        }),
      ).toMatchObject({ status: 'resolved', filePath: 'src/dep.luau' });
    }
    expect(
      resolveLuauModule(config, {
        fromFile: 'src/main.luau',
        expression: member(binding('game'), 'ReplicatedStorage'),
      }),
    ).toMatchObject({ status: 'unresolved', reason: 'unknown-binding' });
  });

  it('keeps dynamic expressions and cyclic bindings unresolved with source provenance', async () => {
    const config = await map([]);
    const range = { startLine: 4, startCol: 8, endLine: 4, endCol: 30 };
    expect(
      resolveLuauModule(config, {
        fromFile: 'src/main.luau',
        range,
        expression: { kind: 'unknown', reason: 'computed child' },
      }),
    ).toMatchObject({
      status: 'unresolved',
      reason: 'dynamic-expression',
      origin: { filePath: 'src/main.luau', range },
    });
    expect(
      resolveLuauModule(config, {
        fromFile: 'src/main.luau',
        expression: binding('a'),
        bindings: new Map([
          ['a', binding('b')],
          ['b', binding('a')],
        ]),
      }),
    ).toMatchObject({ status: 'unresolved', reason: 'cyclic-binding' });
    expect(
      resolveLuauModule(config, {
        fromFile: 'src/main.luau',
        expression: { kind: 'findFirstChild', base: game, name: 'X', recursive: true },
      }),
    ).toMatchObject({ status: 'unresolved', reason: 'recursive-child-search' });
  });

  it('preserves two placements of the same importer and target as ambiguous', async () => {
    await source('src/dep.luau');
    const config = await map(
      ['A', 'B'].map((name) => ({
        name,
        className: 'Folder',
        children: [moduleNode('Main', 'src/main.luau'), moduleNode('Dep', 'src/dep.luau')],
      })),
    );
    const result = resolveLuauModule(config, {
      fromFile: 'src/main.luau',
      expression: member(member(script, 'Parent'), 'Dep'),
    });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ filePath: 'src/dep.luau' });
    expect(result.candidates[0].instanceIds).toHaveLength(2);
  });

  it('does not choose between duplicate child names', async () => {
    await source('a.luau');
    await source('b.luau');
    const config = await map([moduleNode('Dep', 'a.luau'), moduleNode('Dep', 'b.luau')]);
    const result = resolveLuauModule(config, {
      fromFile: 'src/main.luau',
      expression: member(game, 'Dep'),
    });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((x) => x.filePath)).toEqual(['a.luau', 'b.luau']);
  });

  it('does not drop a missing branch when another placement resolves', async () => {
    await source('src/dep.luau');
    const config = await map([
      {
        name: 'A',
        className: 'Folder',
        children: [moduleNode('Main', 'src/main.luau'), moduleNode('Dep', 'src/dep.luau')],
      },
      { name: 'B', className: 'Folder', children: [moduleNode('Main', 'src/main.luau')] },
    ]);
    const result = resolveLuauModule(config, {
      fromFile: 'src/main.luau',
      expression: member(member(script, 'Parent'), 'Dep'),
    });
    expect(result).toMatchObject({
      status: 'ambiguous',
      candidates: [{ filePath: 'src/dep.luau' }],
    });
  });

  it('rejects self requires and non-module instances', async () => {
    const config = await map([
      moduleNode('Main', 'src/main.luau'),
      { name: 'Server', className: 'Script', filePaths: ['src/main.luau'] },
    ]);
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: member(game, 'Main') }),
    ).toMatchObject({ status: 'unresolved', reason: 'self-require' });
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: member(game, 'Server') }),
    ).toMatchObject({ status: 'unresolved', reason: 'not-module-script' });
  });

  it('marks map paths and directory links outside the project as external', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.luau'), 'return {}\n');
    await symlink(outside, path.join(project, 'linked'), 'junction');
    const config = await map([
      moduleNode('Absolute', path.join(outside, 'secret.luau')),
      moduleNode('Traversal', '../outside/secret.luau'),
      moduleNode('Link', 'linked/secret.luau'),
    ]);
    for (const name of ['Absolute', 'Traversal', 'Link']) {
      expect(
        resolveLuauModule(config, { fromFile: 'src/main.luau', expression: member(game, name) }),
      ).toMatchObject({ status: 'external', reason: 'outside-project' });
    }
    expect(config.instancesByFile.size).toBe(0);
  });

  it('canonicalizes an in-project link and retains its instance mapping', async () => {
    await source('src/dep.luau');
    await symlink(path.join(project, 'src'), path.join(project, 'linked'), 'junction');
    const config = await map([moduleNode('Dep', 'linked/dep.luau')]);
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: member(game, 'Dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'src/dep.luau' });
    expect(config.instancesByFile.get('src/dep.luau')).toHaveLength(1);
  });

  it.each(['dep.luau', 'dep.lua', 'dep/init.luau', 'dep/init.lua'])(
    'resolves a proven filesystem module: %s',
    async (file) => {
      await source(`src/${file}`);
      const config = await map([], { stringRequireMode: 'filesystem' });
      expect(
        resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('./dep') }),
      ).toMatchObject({ status: 'resolved', filePath: `src/${file}` });
    },
  );

  it('rejects competing extensions and file/directory collisions', async () => {
    await source('src/dep.lua');
    await source('src/dep.luau');
    await source('src/other.luau');
    await mkdir(path.join(project, 'src/other'));
    const config = await map([], { stringRequireMode: 'filesystem' });
    for (const specifier of ['./dep', './other']) {
      expect(
        resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal(specifier) })
          .status,
      ).toBe('ambiguous');
    }
  });

  it('keeps an ambiguous parent unresolved when a child file exists', async () => {
    await source('src/package.luau');
    await source('src/package/child.luau');
    const config = await map([], { stringRequireMode: 'filesystem' });
    expect(
      resolveLuauModule(config, {
        fromFile: 'src/main.luau',
        expression: literal('./package/child'),
      }),
    ).toMatchObject({ status: 'ambiguous', reason: 'ambiguous-filesystem-path' });
  });

  it('uses init module semantics and @self for child modules', async () => {
    await source('src/package/init.luau');
    await source('src/package/child.luau');
    await source('src/peer.luau');
    const config = await map([], { stringRequireMode: 'filesystem' });
    for (const [specifier, filePath] of [
      ['./peer', 'src/peer.luau'],
      ['@self/child', 'src/package/child.luau'],
    ]) {
      expect(
        resolveLuauModule(config, {
          fromFile: 'src/package/init.luau',
          expression: literal(specifier),
        }),
      ).toMatchObject({ status: 'resolved', filePath });
    }
  });

  it('resolves explicit aliases from their declaring directory and detects alias cycles', async () => {
    await source('lib/dep.luau');
    const config = await map([], {
      stringRequireMode: 'filesystem',
      requireAliases: new Map([
        ['lib', { target: '../lib', baseDirectory: 'config' }],
        ['forward', { target: '@lib', baseDirectory: '.' }],
        ['a', { target: '@b', baseDirectory: '.' }],
        ['b', { target: '@a', baseDirectory: '.' }],
        ['outside', { target: '../outside', baseDirectory: '.' }],
      ]),
    });
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('@FORWARD/dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'lib/dep.luau' });
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('@a/dep') }),
    ).toMatchObject({ status: 'unresolved', reason: 'cyclic-alias' });
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('@outside/dep') }),
    ).toMatchObject({ status: 'external', reason: 'outside-project' });
  });

  it('keeps DataModel string paths separate from physical filesystem siblings', async () => {
    await source('src/dep.luau');
    await source('elsewhere/dep.luau');
    const children = [
      {
        name: 'ReplicatedStorage',
        className: 'ReplicatedStorage',
        children: [moduleNode('Main', 'src/main.luau'), moduleNode('dep', 'elsewhere/dep.luau')],
      },
    ];
    const native = await map(children, { stringRequireMode: 'datamodel' });
    const physical = await map(children, { stringRequireMode: 'filesystem' });
    expect(
      resolveLuauModule(native, { fromFile: 'src/main.luau', expression: literal('./dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'elsewhere/dep.luau' });
    expect(
      resolveLuauModule(physical, { fromFile: 'src/main.luau', expression: literal('./dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'src/dep.luau' });
  });

  it('resolves @game without an importer instance and lets a configured alias override it', async () => {
    await source('lib/dep.luau');
    await source('custom/dep.luau');
    const children = [moduleNode('dep', 'lib/dep.luau')];
    const native = await map(children, { stringRequireMode: 'datamodel' });
    expect(
      resolveLuauModule(native, { fromFile: 'src/main.luau', expression: literal('@game/dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'lib/dep.luau' });
    const custom = await map(children, {
      stringRequireMode: 'datamodel',
      requireAliases: new Map([['game', { target: 'custom', baseDirectory: '.' }]]),
    });
    expect(
      resolveLuauModule(custom, { fromFile: 'src/main.luau', expression: literal('@game/dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'custom/dep.luau' });
  });

  it('does not infer a string mode or search unrelated basenames', async () => {
    await source('unrelated/dep.luau');
    const config = await map([]);
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('./dep') }),
    ).toMatchObject({ status: 'unresolved', reason: 'string-mode-not-configured' });
    const physical = await map([], { stringRequireMode: 'filesystem' });
    for (const specifier of ['dep', './dep', '@missing/dep']) {
      expect(
        resolveLuauModule(physical, { fromFile: 'src/main.luau', expression: literal(specifier) })
          .status,
      ).toBe('unresolved');
    }
    expect(
      resolveLuauModule(physical, {
        fromFile: 'src/main.luau',
        expression: literal('../../outside'),
      }),
    ).toMatchObject({ status: 'external', reason: 'outside-project' });
  });

  it('supports a missing default map with known files but rejects a malformed existing map', async () => {
    await source('src/dep.luau');
    const config = await loadLuauResolutionConfig(project, sourceFiles);
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('./dep') }),
    ).toMatchObject({ status: 'resolved', filePath: 'src/dep.luau' });
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: member(script, 'Parent') })
        .status,
    ).toBe('unresolved');
    await writeFile(path.join(project, 'sourcemap.json'), '[]');
    await expect(loadLuauResolutionConfig(project, sourceFiles)).rejects.toThrow(/sourcemap/i);
  });

  it('rejects an explicitly missing map and a dangling default map', async () => {
    await expect(
      loadRojoModuleMap({ projectPath: project, sourcemapPath: 'missing.json' }),
    ).rejects.toThrow(/sourcemap/i);
    const target = path.join(root, 'removed-map');
    await mkdir(target);
    await symlink(target, path.join(project, 'sourcemap.json'), 'junction');
    await rm(target, { recursive: true });
    await expect(loadLuauResolutionConfig(project, sourceFiles)).rejects.toThrow(/sourcemap/i);
  });

  it('bounds pathological expression and alias chains', async () => {
    const requireAliases = new Map(
      Array.from(
        { length: 300 },
        (_, i) => [`alias${i}`, { target: `@alias${i + 1}`, baseDirectory: '.' }] as const,
      ),
    );
    const config = await map([], { requireAliases, stringRequireMode: 'filesystem' });
    let expression: LuauStaticExpression = game;
    for (let i = 0; i < 300; i++) expression = member(expression, 'Parent');
    expect(resolveLuauModule(config, { fromFile: 'src/main.luau', expression })).toMatchObject({
      status: 'unresolved',
      reason: 'expression-limit',
    });
    expect(
      resolveLuauModule(config, { fromFile: 'src/main.luau', expression: literal('@alias0/dep') }),
    ).toMatchObject({ status: 'unresolved', reason: 'alias-limit' });
  });

  it.each(['not json', '{}', '{"name":"Game","className":"DataModel","children":[null]}'])(
    'rejects invalid sourcemap structure: %s',
    async (contents) => {
      const sourcemapPath = path.join(root, 'bad.json');
      await writeFile(sourcemapPath, contents);
      await expect(loadRojoModuleMap({ projectPath: project, sourcemapPath })).rejects.toThrow(
        /sourcemap/i,
      );
    },
  );
});
