import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';
import { extractLuauSemanticGraph } from '../../../../src/core/ingestion/languages/luau/semantic-graph.js';
import { luauScopeResolver } from '../../../../src/core/ingestion/languages/luau/scope-resolver.js';

/** Keep a private alias after another path exposes the same mutable table. */
function resolveEscape(middle: readonly string[]) {
  const filePath = 'main.luau';
  const content = [
    'local function first() end',
    'local function second() end',
    'local Child = {go = first}',
    ...middle,
    'local function run() Child.go() end',
    'return run',
  ].join('\n');
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: `File:${filePath}`,
    label: 'File',
    properties: { name: filePath, filePath },
  });
  const tree = getLuauParser().parse(content)!;
  expect(tree.rootNode.hasError).toBe(false);
  const artifact = extractLuauSemanticGraph(tree, filePath, content);
  for (const node of artifact.nodes) graph.addNode(node);
  for (const edge of artifact.relationships) graph.addRelationship(edge);
  const goCalls: { status: string }[] = [];
  const stats = runScopeResolution(
    {
      graph,
      files: [{ path: filePath, content }],
      model: createSemanticModel(),
      onResolved: (result) => {
        for (const [site, binding] of result.referenceBindings)
          if (site.kind === 'call' && site.name === 'go') goCalls.push(binding);
      },
    },
    luauScopeResolver,
  );
  expect(stats.filesSkipped).toBe(0);
  // Missing a call capture must not make an empty edge set look safe.
  expect(goCalls).toHaveLength(1);
  const functions = (name: string) =>
    graph.nodes.filter((node) => node.label === 'Function' && node.properties.name === name);
  const runs = functions('run');
  const replacements = functions('second');
  expect(runs).toHaveLength(1);
  expect(replacements).toHaveLength(1);
  const targets = graph.relationships
    .filter((edge) => edge.type === 'CALLS' && edge.sourceId === runs[0]!.id)
    .map((edge) => edge.targetId);
  return { graph, targets, replacement: replacements[0]!.id, binding: goCalls[0]! };
}

describe('Luau table escape through retained aliases', () => {
  it.each([
    {
      name: 'a named child of a mutable container',
      middle: [
        'local Container = {child = Child}',
        'local function mutate(c) c.child.go = second end',
        'mutate(Container)',
      ],
    },
    {
      name: 'a mutable child of a shallow-frozen container',
      middle: [
        'local Container = table.freeze({child = Child})',
        'local function mutate(c) c.child.go = second end',
        'mutate(Container)',
      ],
    },
    {
      name: 'a child stored in the container after construction',
      middle: [
        'local Container = {}',
        'Container.child = Child',
        'local function mutate(c) c.child.go = second end',
        'mutate(Container)',
      ],
    },
    {
      name: 'a child stored in an unknown global table',
      middle: [
        'externalRegistry.child = Child',
        'local function mutate(c) c.child.go = second end',
        'mutate(externalRegistry)',
      ],
    },
    {
      name: 'a positional child of a mutable container',
      middle: [
        'local Container = {Child}',
        'local function mutate(c) c[1].go = second end',
        'mutate(Container)',
      ],
    },
    {
      name: 'a retained child reached through a cyclic container',
      middle: [
        'local Container = {child = Child}',
        'Container.self = Container',
        'local function mutate(c) c.self.child.go = second end',
        'mutate(Container)',
      ],
    },
  ])('does not retain the old target through $name', ({ middle }) => {
    const result = resolveEscape(middle);
    // A proven replacement or an unresolved call is valid; the original
    // constructor value is stale after a mutator reaches the retained table.
    expect(result.targets.every((target) => target === result.replacement)).toBe(true);
  });

  it('declines after storing the child in an unknown table passed to an unknown mutator', () => {
    const result = resolveEscape([
      'externalRegistry.child = Child',
      'externalMutator(externalRegistry)',
    ]);
    expect(result.binding.status).not.toBe('resolved');
    expect(result.targets).toEqual([]);
  });

  it('still declines after an unknown mutator receives a direct global alias', () => {
    const result = resolveEscape(['sharedChild = Child', 'externalMutator(sharedChild)']);
    expect(result.binding.status).not.toBe('resolved');
    expect(result.targets).toEqual([]);
  });

  it('still rejects the old target after a known mutator receives the child directly', () => {
    const result = resolveEscape(['local function mutate(c) c.go = second end', 'mutate(Child)']);
    expect(result.targets.every((target) => target === result.replacement)).toBe(true);
  });

  it.each([
    'local function choose(flag) if flag then return Child end return Other end',
    'local function choose(flag) return (if flag then Child else Other) end',
    'local function choose(flag) return flag and Child or Other end',
  ])('tracks a possible escape through an uncertain return: %s', (choose) => {
    const result = resolveEscape([
      'local Other = {}',
      choose,
      'local function mutate(c) c.go = second end',
      'mutate(choose(true))',
    ]);
    // Uncertainty about which table is returned cannot erase a possible
    // mutation of Child or restore its stale initializer as a call target.
    expect(result.targets.every((target) => target === result.replacement)).toBe(true);
  });

  it('tracks a child returned through a computed table index', () => {
    const result = resolveEscape([
      'local Container = {child = Child}',
      'local function choose(key) return Container[key] end',
      'local function mutate(c) c.go = second end',
      'mutate(choose("child"))',
    ]);
    expect(result.targets.every((target) => target === result.replacement)).toBe(true);
  });

  it.each([170, 190])(
    'does not treat an effect-analysis limit as proof of no escape through %s forwarders',
    (count) => {
      const result = resolveEscape([
        'local function mutate(c) c.go = second end',
        'local function a0() return Child end',
        ...Array.from(
          { length: count - 1 },
          (_, index) => `local function a${index + 1}() return a${index}() end`,
        ),
        'local function unrelated() end',
        'local Other = {perform = unrelated}',
        'local function runOther() Other.perform() end',
        `mutate(a${count - 1}())`,
      ]);
      // Both chains return exactly Child. The longer chain exceeds the normal
      // evaluation budget while keeping the source below Luau's local limit.
      // Omitting that effect cannot make Child's old function callable again.
      expect(result.targets.every((target) => target === result.replacement)).toBe(true);
      const runOther = result.graph.nodes.find((node) => node.properties.name === 'runOther');
      const unrelated = result.graph.nodes.find((node) => node.properties.name === 'unrelated');
      if (!runOther || !unrelated) throw new Error('The unrelated control was not captured');
      // A traced effect on Child must not discard an unrelated proven table.
      expect(
        result.graph.relationships
          .filter((edge) => edge.type === 'CALLS' && edge.sourceId === runOther.id)
          .map((edge) => edge.targetId),
      ).toEqual([unrelated.id]);
    },
  );
});
