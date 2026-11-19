import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { luauProvider } from '../../../../src/core/ingestion/languages/luau.js';
import { collectLuauCaptureSideChannel } from '../../../../src/core/ingestion/languages/luau/captures.js';
import {
  luauSideChannel,
  type LuauValue,
} from '../../../../src/core/ingestion/languages/luau/facts.js';
import { LuauValueResolver } from '../../../../src/core/ingestion/languages/luau/value-resolution.js';
import { loadLuauResolutionConfig } from '../../../../src/core/ingestion/languages/luau/module-resolution.js';

function parse(source: string, filePath = 'fixture.luau'): ParsedFile {
  const warnings: string[] = [];
  const parsed = extractParsedFile(luauProvider, source, filePath, (message) =>
    warnings.push(message),
  );
  expect(warnings).toEqual([]);
  if (!parsed) throw new Error('Synthetic Luau fixture did not produce scopes');
  const captureSideChannel = collectLuauCaptureSideChannel(filePath);
  if (!captureSideChannel) throw new Error('Missing Luau source facts');
  return { ...parsed, captureSideChannel };
}

/** Observe real traversal work without replacing any resolution result. */
interface OriginProbe {
  potentialTableOrigins(path: string, value: LuauValue, exhausted?: boolean): readonly string[];
  traceTableOrigins(path: string, value: LuauValue): unknown;
  evaluate(path: string, value: LuauValue, ...context: unknown[]): unknown;
  collectForeignWriteTargets(): unknown;
  collectTableEscapes(): unknown;
  metatableReceiver(
    path: string,
    call: Extract<LuauValue, { kind: 'call' }>,
    context: unknown,
  ): unknown;
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
  it('reuses completed metatable receiver comparisons after effect analysis', () => {
    const parsed = parse(
      [
        'local M = setmetatable({}, {})',
        'local function make() return {} end',
        'local other = make()',
        'setmetatable(other, {})',
        'return M',
      ].join('\n'),
    );
    const facts = luauSideChannel(parsed.captureSideChannel);
    const root = facts?.returns[0];
    const call = facts?.references
      .map((reference) => reference.value)
      .find(
        (value) =>
          value.kind === 'call' &&
          value.callee.kind === 'name' &&
          value.callee.name === 'setmetatable' &&
          value.args[0]?.kind === 'name' &&
          value.args[0].name === 'other',
      );
    if (!root || call?.kind !== 'call' || !call.args[0])
      throw new Error('Missing metatable fixture');
    const receiver = call.args[0];
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    probe.collectForeignWriteTargets();
    probe.collectTableEscapes();
    const originalEvaluate = probe.evaluate;
    let comparisons = 0;
    probe.evaluate = function (path, value, ...context) {
      if (value === receiver) comparisons++;
      return originalEvaluate.call(this, path, value, ...context);
    };
    for (let query = 0; query < 2; query++)
      expect(probe.evaluate(parsed.filePath, root, new Set(), { left: 512 })).toMatchObject({
        kind: 'table',
      });
    // Observe actual candidate work rather than a wall-clock threshold. The
    // same immutable receiver does not need reevaluation for every caller.
    expect(comparisons).toBe(1);
  });

  it('reuses immutable raw metatable candidates across caller budgets and indexing', () => {
    const parsed = parse(
      'local M = {}\nlocal Holder = {receiver = M}\nsetmetatable(Holder.receiver, {})',
    );
    const call = luauSideChannel(parsed.captureSideChannel)
      ?.references.map((reference) => reference.value)
      .find(
        (value) =>
          value.kind === 'call' &&
          value.callee.kind === 'name' &&
          value.callee.name === 'setmetatable',
      );
    if (call?.kind !== 'call' || !call.args[0]) throw new Error('Missing metatable fixture');
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    const originalEvaluate = probe.evaluate;
    let comparisons = 0;
    probe.evaluate = function (path, value, ...context) {
      if (value === call.args[0]) comparisons++;
      return originalEvaluate.call(this, path, value, ...context);
    };
    for (const left of [7, 31, 512]) {
      if (left === 512) probe.collectForeignWriteTargets();
      const budget = {
        left,
        ignoreTableEscapes: true,
        ignoreForeignWrites: true,
        memberWriteComparison: true,
        memberWriteWork: { left: 17 },
      };
      expect(probe.metatableReceiver(parsed.filePath, call, budget)).toMatchObject({
        value: { kind: 'table' },
        exhausted: false,
      });
      // This independent query reads only captured source facts. Its work
      // neither consumes the caller's allowance nor changes after indexing.
      expect(budget.left).toBe(left);
      expect(budget.memberWriteWork.left).toBe(17);
    }
    expect(comparisons).toBe(1);
  });

