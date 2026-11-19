import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GraphNode, RelationshipType } from 'gitnexus-shared';
import { afterEach, describe, expect, it } from 'vitest';
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

/** Exercise source capture, lexical resolution, and ordinary graph emission together. */
async function resolve(sources: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-mutation-safety-'));
  temporary.push(directory);
  const graph = createKnowledgeGraph();
  const bindings: { name: string; kind: string; status: string; line: number }[] = [];
  const files = Object.entries(sources).map(([filePath, content]) => ({ path: filePath, content }));
  for (const file of files) {
    await writeFile(path.join(directory, file.path), file.content);
    graph.addNode({
      id: `File:${file.path}`,
      label: 'File',
      properties: { name: file.path, filePath: file.path },
    });
    const tree = getLuauParser().parse(file.content)!;
    expect(tree.rootNode.hasError).toBe(false);
    const artifact = extractLuauSemanticGraph(tree, file.path, file.content);
    for (const node of artifact.nodes) graph.addNode(node);
    for (const edge of artifact.relationships) graph.addRelationship(edge);
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
            line: site.atRange.startLine,
          });
      },
    },
    luauScopeResolver,
  );
  expect(stats.filesSkipped).toBe(0);

  function node(file: string, name: string, label: GraphNode['label']) {
    const matches = graph.nodes.filter(
      (candidate) =>
        candidate.properties.filePath === file &&
        candidate.properties.name === name &&
        candidate.label === label,
    );
    expect(matches).toHaveLength(1);
    return matches[0]!;
  }
  function outgoing(source: GraphNode, type: RelationshipType) {
    return graph.relationships.filter((edge) => edge.sourceId === source.id && edge.type === type);
  }
  function callsNamed(name: string) {
    const calls = bindings.filter((binding) => binding.kind === 'call' && binding.name === name);
    // A missing capture cannot satisfy a safety check by emitting no edges.
    expect(calls).toHaveLength(1);
    return calls;
  }
  return { graph, node, outgoing, callsNamed, bindings };
}

