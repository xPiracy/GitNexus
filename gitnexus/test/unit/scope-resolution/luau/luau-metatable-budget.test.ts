import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';
import { extractLuauSemanticGraph } from '../../../../src/core/ingestion/languages/luau/semantic-graph.js';
import { luauScopeResolver } from '../../../../src/core/ingestion/languages/luau/scope-resolver.js';
import { loadLuauResolutionConfig } from '../../../../src/core/ingestion/languages/luau/module-resolution.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { luauProvider } from '../../../../src/core/ingestion/languages/luau.js';
import { collectLuauCaptureSideChannel } from '../../../../src/core/ingestion/languages/luau/captures.js';
import {
  luauSideChannel,
  type LuauValue,
} from '../../../../src/core/ingestion/languages/luau/facts.js';
import { LuauValueResolver } from '../../../../src/core/ingestion/languages/luau/value-resolution.js';

/** Exercise the actual evaluator in the context supplied by a raw write comparison. */
interface MetatableBudgetProbe {
  evaluate(
    file: string,
    value: LuauValue,
    active: Set<LuauValue>,
    context: unknown,
  ): { kind: string; reason?: string };
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Luau metatable receiver comparison budgets', () => {
  it.each(['Other', 'M', 'externalTable'])(
    'keeps an exhausted candidate reaching %s separate from its caller budget',
    (origin) => {
      const source = [
        'local function first() end',
        'local M = setmetatable({}, {__index = {go = first}})',
        'local Other = {}',
        `local function a0() return ${origin} end`,
        ...Array.from(
          { length: 189 },
          (_, index) => `local function a${index + 1}() return a${index}() end`,
        ),
        'setmetatable(a189(), {})',
        'return M',
      ].join('\n');
      const warnings: string[] = [];
      const parsed = extractParsedFile(luauProvider, source, 'main.luau', (message) =>
        warnings.push(message),
      );
      expect(warnings).toEqual([]);
      if (!parsed) throw new Error('Synthetic Luau fixture did not produce scopes');
      const captureSideChannel = collectLuauCaptureSideChannel('main.luau');
      if (!captureSideChannel) throw new Error('Missing Luau source facts');
      const root = luauSideChannel(captureSideChannel)?.bindings.find(
        (binding) => binding.name === 'M',
      )?.value;
      if (root?.kind !== 'call') throw new Error('Missing metatable constructor');
      const resolver = new LuauValueResolver([
        { ...parsed, captureSideChannel },
      ]) as unknown as MetatableBudgetProbe;
      const budget = {
        left: 512,
        ignoreTableEscapes: true,
        ignoreForeignWrites: true,
        memberWriteComparison: true,
        memberWriteWork: { left: 512 * 4 },
      };
      const result = resolver.evaluate(parsed.filePath, root, new Set(), budget);
      // The candidate exceeds its path limit, while the shared work allowance
      // remains available. Its source origins determine whether M is affected.
      expect(budget.memberWriteWork.left).toBeGreaterThan(0);
      if (origin === 'Other') {
        expect(result.kind).toBe('table');
        expect(budget.left).toBeGreaterThanOrEqual(0);
      } else {
        expect(result).toMatchObject({
          kind: 'unknown',
          reason:
            origin === 'M' ? 'uncertain-metatable-write' : 'metatable-receiver-resolution-limit',
        });
      }
    },
  );

  it.each([
    { unrelatedCalls: 0, phase: 'direct' },
    { unrelatedCalls: 200, phase: 'direct' },
    { unrelatedCalls: 0, phase: 'nested raw write comparison' },
    { unrelatedCalls: 200, phase: 'nested raw write comparison' },
  ])(
    'preserves a proven member with $unrelatedCalls unrelated foreign metatable calls during $phase',
    async ({ unrelatedCalls, phase }) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-metatable-budget-'));
      temporary.push(directory);
      const sources = {
        'library.luau':
          phase === 'direct'
            ? 'local function first() end\nreturn setmetatable({}, {__index = {go = first}})'
            : [
                'local function first() end',
                'local M = setmetatable({}, {__index = {go = first}})',
                'local Holder = {child = M}',
                'M.child = {}',
                'Holder.child.marker = true',
                'return M',
              ].join('\n'),
        'main.luau': 'local M = require("./library")\nlocal function run() M.go() end\nreturn run',
        'noise.luau': [
          'local function make() return {} end',
          ...Array.from(
            { length: unrelatedCalls },
            () => 'do local object = make(); local alias = object; setmetatable(alias, {}) end',
          ),
        ].join('\n'),
      };
      const graph = createKnowledgeGraph();
      const files = Object.entries(sources).map(([filePath, content]) => ({
        path: filePath,
        content,
      }));
      for (const file of files) {
        await writeFile(path.join(directory, file.path), file.content);
        graph.addNode({
          id: `File:${file.path}`,
          label: 'File',
          properties: { name: file.path, filePath: file.path },
        });
        const tree = getLuauParser().parse(file.content);
        if (!tree) throw new Error('Synthetic Luau fixture did not parse');
        expect(tree.rootNode.hasError).toBe(false);
        const artifact = extractLuauSemanticGraph(tree, file.path, file.content);
        for (const node of artifact.nodes) graph.addNode(node);
        for (const edge of artifact.relationships) graph.addRelationship(edge);
      }
      const goCalls: { status: string }[] = [];
      const stats = runScopeResolution(
        {
          graph,
          files,
          model: createSemanticModel(),
          resolutionConfig: await loadLuauResolutionConfig(directory, Object.keys(sources)),
          onResolved: (result) => {
            for (const [site, binding] of result.referenceBindings)
              if (site.kind === 'call' && site.name === 'go') goCalls.push(binding);
          },
        },
        luauScopeResolver,
      );
      expect(stats.filesSkipped).toBe(0);
      expect(goCalls).toHaveLength(1);
      expect(graph.relationships.filter((edge) => edge.type === 'IMPORTS')).toHaveLength(1);
      const functionId = (filePath: string, name: string): string => {
        const matches = graph.nodes.filter(
          (node) =>
            node.label === 'Function' &&
            node.properties.filePath === filePath &&
            node.properties.name === name,
        );
        expect(matches).toHaveLength(1);
        const match = matches[0];
        if (!match) throw new Error(`Missing captured function: ${filePath}:${name}`);
        return match.id;
      };
      const run = functionId('main.luau', 'run');
      const first = functionId('library.luau', 'first');
      // Every noise receiver is a separate allocation in another module. Its
      // comparison cannot consume the proof budget for this unchanged target.
      // The nested case compares M.child's receiver while indexing
      // Holder.child.marker, so foreign metatable candidates occur inside a
      // raw local-write comparison rather than only a direct target lookup.
      expect(
        graph.relationships
          .filter((edge) => edge.type === 'CALLS' && edge.sourceId === run)
          .map((edge) => edge.targetId),
      ).toEqual([first]);
      expect(goCalls[0]?.status).toBe('resolved');
    },
  );
});
