import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';
import { extractLuauSemanticGraph } from '../../../../src/core/ingestion/languages/luau/semantic-graph.js';
import { luauScopeResolver } from '../../../../src/core/ingestion/languages/luau/scope-resolver.js';

/** Check actual captures and emitted edges, including absence-of-edge controls. */
function resolve(source: readonly string[], expectedGoCalls = 1) {
  const filePath = 'main.luau';
  const content = source.join('\n');
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: `File:${filePath}`,
    label: 'File',
    properties: { name: filePath, filePath },
  });
  const tree = getLuauParser().parse(content);
  if (!tree) throw new Error('Synthetic Luau fixture did not parse');
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
  // A lost capture must not make an empty target set satisfy a safety case.
  expect(goCalls).toHaveLength(expectedGoCalls);

  function functionId(name: string): string {
    const matches = graph.nodes.filter(
      (node) => node.label === 'Function' && node.properties.name === name,
    );
    expect(matches).toHaveLength(1);
    const match = matches[0];
    if (!match) throw new Error(`Missing captured function: ${name}`);
    return match.id;
  }

  function targets(name: string): string[] {
    const sourceId = functionId(name);
    return graph.relationships
      .filter((edge) => edge.type === 'CALLS' && edge.sourceId === sourceId)
      .map((edge) => edge.targetId);
  }

  return { functionId, targets, goCalls };
}

