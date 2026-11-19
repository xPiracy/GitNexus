import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';
import { extractLuauSemanticGraph } from '../../../../src/core/ingestion/languages/luau/semantic-graph.js';
import { luauScopeResolver } from '../../../../src/core/ingestion/languages/luau/scope-resolver.js';
import { loadLuauResolutionConfig } from '../../../../src/core/ingestion/languages/luau/module-resolution.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function resolve(sources: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-graph-'));
  temporary.push(directory);
  const graph = createKnowledgeGraph();
  const bindings: { name: string; kind: string; status: string; basis: string }[] = [];
  const files = Object.entries(sources).map(([filePath, content]) => ({ path: filePath, content }));
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file.path)), { recursive: true });
    await writeFile(path.join(directory, file.path), file.content);
    graph.addNode({
      id: `File:${file.path}`,
      label: 'File',
      properties: { name: file.path, filePath: file.path },
    });
    const tree = getLuauParser().parse(file.content)!;
    const artifact = extractLuauSemanticGraph(tree, file.path, file.content);
    for (const node of artifact.nodes) graph.addNode(node);
    for (const relationship of artifact.relationships) graph.addRelationship(relationship);
  }
  const stats = runScopeResolution(
    {
      graph,
      files,
      model: createSemanticModel(),
      resolutionConfig: await loadLuauResolutionConfig(directory, Object.keys(sources)),
      onResolved: (result) => {
        for (const [site, binding] of result.referenceBindings)
          bindings.push({
            name: site.name,
            kind: site.kind,
            status: binding.status,
            basis: binding.basis,
          });
      },
    },
    luauScopeResolver,
  );
  const calls = graph.relationships.filter((edge) => edge.type === 'CALLS');
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const pairs = calls
    .map(
      (edge) =>
        `${nodes.get(edge.sourceId)?.properties.name}->${nodes.get(edge.targetId)?.properties.name}`,
    )
    .sort();
  return { graph, stats, pairs, nodes, bindings };
}

