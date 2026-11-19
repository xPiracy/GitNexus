import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { collectResolutionGroupFiles } from '../../src/core/incremental/resolution-groups.js';
import { loadParseCache, saveParseCache, type ParseCache } from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';

const SOURCE_FILES = ['src/Client.luau', 'src/First.luau', 'src/Second.lua'];

/** Same instance path, different physical module: source text alone cannot key resolution. */
function sourcemap(libraryFile: string): string {
  return JSON.stringify({
    name: 'Fixture',
    className: 'DataModel',
    children: [
      {
        name: 'ReplicatedStorage',
        className: 'ReplicatedStorage',
        children: [
          { name: 'Client', className: 'ModuleScript', filePaths: [SOURCE_FILES[0]] },
          { name: 'Library', className: 'ModuleScript', filePaths: [libraryFile] },
        ],
      },
    ],
  });
}

function callsFromRun(result: PipelineResult): string[] {
  return [...result.graph.iterRelationshipsByType('CALLS')]
    .filter((edge) => result.graph.getNode(edge.sourceId)?.properties.name === 'run')
    .map((edge) => {
      const target = result.graph.getNode(edge.targetId)!;
      return `${target.properties.filePath}:${target.properties.name}`;
    })
    .sort();
}

function graphIdentity(result: PipelineResult): { nodes: string[]; edges: string[] } {
  return {
    nodes: [...result.graph.iterNodes()].map((node) => `${node.label}:${node.id}`).sort(),
    edges: [...result.graph.iterRelationships()]
      .map((edge) =>
        JSON.stringify([edge.id, edge.sourceId, edge.targetId, edge.type, edge.reason, edge.step]),
      )
      .sort(),
  };
}

describe('Luau worker and durable parse-cache integration', () => {
  it('replays the complete graph and re-resolves a changed Rojo map without reparsing source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-luau-cache-repo-'));
    const storage = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-luau-cache-store-'));
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(
        path.join(root, SOURCE_FILES[0]),
        [
          'local Library = require(script.Parent.Library)',
          'local function run() return Library.leaf() end',
          'return run',
        ].join('\n'),
      );
      await writeFile(
        path.join(root, SOURCE_FILES[1]),
        'local function first() return 1 end\nreturn { leaf = first }\n',
      );
      await writeFile(
        path.join(root, SOURCE_FILES[2]),
        'local function second() return 2 end\nreturn { leaf = second }\n',
      );
      await writeFile(path.join(root, 'sourcemap.json'), sourcemap(SOURCE_FILES[1]!));

      const identity = await runtimeParseIdentity();
      const cache: ParseCache = {
        identity,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        writeStoragePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: cache,
      });
      expect(cold.scopeExtractionFailures).toEqual([]);
      expect(cold.usedWorkerPool).toBe(true);
      expect(cold.reparsedFileCount).toBe(3);
      expect(callsFromRun(cold)).toEqual(['src/First.luau:first']);
      expect(
        [...cold.graph.iterRelationshipsByType('IMPORTS')].some(
          (edge) =>
            cold.graph.getNode(edge.sourceId)?.properties.filePath === SOURCE_FILES[0] &&
            cold.graph.getNode(edge.targetId)?.properties.filePath === SOURCE_FILES[1],
        ),
      ).toBe(true);

      const keys = await saveParseCache(storage, cache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        identity.base,
        new Set(keys),
      );
      const warm = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: await loadParseCache(storage, identity, storage),
      });
      expect(warm.scopeExtractionFailures).toEqual([]);
      expect(warm.usedWorkerPool).toBe(false);
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(3);
      expect(graphIdentity(warm)).toEqual(graphIdentity(cold));

      await writeFile(path.join(root, 'sourcemap.json'), sourcemap(SOURCE_FILES[2]!));
      const remapped = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: await loadParseCache(storage, identity, storage),
      });
      expect(remapped.scopeExtractionFailures).toEqual([]);
      expect(remapped.usedWorkerPool).toBe(false);
      expect(callsFromRun(remapped)).toEqual(['src/Second.lua:second']);
      // Incremental persistence must consider untouched source rows when only
      // the map changes; otherwise a correct fresh graph could still leave a stale DB.
      expect(collectResolutionGroupFiles(['sourcemap.json'], SOURCE_FILES)).toEqual(
        new Set(SOURCE_FILES),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 120_000);
});