describe('Luau call targets after mutation', () => {
  it('does not retain an exported member overwritten by its importer', async () => {
    const result = await resolve({
      'library.luau': 'local function first() end\nreturn {go = first}',
      'main.luau': [
        'local M = require("./library")',
        'local function second() end',
        'M.go = second',
        'local function run() M.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    const run = result.node('main.luau', 'run', 'Function');
    const second = result.node('main.luau', 'second', 'Function');
    expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
    // Resolving the replacement or declining is valid. The producer's old
    // initializer cannot remain the target after this unconditional write.
    expect(result.outgoing(run, 'CALLS').every((edge) => edge.targetId === second.id)).toBe(true);
  });

  it('does not retain scalar evidence after an importer stores a mutable table in that field', async () => {
    const result = await resolve({
      'library.luau': 'return {slot = 0}',
      'main.luau': [
        'local M = require("./library")',
        'local function first() end',
        'local Child = {go = first}',
        'M.slot = Child',
        'unknownConsumer(M.slot)',
        'local function run() Child.go() end',
        'return run',
      ].join('\n'),
    });
    expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
    expect(result.callsNamed('go')[0]?.status).not.toBe('resolved');
    const run = result.node('main.luau', 'run', 'Function');
    const first = result.node('main.luau', 'first', 'Function');
    // The consumer receives Child through the imported table's replacement
    // field. The producer's old numeric initializer cannot prove no escape.
    const calls = result.outgoing(run, 'CALLS');
    expect(calls.map((edge) => edge.targetId)).not.toContain(first.id);
    expect(calls).toEqual([]);
  });

  it('does not choose a known field when a computed initializer may overwrite it', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local function second() end',
        'local key = selectKey()',
        'local M = {go = first, [key] = second}',
        'local function run() M.go() end',
        'return run',
      ].join('\n'),
    });
    expect(result.callsNamed('go')[0]!.status).not.toBe('resolved');
    expect(result.outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS')).toEqual([]);
  });

  it('treats a function statement as reassignment of an existing captured local', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local callback = first',
        'local function run() callback() end',
        'function callback() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('callback');
    const run = result.node('main.luau', 'run', 'Function');
    const first = result.node('main.luau', 'first', 'Function');
    expect(result.outgoing(run, 'CALLS').some((edge) => edge.targetId === first.id)).toBe(false);
  });

  it('does not retain an inherited target after replacing the same table metatable', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local function second() end',
        'local object = {}',
        'local alias = setmetatable(object, {__index = {go = first}})',
        'setmetatable(object, {__index = {go = second}})',
        'local function run() alias.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    const run = result.node('main.luau', 'run', 'Function');
    const second = result.node('main.luau', 'second', 'Function');
    expect(result.outgoing(run, 'CALLS').every((edge) => edge.targetId === second.id)).toBe(true);
  });

  it('does not retain an inherited target after an importer replaces the metatable through an alias', async () => {
    const result = await resolve({
      'library.luau':
        'local function first() end\nreturn setmetatable({}, {__index = {go = first}})',
      'main.luau': [
        'local M = require("./library")',
        'local function second() end',
        'local alias = M',
        'setmetatable(alias, {__index = {go = second}})',
        'local function run() M.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
    const run = result.node('main.luau', 'run', 'Function');
    const first = result.node('library.luau', 'first', 'Function');
    const second = result.node('main.luau', 'second', 'Function');
    // The alias denotes the imported allocation, so this is a real competing
    // metatable write. Independent candidate budgets must not hide it.
    const calls = result.outgoing(run, 'CALLS');
    expect(calls.map((edge) => edge.targetId)).not.toContain(first.id);
    expect(calls.every((edge) => edge.targetId === second.id)).toBe(true);
  });

  it.each(['nil', 'absent'])(
    'retains an optional field back-reference installed by an importer metatable mutation (%s initializer)',
    async (initializer) => {
      const result = await resolve({
        'library.luau':
          'local function first() end\n' +
          (initializer === 'nil' ? 'return {go = first, optional = nil}' : 'return {go = first}'),
        'main.luau': [
          'local Parent = require("./library")',
          'local alias = Parent',
          'setmetatable(alias, {__index = function() return Parent end})',
          'unknownConsumer(table.freeze({value = Parent.optional}))',
          'local function run() Parent.go() end',
          'return run',
        ].join('\n'),
      });
      expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
      expect(result.callsNamed('go')[0]?.status).not.toBe('resolved');
      // The producer's table literal has no metatable, but its imported alias
      // now returns that same mutable allocation through the optional field.
      expect(result.outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS')).toEqual([]);
    },
  );

  it('does not prove a plain receiver through a foreign-overwritten metatable getter', async () => {
    const result = await resolve({
      'library.luau': 'local Child = {}\nreturn {get = function() return Child end}',
      'main.luau': [
        'local Holder = require("./library")',
        'local function first() end',
        'local Parent = {go = first, optional = nil}',
        'Holder.get = function() return Parent end',
        'setmetatable(Holder.get(), {__index = function() return Parent end})',
        'unknownConsumer(table.freeze({value = Parent.optional}))',
        'local function run() Parent.go() end',
        'return run',
      ].join('\n'),
    });
    expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
    result.callsNamed('go');
    // The replaced getter supplies Parent to setmetatable. An origin walk
    // using only the producer's old getter would incorrectly prove it plain.
    expect(result.outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS')).toEqual([]);
  });

  it('retains a direct escape through a foreign-overwritten getter', async () => {
    const result = await resolve({
      'library.luau': 'local Child = {}\nreturn {get = function() return Child end}',
      'main.luau': [
        'local Holder = require("./library")',
        'local function first() end',
        'local Parent = {go = first}',
        'Holder.get = function() return Parent end',
        'unknownConsumer(Holder.get())',
        'local function run() Parent.go() end',
        'return run',
      ].join('\n'),
    });
    expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
    result.callsNamed('go');
    // The ordinary escape walk must observe the replacement getter too;
    // fixing only metatable mutation indexing leaves this direct escape lost.
    expect(result.outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS')).toEqual([]);
  });

  it('retains replacement getter values when the write receiver is unresolved', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local Parent = {go = first}',
        'local Other = {}',
        'local Holder = {get = function() return Other end}',
        'local function choose()',
        '  if flag then return Holder end',
        '  return Holder',
        'end',
        'choose().get = function() return Parent end',
        'unknownConsumer(Holder.get())',
        'local function run() Parent.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    // Both runtime branches select Holder. An unresolved receiver cannot
    // erase the replacement getter, whose result exposes Parent to mutation.
    // An index omitting that write cannot prove the old getter is unchanged.
    expect(result.outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS')).toEqual([]);
  });

  it.each(['M', 'externalTable'])(
    'preserves metatable safety when an exhausted candidate chain reaches %s',
    async (origin) => {
      const result = await resolve({
        'library.luau':
          'local function first() end\nreturn setmetatable({}, {__index = {go = first}})',
        'main.luau': [
          'local M = require("./library")',
          'local function second() end',
          'local function unrelated() end',
          'local Other = {go = unrelated}',
          `local function a0() return ${origin} end`,
          ...Array.from(
            { length: 189 },
            (_, index) => `local function a${index + 1}() return a${index}() end`,
          ),
          'setmetatable(a189(), {__index = {go = second}})',
          'local function run() M.go() end',
          'local function runOther() Other.go() end',
          'return {run, runOther}',
        ].join('\n'),
      });
      expect(
        result.bindings.filter((binding) => binding.kind === 'call' && binding.name === 'go'),
      ).toHaveLength(2);
      expect(result.graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
      const calls = result.outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS');
      const first = result.node('library.luau', 'first', 'Function');
      const second = result.node('main.luau', 'second', 'Function');
      // The long chain exceeds the candidate's ordinary evaluation budget.
      // A known same-table origin or an opaque exhausted origin cannot prove
      // this competing metatable write unrelated to the imported receiver.
      expect(calls.map((edge) => edge.targetId)).not.toContain(first.id);
      if (origin === 'externalTable') expect(calls).toEqual([]);
      else expect(calls.every((edge) => edge.targetId === second.id)).toBe(true);
      // Refusing the metatable-dependent target must not erase an unrelated
      // plain table's fully known member target.
      expect(
        result
          .outgoing(result.node('main.luau', 'runOther', 'Function'), 'CALLS')
          .map((edge) => edge.targetId),
      ).toEqual([result.node('main.luau', 'unrelated', 'Function').id]);
    },
  );

  it('records function-statement assignment on the original variable binder', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local callback = first',
        'local function replace()',
        '  function callback() end',
        'end',
        'return replace',
      ].join('\n'),
    });
    const replace = result.node('main.luau', 'replace', 'Function');
    const callback = result.node('main.luau', 'callback', 'Variable');
    expect(callback.properties.startLine).toBe(1);
    const writes = result.outgoing(replace, 'ACCESSES').filter((edge) => /write/.test(edge.reason));
    expect(writes.length).toBeGreaterThan(0);
    expect([...new Set(writes.map((edge) => edge.targetId))]).toEqual([callback.id]);
    expect(result.outgoing(replace, 'CALLS')).toEqual([]);
  });

  it('invalidates a metatable installed directly on a newly constructed table', async () => {
    const result = await resolve({
      'main.luau': [
        'local function first() end',
        'local function second() end',
        'local object = setmetatable({}, {__index = {go = first}})',
        'setmetatable(object, {__index = {go = second}})',
        'local function run() object.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    const run = result.node('main.luau', 'run', 'Function');
    const second = result.node('main.luau', 'second', 'Function');
    expect(result.outgoing(run, 'CALLS').every((edge) => edge.targetId === second.id)).toBe(true);
  });

  it('reads declaration-form method receivers in their enclosing factory', async () => {
    const result = await resolve({
      'main.luau': [
        'local function make()',
        '  local object = {}',
        '  function object:get() end',
        '  function object.put() end',
        '  return object',
        'end',
        'return make',
      ].join('\n'),
    });
    const make = result.node('main.luau', 'make', 'Function');
    const object = result.node('main.luau', 'object', 'Variable');
    const declarationReads = result.bindings.filter(
      (binding) =>
        binding.name === 'object' && binding.kind === 'read' && [3, 4].includes(binding.line),
    );
    expect(declarationReads.map((binding) => binding.line).sort()).toEqual([3, 4]);
    expect(declarationReads.every((binding) => binding.status === 'resolved')).toBe(true);
    // Evaluating the declaration receiver occurs while make installs the
    // methods. It is not a read executed by either newly declared method.
    const accesses = result.graph.relationships.filter(
      (edge) => edge.type === 'ACCESSES' && edge.targetId === object.id && /read/.test(edge.reason),
    );
    expect(accesses.length).toBeGreaterThan(0);
    expect(accesses.every((edge) => edge.sourceId === make.id)).toBe(true);
  });

  it.each([
    {
      name: 'a known function mutating its table parameter',
      setup: ['local function replace(target) target.go = second end'],
      mutation: 'replace(M)',
      replacementKnown: true,
    },
    {
      name: 'an unknown function receiving the table',
      setup: [],
      mutation: 'externalReplace(M)',
      replacementKnown: false,
    },
    {
      name: 'rawset replacing the callable field',
      setup: [],
      mutation: 'rawset(M, "go", second)',
      replacementKnown: true,
    },
  ])(
    'does not keep a stale field target after $name',
    async ({ setup, mutation, replacementKnown }) => {
      const result = await resolve({
        'main.luau': [
          'local first = function() end',
          'local second = function() end',
          ...setup,
          'local M = {go = first}',
          mutation,
          'local function run() M.go() end',
          'return run',
        ].join('\n'),
      });
      const binding = result.callsNamed('go')[0]!;
      const run = result.node('main.luau', 'run', 'Function');
      const calls = result.outgoing(run, 'CALLS');
      if (replacementKnown) {
        const second = result.node('main.luau', 'second', 'Function');
        // A proven replacement is acceptable; merely ignoring the mutator and
        // retaining the constructor's original function is not.
        expect(calls.every((edge) => edge.targetId === second.id)).toBe(true);
      } else {
        expect(binding.status).not.toBe('resolved');
        expect(calls).toEqual([]);
      }
    },
  );

  it('does not prove a wrapper read-only through an escaped helper table', async () => {
    const result = await resolve({
      'main.luau': [
        'local first = function() end',
        'local second = function() end',
        'local Helper = {touch = function(value) end}',
        'local function replace(value) value.go = second end',
        'rawset(Helper, "touch", replace)',
        'local function wrapper(value) Helper.touch(value) end',
        'local M = {go = first}',
        'wrapper(M)',
        'local function run() M.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    const run = result.node('main.luau', 'run', 'Function');
    const second = result.node('main.luau', 'second', 'Function');
    // The helper's former empty function cannot justify skipping the effect
    // of wrapper(M): rawset replaced that function with a mutator of M.
    expect(result.outgoing(run, 'CALLS').every((edge) => edge.targetId === second.id)).toBe(true);
  });

  it('does not retain purity through an alias and nested wrappers of an escaped helper', async () => {
    const result = await resolve({
      'main.luau': [
        'local first = function() end',
        'local second = function() end',
        'local Helper = {touch = function(value) end}',
        'local function replace(value) value.go = second end',
        'rawset(Helper, "touch", replace)',
        'local copied = Helper.touch',
        'local function inner(value) copied(value) end',
        'local function outer(value) inner(value) end',
        'local M = {go = first}',
        'outer(M)',
        'local function run() M.go() end',
        'return run',
      ].join('\n'),
    });
    result.callsNamed('go');
    const run = result.node('main.luau', 'run', 'Function');
    const second = result.node('main.luau', 'second', 'Function');
    expect(result.outgoing(run, 'CALLS').every((edge) => edge.targetId === second.id)).toBe(true);
  });

  it.each([0, 200])(
    'preserves a known target while indexing %s unrelated local writes to the same field',
    async (unrelatedWrites) => {
      const result = await resolve({
        'main.luau': [
          'local function first() end',
          'local Target = {go = first}',
          'local Holder = {child = Target}',
          'local Noise = {}',
          'local alias = Noise',
          ...Array.from({ length: unrelatedWrites }, () => 'alias.child = true'),
          'Holder.child.marker = true',
          'local function run() Target.go() end',
          'return run',
        ].join('\n'),
      });
      result.callsNamed('go');
      // Only Noise has its child field changed. Comparing those receivers
      // cannot exhaust the separate proof that Holder.child denotes Target.
      expect(
        result
          .outgoing(result.node('main.luau', 'run', 'Function'), 'CALLS')
          .map((edge) => edge.targetId),
      ).toEqual([result.node('main.luau', 'first', 'Function').id]);
    },
  );

  it('does not spend a target proof budget on unrelated imported table writes', async () => {
    const result = await resolve({
      'library.luau': 'local function first() end\nreturn {go = first}',
      'other.luau': 'return {}',
      'noise.luau': [
        'local Noise = require("./other")',
        ...Array.from({ length: 200 }, (_, index) => `Noise[key${index}] = true`),
        'return Noise',
      ].join('\n'),
      'main.luau': [
        'local Library = require("./library")',
        'local function run() Library.go() end',
        'return run',
      ].join('\n'),
    });
    expect(result.callsNamed('go')[0]!.status).toBe('resolved');
    const run = result.node('main.luau', 'run', 'Function');
    const first = result.node('library.luau', 'first', 'Function');
    // All computed writes are real, but they affect another imported table.
    // Their count cannot erase an otherwise unique target in this module.
    expect(result.outgoing(run, 'CALLS').map((edge) => edge.targetId)).toEqual([first.id]);
  });
});