describe('Luau through the native graph resolver', () => {
  it('resolves static imports and aliases exported through a table', async () => {
    const result = await resolve({
      'library.luau': 'local function work() end\nreturn { execute = work }',
      'main.luau':
        'local Library = require("./library")\nlocal function run() Library.execute() end\nreturn run',
    });
    expect(result.stats.filesSkipped).toBe(0);
    expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
    expect(result.pairs).toContain('run->work');
  });

  it('resolves local copies, assigned members, colon self and nested owners', async () => {
    const result = await resolve({
      'main.luau': [
        'local function leaf() end',
        'local alias = leaf',
        'local M = {}',
        'function M:step() alias() end',
        'function M:run() self:step() end',
        'local function outer()',
        '  local function inner() M:run() end',
        '  inner()',
        'end',
        'return M',
      ].join('\n'),
    });
    expect(result.pairs).toEqual(['inner->run', 'outer->inner', 'run->step', 'step->leaf']);
  });

  it('does not invoke passed values or guess injected members', async () => {
    const result = await resolve({
      'main.luau': [
        'local function leaf() end',
        'local function store(value) return value end',
        'local function run(deps) store(leaf); deps.leaf() end',
        'return run',
      ].join('\n'),
    });
    expect(result.pairs).toEqual(['run->store']);
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'leaf', kind: 'call', status: 'unresolved' }),
    );
  });

  it('retains module variable and property writes as accesses', async () => {
    const result = await resolve({
      'main.luau': [
        'local state = 0',
        'local M = { count = 0 }',
        'local function update() state = 1; M.count = state end',
        'return { update = update }',
      ].join('\n'),
    });
    const accesses = result.graph.relationships.filter((edge) => edge.type === 'ACCESSES');
    expect(accesses.map((edge) => result.nodes.get(edge.targetId)?.properties.name)).toEqual(
      expect.arrayContaining(['state', 'count']),
    );
    expect(accesses.some((edge) => /write/.test(edge.reason))).toBe(true);
  });

  it('connects named table and record members to their source owners', async () => {
    const result = await resolve({
      'main.luau':
        'export type Shape = { ["count"]: number }\nlocal M = { count = 0, run = function() end }\nfunction M:step() end\nreturn M',
    });
    const members = result.graph.relationships
      .filter((edge) => edge.type === 'HAS_PROPERTY' || edge.type === 'HAS_METHOD')
      .map(
        (edge) =>
          `${result.nodes.get(edge.sourceId)?.properties.name}:${edge.type}:${result.nodes.get(edge.targetId)?.properties.name}`,
      )
      .sort();
    expect(members).toEqual([
      'M:HAS_METHOD:run',
      'M:HAS_METHOD:step',
      'M:HAS_PROPERTY:count',
      'Shape:HAS_PROPERTY:count',
    ]);
  });

  it('does not select a captured function value after a reassignment', async () => {
    const result = await resolve({
      'main.luau':
        'local function first() end\nlocal function second() end\nlocal f = first\nlocal function run() f() end\nf = second\nreturn run',
    });
    expect(result.pairs).toEqual([]);
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'f', kind: 'call', status: 'unresolved' }),
    );
  });

  it('does not assume a computed member write preserves a callable field', async () => {
    const result = await resolve({
      'main.luau':
        'local function first() end\nlocal function second() end\nlocal M = { go = first }\nM[key] = second\nlocal function run() M.go() end\nreturn run',
    });
    expect(result.pairs).toEqual([]);
  });

  it('follows immutable copy and argument flow only when the formal is invoked', async () => {
    const result = await resolve({
      'main.luau': [
        'local function target() end',
        'local function invoke(callback) callback() end',
        'local function store(callback) return callback end',
        'local first = target',
        'local second = first',
        'invoke(second)',
        'store(second)',
      ].join('\n'),
    });
    expect(result.pairs).toContain('invoke->target');
    expect(result.pairs).not.toContain('store->target');
  });

  it('resolves exported type and runtime value with the same spelling independently', async () => {
    const result = await resolve({
      'library.luau':
        'export type Thing = { value: number }\nlocal function Thing() end\nreturn { Thing = Thing }',
      'main.luau':
        'local Library = require("./library")\nlocal function run(value: Library.Thing) Library.Thing() end',
    });
    expect(result.pairs).toEqual(['run->Thing']);
    expect(
      result.graph.relationships
        .filter((edge) => edge.type === 'USES')
        .some(
          (edge) =>
            result.nodes.get(edge.sourceId)?.properties.name === 'run' &&
            result.nodes.get(edge.targetId)?.label === 'TypeAlias',
        ),
    ).toBe(true);
  });

  it('retains a type-function body and its type application without a runtime call', async () => {
    const result = await resolve({
      'main.luau':
        'type function Convert(value) return value end\ntype Converted = Convert<string>',
    });
    expect(result.pairs).toEqual([]);
    const convert = [...result.nodes.values()].find((node) => node.properties.name === 'Convert');
    expect(convert?.properties.luauExecutionKind).toBe('type-function');
    expect(
      result.graph.relationships.some(
        (edge) => edge.type === 'USES' && edge.targetId === convert?.id,
      ),
    ).toBe(true);
  });

  it('follows a proven table __index chain without inventing a class', async () => {
    const result = await resolve({
      'main.luau': [
        'local Base = {}',
        'function Base:step() end',
        'Base.__index = Base',
        'local Derived = setmetatable({}, { __index = Base })',
        'Derived.__index = Derived',
        'local instance = setmetatable({}, Derived)',
        'local function run() instance:step() end',
      ].join('\n'),
    });
    expect(result.pairs).toContain('run->step');
    expect([...result.nodes.values()].some((node) => node.label === 'Class')).toBe(false);
  });

  it('records lexical ownership of nested functions and captured state', async () => {
    const result = await resolve({
      'main.luau':
        'local function outer()\nlocal state = 0\nlocal function inner() state += 1 end\nreturn inner\nend',
    });
    const lexical = result.graph.relationships
      .filter((edge) => edge.type === 'DEFINES' && edge.reason.includes('lexical'))
      .map(
        (edge) =>
          `${result.nodes.get(edge.sourceId)?.properties.name}->${result.nodes.get(edge.targetId)?.properties.name}`,
      );
    expect(lexical).toEqual(expect.arrayContaining(['outer->inner', 'outer->state']));
  });

  it('does not infer an injected property from an unrelated unique field name', async () => {
    const result = await resolve({
      'main.luau':
        'local known = { rareField = 1 }\nlocal function read(input) return input.rareField end\nreturn read',
    });
    const unrelated = [...result.nodes.values()].find(
      (node) => node.label === 'Property' && node.properties.name === 'rareField',
    );
    expect(
      result.graph.relationships.filter(
        (edge) => edge.type === 'ACCESSES' && edge.targetId === unrelated?.id,
      ),
    ).toEqual([]);
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'rareField', status: 'unresolved' }),
    );
  });

  it('reads a receiver binder independently of its member value', async () => {
    const result = await resolve({
      'main.luau':
        'local obj = { field = 1 }\nlocal function read(input) consume(input.field); return obj.field end',
    });
    const read = [...result.nodes.values()].find(
      (node) => node.properties.name === 'read' && node.label === 'Function',
    )!;
    const accessed = result.graph.relationships
      .filter((edge) => edge.type === 'ACCESSES' && edge.sourceId === read.id)
      .map((edge) => result.nodes.get(edge.targetId)?.properties.name);
    expect(accessed).toEqual(expect.arrayContaining(['obj', 'field', 'input']));
  });

  it('resolves declared members returned through unshadowed table.freeze', async () => {
    const result = await resolve({
      'result.luau':
        'local Result = {}\nexport type Result<T> = { value: T }\nfunction Result.success(value) return { value = value } end\nreturn table.freeze(Result)',
      'main.luau':
        'local Result = require("./result")\nlocal function run() return Result.success(1) end',
    });
    expect(result.pairs).toContain('run->success');
  });

  it('keeps named fields when positional constructor entries cannot overwrite them', async () => {
    const result = await resolve({
      'main.luau':
        'local function work() end\nlocal M = { 1, 2, go = work }\nlocal function run() M.go() end',
    });
    expect(result.pairs).toEqual(['run->work']);
  });

  it('preserves frozen module members when an unknown consumer receives the export', async () => {
    const result = await resolve({
      'library.luau': 'local M = {}\nfunction M.work() end\nreturn table.freeze(M)',
      'main.luau':
        'local M = require("./library")\nexternalConsumer(M)\nlocal function run() M.work() end',
    });
    expect(result.pairs).toContain('run->work');
  });

  it.each([
    'externalConsumer(M)',
    'local function replace(value) value.work = function() end end\nreplace(M)',
  ])('does not erase mutation before freezing: %s', async (mutation) => {
    const result = await resolve({
      'library.luau': `local M = {}\nfunction M.work() end\n${mutation}\nreturn table.freeze(M)`,
      'main.luau': 'local M = require("./library")\nlocal function run() M.work() end',
    });
    expect(result.pairs).not.toContain('run->work');
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'work', kind: 'call', status: 'unresolved' }),
    );
  });

  it('preserves frozen identity through returned aliases', async () => {
    const result = await resolve({
      'library.luau':
        'local M = {}\nfunction M.work() end\nlocal frozen = table.freeze(M)\nlocal alias = frozen\nreturn alias',
      'main.luau':
        'local M = require("./library")\nexternalConsumer(M)\nlocal function run() M.work() end',
    });
    expect(result.pairs).toContain('run->work');
  });

  it('does not freeze mutable nested tables with their outer export', async () => {
    const result = await resolve({
      'library.luau':
        'local function work() end\nlocal inner = {work = work}\nreturn table.freeze({inner = inner})',
      'main.luau':
        'local M = require("./library")\nexternalConsumer(M.inner)\nlocal function run() M.inner.work() end',
    });
    expect(result.pairs).not.toContain('run->work');
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'work', kind: 'call', status: 'unresolved' }),
    );
  });

  it('does not spend a member budget on unrelated local computed writes', async () => {
    const result = await resolve({
      'main.luau': [
        'local M = {}',
        'function M.work() end',
        'local Noise = {}',
        'local Alias = Noise',
        ...Array.from({ length: 200 }, (_, index) => `Alias[key${index}] = true`),
        'local function run() M.work() end',
      ].join('\n'),
    });
    expect(result.pairs).toEqual(['run->work']);
  });

  it('reports an opaque effect origin explicitly when a forwarding chain reaches its limit', async () => {
    const result = await resolve({
      'main.luau': [
        'local function work() end',
        'local M = {go = work}',
        'local function a0() return externalTable end',
        ...Array.from(
          { length: 189 },
          (_, index) => `local function a${index + 1}() return a${index}() end`,
        ),
        'local function replace(value) value.go = function() end end',
        'replace(a189())',
        'local function run() M.go() end',
      ].join('\n'),
    });
    expect(result.pairs).not.toContain('run->work');
    expect(result.bindings).toContainEqual(
      expect.objectContaining({
        name: 'go',
        kind: 'call',
        status: 'unresolved',
        basis: 'luau:table-effect-limit-unknown-origin',
      }),
    );
  });

  it('limits a traceable exhausted effect to its possible allocation origins', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local function safe() end',
        'local M = {go = first}',
        'local Other = {read = safe}',
        'local function a0() return M end',
        ...Array.from(
          { length: 189 },
          (_, index) => `local function a${index + 1}() return a${index}() end`,
        ),
        'local function replace(value) value.go = function() end end',
        'replace(a189())',
        'local function run() M.go(); Other.read() end',
      ].join('\n'),
    });
    expect(result.pairs).not.toContain('run->first');
    expect(result.pairs).toContain('run->safe');
    expect(result.bindings).toContainEqual(
      expect.objectContaining({
        name: 'go',
        status: 'unresolved',
        basis: 'luau:table-effect-resolution-limit',
      }),
    );
  });

  it('invalidates possible table origins of a direct write through an uncertain result', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local function second() end',
        'local M = {go = first}',
        'local N = {}',
        'local function choose(flag) if flag then return M end return N end',
        'choose(true).go = second',
        'local function run() M.go() end',
      ].join('\n'),
    });
    expect(result.pairs).not.toContain('run->first');
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'go', kind: 'call', status: 'unresolved' }),
    );
  });

  it('invalidates a metatable changed through an uncertain result', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local function second() end',
        'local M = setmetatable({}, {__index = {go = first}})',
        'local N = {}',
        'local function choose(flag) if flag then return M end return N end',
        'setmetatable(choose(true), {__index = {go = second}})',
        'local function run() M.go() end',
      ].join('\n'),
    });
    expect(result.pairs).not.toContain('run->first');
    expect(result.bindings).toContainEqual(
      expect.objectContaining({ name: 'go', kind: 'call', status: 'unresolved' }),
    );
  });
});