describe('Luau table effects preserve scalar and frozen results', () => {
  it.each(['type(M)', 'typeof(M)', 'rawlen(M)', 'rawequal(M, M)', 'table.isfrozen(M)'])(
    'does not expose M through the scalar result of %s',
    (expression) => {
      const result = resolve([
        'local function first() end',
        'local M = {go = first}',
        `unknownConsumer(${expression})`,
        'local function run() M.go() end',
        'return run',
      ]);
      // The consumer receives a string, number, or boolean. It never receives
      // M merely because the builtin inspected M while producing that scalar.
      expect(result.targets('run')).toEqual([result.functionId('first')]);
      expect(result.goCalls[0]?.status).toBe('resolved');
    },
  );

  it('does not expose a container when only its known scalar field is consumed', () => {
    const result = resolve([
      'local function first() end',
      'local M = {go = first, scalar = 42}',
      'unknownConsumer(M.scalar)',
      'local function run() M.go() end',
      'return run',
    ]);
    expect(result.targets('run')).toEqual([result.functionId('first')]);
    expect(result.goCalls[0]?.status).toBe('resolved');
  });

  it('does not expose a container through a scalar field added after construction', () => {
    const result = resolve([
      'local function first() end',
      'local M = {go = first}',
      'M.limit = 10',
      'unknownConsumer(M.limit)',
      'local function run() M.go() end',
      'return run',
    ]);
    // The field's value is established by a named assignment. Absence from
    // the table literal does not make its scalar value expose that table.
    expect(result.targets('run')).toEqual([result.functionId('first')]);
    expect(result.goCalls[0]?.status).toBe('resolved');
  });

  it('retains __index escape for an absent field written only conditionally', () => {
    const result = resolve([
      'local function first() end',
      'local M = {go = first}',
      'setmetatable(M, {__index = function() return M end})',
      'if flag then M.limit = 10 end',
      'unknownConsumer(M.limit)',
      'local function run() M.go() end',
      'return run',
    ]);
    // The numeric candidate does not cover the branch without an assignment.
    // In that branch, __index exposes the mutable receiver itself.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it('retains a mutable back-reference in a field added after construction', () => {
    const result = resolve([
      'local function first() end',
      'local M = {go = first}',
      'M.child = table.freeze({back = M})',
      'unknownConsumer(M.child)',
      'local function run() M.go() end',
      'return run',
    ]);
    // New fields can contain tables too. Freezing this child leaves its
    // back-reference to the mutable parent reachable by the consumer.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it('does not keep scalar evidence after a field is overwritten with a mutable table', () => {
    const result = resolve([
      'local function first() end',
      'local function second() end',
      'local Child = {go = first}',
      'local M = {scalar = 42}',
      'M.scalar = Child',
      'local function mutate(value) value.go = second end',
      'mutate(M.scalar)',
      'local function run() Child.go() end',
      'return run',
    ]);
    // The old numeric initializer cannot suppress the effect on the table
    // now stored in that field. A proven replacement or refusal is valid.
    expect(result.targets('run').every((target) => target === result.functionId('second'))).toBe(
      true,
    );
  });

  it('does not expose a frozen module by inspecting the type of its function member', () => {
    const result = resolve([
      'local function first() end',
      'local M = table.freeze({go = first})',
      'unknownConsumer(type(M.go))',
      'local function run() M.go() end',
      'return run',
    ]);
    // A check of an exported function produces a scalar, not the containing
    // module. The member lookup cannot turn this into a module-table escape.
    expect(result.targets('run')).toEqual([result.functionId('first')]);
    expect(result.goCalls[0]?.status).toBe('resolved');
  });

  it('preserves each frozen root through an uncertain function result', () => {
    const result = resolve(
      [
        'local function first() end',
        'local function second() end',
        'local M = {go = first}',
        'local Other = {go = second}',
        'local function choose(flag)',
        '  if flag then return table.freeze(M) end',
        '  return table.freeze(Other)',
        'end',
        'unknownConsumer(choose(flag))',
        'local function runFirst() M.go() end',
        'local function runSecond() Other.go() end',
        'return {runFirst, runSecond}',
      ],
      2,
    );
    // Either branch exposes only a frozen root. Uncertainty about which one
    // is returned does not make either root's callable field mutable.
    expect(result.targets('runFirst')).toEqual([result.functionId('first')]);
    expect(result.targets('runSecond')).toEqual([result.functionId('second')]);
    expect(result.goCalls.every((binding) => binding.status === 'resolved')).toBe(true);
  });

  it('does not expose a parent through a conditionally reassigned frozen child', () => {
    const result = resolve([
      'local function first() end',
      'local Parent = {go = first, child = table.freeze({})}',
      'if flag then Parent.child = table.freeze({}) end',
      'unknownConsumer(Parent.child)',
      'local function run() Parent.go() end',
      'return run',
    ]);
    // Either child value is frozen and has no path back to Parent. The
    // consumer receives that child, not the mutable table storing the field.
    expect(result.targets('run')).toEqual([result.functionId('first')]);
    expect(result.goCalls[0]?.status).toBe('resolved');
  });

  it('does not expose a parent through an optional value copied into a frozen snapshot', () => {
    const result = resolve([
      'local function first() end',
      'local Parent = {go = first, optional = nil}',
      'if flag then Parent.optional = externalRead() end',
      'local snapshot = table.freeze({value = Parent.optional})',
      'unknownConsumer(snapshot)',
      'local function run() Parent.go() end',
      'return run',
    ]);
    // The unknown result was never given Parent, and this plain allocation
    // has no metatable. Reading its optional field cannot expose its owner.
    expect(result.targets('run')).toEqual([result.functionId('first')]);
    expect(result.goCalls[0]?.status).toBe('resolved');
  });

  it('does not expose a parent through a mutable local copied into its snapshot field', () => {
    const result = resolve([
      'local function first() end',
      'local Parent = {go = first, field = "x"}',
      'local value = "x"',
      'if flag then value = externalRead() end',
      'Parent.field = value',
      'unknownConsumer(table.freeze({value = Parent.field}))',
      'local function run() Parent.go() end',
      'return run',
    ]);
    // The local's possible values must be traced, but uncertainty about that
    // local does not make the containing Parent allocation one of its values.
    expect(result.targets('run')).toEqual([result.functionId('first')]);
    expect(result.goCalls[0]?.status).toBe('resolved');
  });

  it('retains an optional field escape supplied by an inherited index table', () => {
    const result = resolve([
      'local function first() end',
      'local Child = {go = first}',
      'local Parent = setmetatable({optional = nil}, {__index = {optional = Child}})',
      'unknownConsumer(table.freeze({value = Parent.optional}))',
      'local function run() Child.go() end',
      'return run',
    ]);
    // Nil activates __index; the consumer receives the inherited mutable
    // child even though the snapshot containing that child is frozen.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it('retains an optional field back-reference installed through a metatable alias', () => {
    const result = resolve([
      'local function first() end',
      'local Parent = {go = first, optional = nil}',
      'local alias = Parent',
      'setmetatable(alias, {__index = function() return Parent end})',
      'unknownConsumer(table.freeze({value = Parent.optional}))',
      'local function run() Parent.go() end',
      'return run',
    ]);
    // Evaluating the original table literal alone omits this later mutation.
    // Its __index callback returns Parent, making the snapshot expose Parent.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it('still exposes a mutable child assigned conditionally to a member', () => {
    const result = resolve([
      'local function first() end',
      'local Child = {go = first}',
      'local Parent = {child = table.freeze({})}',
      'if flag then Parent.child = Child end',
      'unknownConsumer(Parent.child)',
      'local function run() Child.go() end',
      'return run',
    ]);
    // One possible field value is mutable. The frozen initializer cannot
    // exempt that later child allocation from the consumer's possible writes.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it('still exposes a parent through a frozen child with a conditional back-reference', () => {
    const result = resolve([
      'local function first() end',
      'local Parent = {go = first, child = table.freeze({})}',
      'if flag then Parent.child = table.freeze({back = Parent}) end',
      'unknownConsumer(Parent.child)',
      'local function run() Parent.go() end',
      'return run',
    ]);
    // Freezing the child is shallow. Its back-reference still exposes the
    // mutable parent, so retaining the parent's original target is unsafe.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it('still exposes a mutable child through an uncertain shallow-frozen result', () => {
    const result = resolve([
      'local function first() end',
      'local Child = {go = first}',
      'local M = {child = Child}',
      'local Other = {}',
      'local function choose(flag)',
      '  if flag then return table.freeze(M) end',
      '  return table.freeze(Other)',
      'end',
      'unknownConsumer(choose(flag))',
      'local function run() Child.go() end',
      'return run',
    ]);
    // Freezing the outer table leaves its child mutable and reachable by the
    // consumer. The child's original function value is therefore unproven.
    expect(result.targets('run')).toEqual([]);
    expect(result.goCalls[0]?.status).not.toBe('resolved');
  });

  it.each([
    {
      declaration: 'local function type(value) return value end',
      expression: 'type(M)',
    },
    {
      declaration: 'local table = {isfrozen = function(value) return value end}',
      expression: 'table.isfrozen(M)',
    },
  ])(
    'does not apply builtin scalar rules to shadowed $expression',
    ({ declaration, expression }) => {
      const result = resolve([
        'local function first() end',
        declaration,
        'local M = {go = first}',
        `unknownConsumer(${expression})`,
        'local function run() M.go() end',
        'return run',
      ]);
      // These local functions return the table itself. Their spelling cannot
      // supply the scalar-return guarantee of an unshadowed builtin.
      expect(result.targets('run')).toEqual([]);
      expect(result.goCalls[0]?.status).not.toBe('resolved');
    },
  );
});
