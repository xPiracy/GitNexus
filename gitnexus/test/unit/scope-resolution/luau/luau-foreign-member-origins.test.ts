import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { loadLuauResolutionConfig } from '../../../../src/core/ingestion/languages/luau/module-resolution.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';
import { extractLuauSemanticGraph } from '../../../../src/core/ingestion/languages/luau/semantic-graph.js';
import { luauScopeResolver } from '../../../../src/core/ingestion/languages/luau/scope-resolver.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A producer's returned value may escape without exposing its owning module. */
async function resolveForeignProducer(replacement: string, argument: string, aliased: boolean) {
  const sources = {
    'module.luau': [
      'local M = {}',
      'function M.factory() return 1 end',
      'function M.produce() return {{value = 1}} end',
      'return M',
    ].join('\n'),
    'writer.luau': ['local M = require("./module")', replacement, 'return true'].join('\n'),
    'main.luau': [
      'local M = require("./module")',
      'require("./writer")',
      ...(aliased ? ['local producer = M.produce'] : []),
      aliased
        ? 'local function roundTrip() return producer() end'
        : 'local function roundTrip() return M.produce() end',
      'local parts = roundTrip()',
      `opaque(${argument})`,
      'local function run() return M.factory() end',
      'return run',
    ].join('\n'),
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-foreign-origins-'));
  temporary.push(directory);
  const graph = createKnowledgeGraph();
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
    for (const relationship of artifact.relationships) graph.addRelationship(relationship);
  }
  const factoryBindings: { status: string }[] = [];
  const stats = runScopeResolution(
    {
      graph,
      files,
      model: createSemanticModel(),
      resolutionConfig: await loadLuauResolutionConfig(directory, Object.keys(sources)),
      onResolved: (result) => {
        for (const [site, binding] of result.referenceBindings)
          if (site.kind === 'call' && site.name === 'factory') factoryBindings.push(binding);
      },
    },
    luauScopeResolver,
  );
  expect(stats.filesSkipped).toBe(0);
  expect(graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(3);
  // An absent capture or dependency must not make a missing edge look safe.
  expect(factoryBindings).toHaveLength(1);
  const functions = (filePath: string, name: string) =>
    graph.nodes.filter(
      (node) =>
        (node.label === 'Function' || node.label === 'Method') &&
        node.properties.filePath === filePath &&
        node.properties.name === name,
    );
  const runs = functions('main.luau', 'run');
  const factories = functions('module.luau', 'factory');
  expect(runs).toHaveLength(1);
  expect(factories).toHaveLength(1);
  const targets = graph.relationships
    .filter((edge) => edge.type === 'CALLS' && edge.sourceId === runs[0]!.id)
    .map((edge) => edge.targetId);
  return { targets, factory: factories[0]!.id, binding: factoryBindings[0]! };
}

describe('Luau origins from foreign member replacements', () => {
  it.each([
    {
      name: 'keeps an unaffected member callable when the producer is unchanged',
      replacement: '',
      argument: 'parts[1]',
      aliased: false,
      resolved: true,
    },
    {
      name: 'keeps an unaffected member callable when a replacement returns fresh tables',
      replacement: 'M.produce = function() return {{value = 2}} end',
      argument: 'parts[1]',
      aliased: false,
      resolved: true,
    },
    {
      name: 'invalidates the module when a replacement returns the module itself',
      replacement: 'M.produce = function() return M end',
      argument: 'parts',
      aliased: false,
      resolved: false,
    },
    {
      name: 'preserves an unaffected member through an alias of a fresh-returning replacement',
      replacement: 'M.produce = function() return {{value = 2}} end',
      argument: 'parts[1]',
      aliased: true,
      resolved: true,
    },
    {
      name: 'invalidates the module through an alias of a replacement returning the module',
      replacement: 'M.produce = function() return M end',
      argument: 'parts',
      aliased: true,
      resolved: false,
    },
  ])('$name', async ({ replacement, argument, aliased, resolved }) => {
    const result = await resolveForeignProducer(replacement, argument, aliased);
    // Fresh return allocations do not expose M. The back-reference control
    // must still reject the old target after the module reaches an unknown call.
    expect(result.targets).toEqual(resolved ? [result.factory] : []);
    if (!resolved) expect(result.binding.status).toBe('unresolved');
  });
});
