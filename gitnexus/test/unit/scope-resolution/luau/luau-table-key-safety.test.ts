import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { luauProvider } from '../../../../src/core/ingestion/languages/luau.js';
import {
  collectLuauCaptureSideChannel,
  getLuauFacts,
} from '../../../../src/core/ingestion/languages/luau/captures.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';
import { extractLuauSemanticGraph } from '../../../../src/core/ingestion/languages/luau/semantic-graph.js';
import { luauScopeResolver } from '../../../../src/core/ingestion/languages/luau/scope-resolver.js';
import type { LuauTableFact } from '../../../../src/core/ingestion/languages/luau/facts.js';

const source = [
  'local function leaf() end',
  'local function other() end',
  'local M = {["__proto__"] = leaf, constructor = other}',
  'local function run() M["__proto__"](); M.constructor() end',
  'return {run = run}',
].join('\n');

/** JSON is the parse-cache boundary; these Luau keys must remain ordinary data. */
function replayParsedFile(content: string): ParsedFile {
  const warnings: string[] = [];
  const parsed = extractParsedFile(luauProvider, content, 'keys.luau', (message) =>
    warnings.push(message),
  );
  expect(warnings).toEqual([]);
  if (!parsed) throw new Error('Luau source did not produce a parsed file');
  const captureSideChannel = collectLuauCaptureSideChannel('keys.luau');
  expect(captureSideChannel).toBeDefined();
  // Scope maps use the pipeline's structured-clone representation. Only the
  // provider's documented JSON-safe facts cross the JSON boundary here.
  return { ...parsed, captureSideChannel: JSON.parse(JSON.stringify(captureSideChannel)) };
}

function resolve(content: string, replay: boolean) {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'File:keys.luau',
    label: 'File',
    properties: { name: 'keys.luau', filePath: 'keys.luau' },
  });
  const tree = getLuauParser().parse(content);
  if (!tree) throw new Error('Luau source did not produce a syntax tree');
  expect(tree.rootNode.hasError).toBe(false);
  const artifact = extractLuauSemanticGraph(tree, 'keys.luau', content);
  for (const node of artifact.nodes) graph.addNode(node);
  for (const edge of artifact.relationships) graph.addRelationship(edge);
  const bindings: { name: string; status: string }[] = [];
  const stats = runScopeResolution(
    {
      graph,
      model: createSemanticModel(),
      files: [{ path: 'keys.luau', content }],
      preExtractedParsedFiles: replay
        ? new Map([['keys.luau', replayParsedFile(content)]])
        : undefined,
      onResolved: (result) => {
        for (const [site, binding] of result.referenceBindings) {
          if (site.kind === 'call') bindings.push({ name: site.name, status: binding.status });
        }
      },
    },
    luauScopeResolver,
  );
  expect(stats.filesSkipped).toBe(0);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const calls = graph.relationships
    .filter((edge) => edge.type === 'CALLS')
    .map(
      (edge) =>
        `${nodes.get(edge.sourceId)?.properties.name}->${nodes.get(edge.targetId)?.properties.name}`,
    )
    .sort();
  return { calls, bindings };
}

describe('Luau table keys across capture and JSON replay', () => {
  it('preserves prototype-like keys as own fields and source positions', () => {
    const table = getLuauFacts(source, 'keys.luau').sideChannel.tables[0];
    if (!table) throw new Error('The literal table was not captured');
    const replayed = JSON.parse(JSON.stringify(table)) as LuauTableFact;
    for (const candidate of [table, replayed]) {
      expect(Object.keys(candidate.fields).sort()).toEqual(['__proto__', 'constructor']);
      expect(Object.keys(candidate.fieldPositions).sort()).toEqual(['__proto__', 'constructor']);
      expect(candidate.fields['__proto__']).toMatchObject({ kind: 'name', name: 'leaf' });
      expect(candidate.fields.constructor).toMatchObject({ kind: 'name', name: 'other' });
      expect(candidate.incomplete).toBe(false);
    }
  });

  it.each([false, true])('keeps both callable targets with JSON replay=%s', (replay) => {
    const result = resolve(source, replay);
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings.every((binding) => binding.status === 'resolved')).toBe(true);
    expect(result.calls).toEqual(['run->leaf', 'run->other']);
  });

  it.each([false, true])(
    'does not invent inherited JavaScript fields with JSON replay=%s',
    (replay) => {
      const result = resolve(
        'local M = {}\nlocal function run() M.constructor(); M.toString(); M["__proto__"]() end\nreturn run',
        replay,
      );
      // Every call must be captured, but a JavaScript object's inherited keys
      // provide no evidence that the Luau table owns any callable value.
      expect(result.bindings).toHaveLength(3);
      expect(result.bindings.every((binding) => binding.status !== 'resolved')).toBe(true);
      expect(result.calls).toEqual([]);
    },
  );
});
