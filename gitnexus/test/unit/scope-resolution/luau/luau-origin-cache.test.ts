import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { luauProvider } from '../../../../src/core/ingestion/languages/luau.js';
import { collectLuauCaptureSideChannel } from '../../../../src/core/ingestion/languages/luau/captures.js';
import {
  luauSideChannel,
  type LuauValue,
} from '../../../../src/core/ingestion/languages/luau/facts.js';
import { LuauValueResolver } from '../../../../src/core/ingestion/languages/luau/value-resolution.js';

function parse(source: string): ParsedFile {
  const warnings: string[] = [];
  const parsed = extractParsedFile(luauProvider, source, 'fixture.luau', (message) =>
    warnings.push(message),
  );
  expect(warnings).toEqual([]);
  if (!parsed) throw new Error('Synthetic Luau fixture did not produce scopes');
  const captureSideChannel = collectLuauCaptureSideChannel('fixture.luau');
  if (!captureSideChannel) throw new Error('Missing Luau source facts');
  return { ...parsed, captureSideChannel };
}

/** Observe real traversal work without replacing any resolution result. */
interface OriginProbe {
  potentialTableOrigins(path: string, value: LuauValue, exhausted?: boolean): readonly string[];
  traceTableOrigins(path: string, value: LuauValue): unknown;
  evaluate(path: string, value: LuauValue, ...context: unknown[]): unknown;
  collectForeignWriteTargets(): unknown;
}

function countOriginWalks(probe: OriginProbe): () => number {
  const original = probe.traceTableOrigins;
  let walks = 0;
  probe.traceTableOrigins = function (...args) {
    walks++;
    return original.apply(this, args);
  };
  return () => walks;
}

function consumedValues(parsed: ParsedFile): LuauValue[] {
  return (
    luauSideChannel(parsed.captureSideChannel)?.references.flatMap((reference) => {
      const call = reference.value;
      return reference.kind.startsWith('call.') &&
        call.kind === 'call' &&
        call.callee.kind === 'name' &&
        call.callee.name === 'consume'
        ? call.args
        : [];
    }) ?? []
  );
}

describe('Luau completed table-origin traversal reuse', () => {
  it.each(['name', 'member'])(
    'reuses one completed walk for separate equivalent %s occurrences',
    (kind) => {
      const parsed = parse(
        [
          'local Left = {}',
          'local Right = {}',
          'local function choose(flag) if flag then return Left end return Right end',
          'local Candidate = choose(true)',
          ...Array.from({ length: 20 }, () =>
            kind === 'name' ? 'consume(Candidate)' : 'consume(Candidate.slot)',
          ),
          'return Candidate',
        ].join('\n'),
      );
      const values = consumedValues(parsed);
      expect(values).toHaveLength(20);
      expect(new Set(values).size).toBe(20);
      const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
      probe.collectForeignWriteTargets();
      const walks = countOriginWalks(probe);
      for (const value of values)
        expect([...probe.potentialTableOrigins(parsed.filePath, value, false)].sort()).toEqual([
          '@origin:["fixture.luau","1:13"]',
          '@origin:["fixture.luau","2:14"]',
        ]);
      expect(walks()).toBe(1);
    },
  );

  it('keeps shadowed binders separate while reusing the outer binder', () => {
    const parsed = parse(
      [
        'local Shared = {}',
        'consume(Shared)',
        'do',
        'local Shared = {}',
        'consume(Shared.slot)',
        'end',
        'consume(Shared.other)',
        'return Shared',
      ].join('\n'),
    );
    const values = consumedValues(parsed);
    expect(values).toHaveLength(3);
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    probe.collectForeignWriteTargets();
    const walks = countOriginWalks(probe);
    expect(
      values.map((value) => probe.potentialTableOrigins(parsed.filePath, value, false)),
    ).toEqual([
      ['@origin:["fixture.luau","1:15"]'],
      ['@origin:["fixture.luau","4:15"]'],
      ['@origin:["fixture.luau","1:15"]'],
    ]);
    expect(walks()).toBe(2);
  });

  it.each(['call argument', 'member write'])(
    'does not retrace an uncertain metatable receiver for every unrelated %s',
    (consumer) => {
      const count = 20;
      const parsed = parse(
        [
          'local function leaf() end',
          'local M = { go = leaf }',
          'local Other = {}',
          'local function choose(flag) if flag then return M end return Other end',
          ...Array.from(
            { length: count },
            (_, i) => `local function changed${i}() setmetatable(choose(true), {}) end`,
          ),
          ...Array.from({ length: count }, (_, i) =>
            consumer === 'call argument'
              ? `local function called${i}() external(setmetatable({}, {})) end`
              : `local function called${i}() local obj = setmetatable({}, {}); obj.field = true end`,
          ),
          'return { stable = leaf }',
        ].join('\n'),
      );
      const resolver = new LuauValueResolver([parsed]);
      const probe = resolver as unknown as OriginProbe;
      const originalOrigins = probe.potentialTableOrigins;
      const originalEvaluate = probe.evaluate;
      let tracingOrigins = 0;
      let chooseEvaluations = 0;
      probe.potentialTableOrigins = function (...args) {
        tracingOrigins++;
        try {
          return originalOrigins.apply(this, args);
        } finally {
          tracingOrigins--;
        }
      };
      probe.evaluate = function (path, value, ...context) {
        if (tracingOrigins && value.kind === 'name' && value.name === 'choose') chooseEvaluations++;
        return originalEvaluate.call(this, path, value, ...context);
      };

      const exports = resolver.moduleExports(parsed);
      expect(exports.get('stable')?.qualifiedName).toBe('leaf');
      // Each of the twenty distinct source receivers needs one complete walk.
      // The old behavior performed 400 walks; no wall-clock threshold is used.
      expect(chooseEvaluations).toBeGreaterThan(0);
      expect(chooseEvaluations).toBeLessThanOrEqual(count * 2);
    },
  );

  it('does not reuse a walk made before stored table values are indexed', () => {
    const parsed = parse(
      'local Child = {}\nlocal Container = {}\nContainer.child = Child\nreturn Container',
    );
    const facts = luauSideChannel(parsed.captureSideChannel);
    const root = facts?.returns[0];
    if (!root) throw new Error('Missing explicit module return');
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    const child = '@origin:["fixture.luau","1:14"]';
    expect(probe.potentialTableOrigins(parsed.filePath, root, false)).not.toContain(child);
    probe.collectForeignWriteTargets();
    expect(probe.potentialTableOrigins(parsed.filePath, root, false)).toContain(child);
  });

  it('retains fail-closed exhaustion after an earlier non-exhausted lookup', () => {
    const parsed = parse('return external()');
    const root = luauSideChannel(parsed.captureSideChannel)?.returns[0];
    if (!root) throw new Error('Missing explicit module return');
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    probe.collectForeignWriteTargets();
    expect(probe.potentialTableOrigins(parsed.filePath, root, false)).toEqual([]);
    expect(probe.potentialTableOrigins(parsed.filePath, root, true)).toEqual([
      '@unknown-table-origin',
    ]);
  });
});
