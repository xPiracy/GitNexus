import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLuauFacts } from '../../../../src/core/ingestion/languages/luau/captures.js';
import {
  loadRojoModuleMap,
  resolveLuauModule,
  type LuauStaticExpression,
} from '../../../../src/core/ingestion/languages/luau/module-resolution.js';

describe('Luau require aliases with uncertain execution order', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-require-safety-'));
    await writeFile(path.join(projectPath, 'replicated.luau'), 'return {}');
    await writeFile(path.join(projectPath, 'server.luau'), 'return {}');
    await writeFile(
      path.join(projectPath, 'sourcemap.json'),
      JSON.stringify({
        name: 'Synthetic',
        className: 'DataModel',
        children: [
          {
            name: 'ReplicatedStorage',
            className: 'ReplicatedStorage',
            children: [{ name: 'Dep', className: 'ModuleScript', filePaths: ['replicated.luau'] }],
          },
          {
            name: 'ServerStorage',
            className: 'ServerStorage',
            children: [{ name: 'Dep', className: 'ModuleScript', filePaths: ['server.luau'] }],
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  async function resolveRequire(source: string) {
    await writeFile(path.join(projectPath, 'main.luau'), source);
    const config = await loadRojoModuleMap({
      projectPath,
      sourcemapPath: 'sourcemap.json',
      sourceFiles: ['main.luau'],
    });
    const imports = getLuauFacts(source, 'main.luau').captures.filter(
      (capture) => capture['@import.statement'],
    );
    // Both possible targets exist. A miss here must reflect unproven execution
    // order, never an absent dependency or a lost import capture.
    expect(config.instancesByFile.has('replicated.luau')).toBe(true);
    expect(config.instancesByFile.has('server.luau')).toBe(true);
    expect(imports).toHaveLength(1);
    const captured = imports[0]!;
    let expression: LuauStaticExpression;
    try {
      expression = JSON.parse(captured['@import.source']!.text) as LuauStaticExpression;
    } catch {
      expression = { kind: 'unknown', reason: 'dynamic-import-capture' };
    }
    const range = captured['@import.statement']!.range;
    const result = resolveLuauModule(config, { fromFile: 'main.luau', expression, range });
    expect(result.origin).toEqual({ filePath: 'main.luau', range });
    return result;
  }

  it('resolves an immutable lexical service alias', async () => {
    const result = await resolveRequire(
      [
        'local root = game:GetService("ReplicatedStorage")',
        'local storage = root',
        'return require(storage.Dep)',
      ].join('\n'),
    );
    expect(result).toMatchObject({ status: 'resolved', filePath: 'replicated.luau' });
  });

  it.each([
    {
      name: 'assignment inside an uncalled closure',
      source: [
        'local root = game:GetService("ReplicatedStorage")',
        'local function change() root = game:GetService("ServerStorage") end',
        'return require(root.Dep)',
      ],
    },
    {
      name: 'assignment in a conditional branch',
      source: [
        'local root = game:GetService("ReplicatedStorage")',
        'if flag then root = game:GetService("ServerStorage") end',
        'return require(root.Dep)',
      ],
    },
    {
      name: 'captured alias reassigned before the returned closure runs',
      source: [
        'local root = game:GetService("ReplicatedStorage")',
        'local function load() return require(root.Dep) end',
        'root = game:GetService("ServerStorage")',
        'return load',
      ],
    },
  ])('does not invent a definite target for $name', async ({ source }) => {
    const result = await resolveRequire(source.join('\n'));
    expect(['unresolved', 'ambiguous']).toContain(result.status);
    expect(result).not.toHaveProperty('filePath');
  });
});