  it('keeps an immutable raw candidate cache separate from indexed member writes', async () => {
    const sources = {
      'library.luau': 'return {receiver = {}}',
      'main.luau': [
        'local Holder = require("./library")',
        'Holder.receiver = {}',
        'setmetatable(Holder.receiver, {})',
      ].join('\n'),
    };
    const directory = await mkdtemp(join(tmpdir(), 'luau-metatable-mode-'));
    try {
      await Promise.all(
        Object.entries(sources).map(([path, source]) => writeFile(join(directory, path), source)),
      );
      const files = Object.entries(sources).map(([path, source]) => parse(source, path));
      const main = files.find((file) => file.filePath === 'main.luau');
      const call = luauSideChannel(main?.captureSideChannel)
        ?.references.map((reference) => reference.value)
        .find(
          (value) =>
            value.kind === 'call' &&
            value.callee.kind === 'name' &&
            value.callee.name === 'setmetatable',
        );
      if (!main || call?.kind !== 'call') throw new Error('Missing imported receiver fixture');
      const config = await loadLuauResolutionConfig(directory, Object.keys(sources));
      const probe = new LuauValueResolver(files, config) as unknown as OriginProbe;
      expect(
        probe.metatableReceiver(main.filePath, call, {
          left: 512,
          ignoreTableEscapes: true,
          ignoreForeignWrites: true,
        }),
      ).toMatchObject({ value: { kind: 'table', file: 'library.luau' }, exhausted: false });
      probe.collectForeignWriteTargets();
      // The raw-source memo must not hide the importer's now-indexed write.
      expect(
        probe.metatableReceiver(main.filePath, call, { left: 512, ignoreTableEscapes: true }),
      ).toMatchObject({
        value: { kind: 'unknown', reason: 'cross-module-member-write' },
        exhausted: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves receiver dependencies after a lookup without a dependency collector', () => {
    const parsed = parse(
      'local target = {}\nlocal Holder = {receiver = target}\nsetmetatable(Holder.receiver, {})',
    );
    const facts = luauSideChannel(parsed.captureSideChannel);
    const call = facts?.references
      .map((reference) => reference.value)
      .find(
        (value) =>
          value.kind === 'call' &&
          value.callee.kind === 'name' &&
          value.callee.name === 'setmetatable',
      );
    const holder = facts?.tables.find((table) => Object.hasOwn(table.fields, 'receiver'));
    if (call?.kind !== 'call' || !holder) throw new Error('Missing receiver dependency fixture');
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    probe.collectForeignWriteTargets();
    probe.collectTableEscapes();
    expect(probe.metatableReceiver(parsed.filePath, call, { left: 512 })).toMatchObject({
      value: { kind: 'table' },
      exhausted: false,
    });
    const dependencies = new Set<string>();
    expect(
      probe.metatableReceiver(parsed.filePath, call, {
        left: 512,
        purityDependencies: dependencies,
      }),
    ).toMatchObject({ value: { kind: 'table' }, exhausted: false });
    // The member identity depends on Holder's contents even when an earlier
    // ordinary query already obtained the same receiver identity.
    expect(dependencies).toContain(`@origin:${JSON.stringify([parsed.filePath, holder.position])}`);
  });

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
        'consume(Shared)',
        'end',
        'consume(Shared)',
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

  it('rechecks a pre-index member walk once scalar field evidence is complete', () => {
    const parsed = parse('local M = {scalar = 42}\nconsume(M.scalar)');
    const root = consumedValues(parsed)[0];
    if (!root) throw new Error('Missing member argument');
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    const walks = countOriginWalks(probe);
    // Before receiver indexing finishes, an absent foreign write is not proof
    // of no write. No stored-list growth occurs in this fixture, so the phase
    // dependency itself must invalidate the conservative cached result.
    expect(probe.potentialTableOrigins(parsed.filePath, root, false)).toContain(
      '@origin:["fixture.luau","1:10"]',
    );
    probe.collectForeignWriteTargets();
    expect(probe.potentialTableOrigins(parsed.filePath, root, false)).toEqual([]);
    expect(walks()).toBe(2);
  });

  it('rechecks a pre-index call whose getter is overwritten by an importer', async () => {
    const sources = {
      'library.luau': 'local Child = {}\nreturn {get = function() return Child end}',
      'main.luau': [
        'local Holder = require("./library")',
        'local Parent = {}',
        'Holder.get = function() return Parent end',
        'consume(Holder.get())',
      ].join('\n'),
    };
    const directory = await mkdtemp(join(tmpdir(), 'luau-origin-call-'));
    try {
      await Promise.all(
        Object.entries(sources).map(([path, source]) => writeFile(join(directory, path), source)),
      );
      const files = Object.entries(sources).map(([path, source]) => parse(source, path));
      const main = files.find((file) => file.filePath === 'main.luau');
      const root = main && consumedValues(main)[0];
      if (!main || !root) throw new Error('Missing imported getter argument');
      const config = await loadLuauResolutionConfig(directory, Object.keys(sources));
      const probe = new LuauValueResolver(files, config) as unknown as OriginProbe;
      const walks = countOriginWalks(probe);
      const parent = '@origin:["main.luau","2:15"]';
      expect(probe.potentialTableOrigins(main.filePath, root, false)).not.toContain(parent);
      probe.collectForeignWriteTargets();
      // Callee evaluation reads Holder.get without visiting a member entry
      // in the origin walk. That hidden phase dependency must invalidate the
      // old return proof even though none of its recorded stores changed.
      expect(probe.potentialTableOrigins(main.filePath, root, false)).toContain(parent);
      expect(walks()).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps scalar and table members of the same immutable binder separate', () => {
    const parsed = parse(
      'local Child = {}\nlocal M = {scalar = 42, child = Child}\nconsume(M.scalar)\nconsume(M.child)',
    );
    const values = consumedValues(parsed);
    expect(values).toHaveLength(2);
    const [scalar, child] = values;
    if (!scalar || !child) throw new Error('Missing member arguments');
    const probe = new LuauValueResolver([parsed]) as unknown as OriginProbe;
    probe.collectForeignWriteTargets();
    const walks = countOriginWalks(probe);
    expect(probe.potentialTableOrigins(parsed.filePath, scalar, false)).toEqual([]);
    expect(probe.potentialTableOrigins(parsed.filePath, child, false)).toContain(
      '@origin:["fixture.luau","1:14"]',
    );
    expect(walks()).toBe(2);
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
