import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphNode, RelationshipType } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

/** Synthetic sources exercise worker capture serialization and ordinary graph emission together. */
const SOURCES = {
  'instances.luau': [
    'local function leaf() end',
    'local function make() return {} end',
    'local first = make()',
    'local second = make()',
    'first.go = leaf',
    'local function run() second.go() end',
    'return run',
  ].join('\n'),
  'factory.luau': [
    'local function make() return {go = function() end} end',
    'local instance = make()',
    'local function run() instance.go() end',
    'return run',
  ].join('\n'),
  'state.luau': [
    'local state = 0',
    'local function update()',
    '  state = 1',
    '  consume(state)',
    'end',
    'return update',
  ].join('\n'),
  'binding.luau': [
    'local function original() end',
    'local function replacement() end',
    'local callback = original',
    'local function replace() callback = replacement end',
    'return replace',
  ].join('\n'),
  'captured.luau': [
    'local function original() end',
    'local function replacement() end',
    'local callback = original',
    'local function run() callback() end',
    'callback = replacement',
    'return run',
  ].join('\n'),
  'library.luau': [
    'export type Thing = {value: number}',
    'local function Thing() end',
    'return {Thing = Thing}',
  ].join('\n'),
  'consumer.luau': [
    'local Library = require("./library")',
    'local function run(value: Library.Thing) Library.Thing() end',
    'return run',
  ].join('\n'),
};

describe('Luau value safety through the real parse worker', () => {
  let root: string;
  let result: PipelineResult;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-value-safety-'));
    await Promise.all(
      Object.entries(SOURCES).map(([file, source]) => writeFile(path.join(root, file), source)),
    );
    result = await runPipelineFromRepo(root, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
    });
    expect(result.usedWorkerPool).toBe(true);
    expect(result.reparsedFileCount).toBe(Object.keys(SOURCES).length);
    expect(result.scopeExtractionFailures).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function node(file: keyof typeof SOURCES, name: string, label: GraphNode['label']): GraphNode {
    const matches = [...result.graph.iterNodes()].filter(
      (candidate) =>
        candidate.properties.filePath === file &&
        candidate.properties.name === name &&
        candidate.label === label,
    );
    expect(matches).toHaveLength(1);
    return matches[0]!;
  }

  function outgoing(source: GraphNode, type: RelationshipType) {
    return [...result.graph.iterRelationshipsByType(type)].filter(
      (edge) => edge.sourceId === source.id,
    );
  }

  it('does not transfer a member assignment between separate factory allocations', () => {
    const run = node('instances.luau', 'run', 'Function');
    // second.go is absent: first.go = leaf cannot make it a callable.
    expect(outgoing(run, 'CALLS')).toEqual([]);
  });

  it('still resolves an immutable method returned by a factory', () => {
    const run = node('factory.luau', 'run', 'Function');
    const method = node('factory.luau', 'go', 'Method');
    expect(outgoing(run, 'CALLS').map((edge) => edge.targetId)).toEqual([method.id]);
  });

  it('keeps a state read after assignment on the original variable declaration', () => {
    const update = node('state.luau', 'update', 'Function');
    const state = node('state.luau', 'state', 'Variable');
    expect(state.properties.startLine).toBe(0);
    expect(
      outgoing(update, 'ACCESSES').some(
        (edge) => edge.targetId === state.id && /write/.test(edge.reason),
      ),
    ).toBe(true);
    // Either read vocabulary is valid, but the earlier write alone cannot
    // satisfy this check and the target must remain the original declaration.
    const reads = [
      ...outgoing(update, 'USES'),
      ...outgoing(update, 'ACCESSES').filter((edge) => /\bread\b/.test(edge.reason)),
    ];
    expect(reads.some((edge) => edge.targetId === state.id)).toBe(true);
  });

  it('writes the function-valued variable, not either function value', () => {
    const replace = node('binding.luau', 'replace', 'Function');
    const callback = node('binding.luau', 'callback', 'Variable');
    const writes = outgoing(replace, 'ACCESSES').filter((edge) => /write/.test(edge.reason));
    expect(writes.length).toBeGreaterThan(0);
    expect([...new Set(writes.map((edge) => edge.targetId))]).toEqual([callback.id]);
    expect(outgoing(replace, 'CALLS')).toEqual([]);
  });

  it('does not bind a returned closure to an overwritten function value', () => {
    const run = node('captured.luau', 'run', 'Function');
    const original = node('captured.luau', 'original', 'Function');
    // A conservative miss is allowed; the stale initializer is never correct
    // when this returned closure executes after the reassignment.
    expect(outgoing(run, 'CALLS').some((edge) => edge.targetId === original.id)).toBe(false);
  });

  it('retains both exported type and runtime value when their names match', () => {
    const run = node('consumer.luau', 'run', 'Function');
    const type = node('library.luau', 'Thing', 'TypeAlias');
    const value = node('library.luau', 'Thing', 'Function');
    expect(outgoing(run, 'USES').some((edge) => edge.targetId === type.id)).toBe(true);
    expect(outgoing(run, 'CALLS').map((edge) => edge.targetId)).toEqual([value.id]);
  });
});
