import { describe, expect, it } from 'vitest';
import { SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { luauProvider } from '../../../../src/core/ingestion/languages/luau.js';
import {
  emitLuauScopeCaptures,
  getLuauFacts,
} from '../../../../src/core/ingestion/languages/luau/captures.js';
import { getLuauParser } from '../../../../src/core/ingestion/languages/luau/query.js';

function parse(source: string): ParsedFile {
  const warnings: string[] = [];
  const parsed = extractParsedFile(luauProvider, source, 'fixture.luau', (message) =>
    warnings.push(message),
  );
  expect(warnings).toEqual([]);
  expect(parsed).toBeDefined();
  return parsed!;
}

describe('Luau native scope captures', () => {
  it('registers both Roblox source extensions without another parser', () => {
    expect(luauProvider.id).toBe(SupportedLanguages.Luau);
    expect(luauProvider.extensions).toEqual(['.luau', '.lua']);
  });

  it('indexes named, assigned, table-field, nested, passed and returned functions once', () => {
    const source = [
      'local function leaf() end',
      'function global() leaf() end',
      'local assigned = function() leaf() end',
      'local M = { field = function() leaf() end }',
      'function M:method() self.field() end',
      'local function outer()',
      '  local inner = function() leaf() end',
      '  consume(function() inner() end)',
      '  return function() leaf() end',
      'end',
      'return M',
    ].join('\n');
    const parsed = parse(source);
    expect(parsed.scopes.filter((scope) => scope.kind === 'Function')).toHaveLength(9);
    expect(
      parsed.localDefs.filter((def) => def.type === 'Function' || def.type === 'Method'),
    ).toHaveLength(9);
    expect(parsed.localDefs.map((def) => def.qualifiedName)).toEqual(
      expect.arrayContaining([
        'leaf',
        'global',
        'assigned',
        'M.field',
        'M.method',
        'outer',
        'inner',
      ]),
    );
    const ownCalls = parsed.referenceSites.filter(
      (site) => site.kind === 'call' && site.name === 'leaf',
    );
    expect(ownCalls).toHaveLength(5);
    expect(new Set(ownCalls.map((site) => site.callerScope ?? site.inScope)).size).toBe(5);
  });

  it('keeps distinct same-line anonymous identities and source columns', () => {
    const source = 'local a = function() end; local b = function() end';
    const parsed = parse(source);
    const functions = parsed.localDefs.filter((def) => def.type === 'Function');
    expect(new Set(functions.map((def) => def.nodeId)).size).toBe(2);
    expect(functions.map((def) => def.declarationRange?.startCol)).toEqual([10, 36]);
  });

  it('retains a short empty closure whose typed binding name is longer than its body', () => {
    const parsed = parse('local releaseTransition: () -> () = function() end');
    expect(parsed.localDefs.filter((def) => def.type === 'Function')).toEqual([
      expect.objectContaining({
        qualifiedName: 'releaseTransition',
        declarationRange: { startLine: 1, startCol: 36, endLine: 1, endCol: 50 },
      }),
    ]);
  });

  it('does not turn a callback value into an invocation', () => {
    const parsed = parse(
      'local function callback() end\nlocal function save(cb) return cb end\nsave(callback)',
    );
    expect(
      parsed.referenceSites.filter((site) => site.kind === 'call').map((site) => site.name),
    ).toEqual(['save']);
    expect(
      parsed.referenceSites.filter((site) => site.kind === 'value-ref').map((site) => site.name),
    ).toContain('callback');
  });

  it('records colon calls and computed calls separately from bare calls', () => {
    const parsed = parse('local M = {}\nM:run(1)\nM.run(2)\nM[key](3)');
    expect(
      parsed.referenceSites
        .filter((site) => site.kind === 'call')
        .map((site) => ({
          name: site.name,
          form: site.callForm,
          receiver: site.explicitReceiver?.name,
        })),
    ).toEqual([
      { name: 'run', form: 'member', receiver: 'M' },
      { name: 'run', form: 'member', receiver: 'M' },
      { name: '[key]', form: 'index', receiver: 'M' },
    ]);
  });

  it('records type aliases, exported types, generics, packs and type-only uses', () => {
    const parsed = parse(
      'type Hidden = number\nexport type Box<T, U...> = { value: T, run: (U...) -> Hidden? }\nlocal function identity<T>(value: T): T return value end',
    );
    const hidden = parsed.localDefs.find((def) => def.qualifiedName === 'Hidden');
    const box = parsed.localDefs.find((def) => def.qualifiedName === 'Box');
    expect(hidden).toMatchObject({ type: 'TypeAlias', isExported: false });
    expect(box).toMatchObject({ type: 'TypeAlias', isExported: true });
    expect(box?.typeParameters?.map((parameter) => parameter.name)).toEqual(['T', 'U']);
    expect(
      getLuauFacts('export type Box<T, U...> = (U...) -> T', 'packs.luau').declarations[0]
        ?.typeParameters,
    ).toEqual(['T', 'U...']);
    expect(parsed.referenceSites.filter((site) => site.name === 'Hidden')).toEqual([
      expect.objectContaining({ kind: 'type-reference', lookupPurpose: 'type' }),
    ]);
    expect(
      parsed.referenceSites.some(
        (site) => site.kind === 'call' && ['T', 'Hidden'].includes(site.name),
      ),
    ).toBe(false);
  });

  it('retains dynamic requires as explicitly unresolved imports', () => {
    const parsed = parse(
      'local A = require("./a")\nlocal B = require(script.Parent.B)\nlocal C = require(prefix .. suffix)',
    );
    expect(parsed.parsedImports).toHaveLength(3);
    expect(parsed.parsedImports.map((imp) => imp.kind)).toEqual([
      'namespace',
      'namespace',
      'dynamic-unresolved',
    ]);
    expect(parsed.parsedImports[2]).toMatchObject({
      localName: 'C',
      targetRaw: 'prefix .. suffix',
    });
  });

  it('respects shadowed require and script roots', () => {
    const parsed = parse('local function f(require, script)\n  require(script.Child)\nend');
    expect(parsed.parsedImports).toEqual([]);
    expect(
      parsed.referenceSites.filter((site) => site.kind === 'call').map((site) => site.name),
    ).toEqual(['require']);
  });

  it('indexes returned-table fields, type fields, module variables and writes', () => {
    const parsed = parse(
      'local state = 0\nlocal M = { count = state }\nexport type Shape = { count: number }\nstate = 1\nM.count = state\nreturn M',
    );
    expect(
      parsed.localDefs.filter((def) => def.type === 'Variable').map((def) => def.qualifiedName),
    ).toEqual(['state', 'M']);
    expect(
      parsed.localDefs.filter((def) => def.type === 'Property').map((def) => def.qualifiedName),
    ).toEqual(['M.count', 'Shape.count']);
    expect(
      parsed.referenceSites.filter((site) => site.kind === 'write').map((site) => site.name),
    ).toEqual(['state', 'count']);
  });

  it('indexes quoted record keys without turning broad index signatures into fields', () => {
    const parsed = parse(
      'export type Record = { ["sentAt"]: number, [\'seconds\']: number, [string]: unknown }',
    );
    expect(
      parsed.localDefs.filter((def) => def.type === 'Property').map((def) => def.qualifiedName),
    ).toEqual(['Record.sentAt', 'Record.seconds']);
  });

  it('records typeof expressions as uses rather than runtime invocations', () => {
    const parsed = parse('local function make() return {} end\ntype Instance = typeof(make())');
    expect(parsed.referenceSites.filter((site) => site.kind === 'call')).toEqual([]);
    expect(parsed.referenceSites.filter((site) => site.name === 'make')).toEqual([
      expect.objectContaining({ kind: 'value-ref' }),
    ]);
  });

  it('rejects recovered syntax rather than reporting a complete capture set', () => {
    expect(() => emitLuauScopeCaptures('local function broken(', 'broken.luau')).toThrow(
      /syntax|parse/i,
    );
  });

  it('coalesces an equal-range statement and its surrounding block', () => {
    const parsed = parse(
      'local function run(items)\n  for _, item in items do\n    repeat\n      item()\n    until ready\n  end\nend',
    );
    expect(
      parsed.referenceSites.filter((site) => site.kind === 'call').map((site) => site.name),
    ).toEqual(['item']);
    const ranges = parsed.scopes
      .filter((scope) => scope.kind !== 'Module')
      .map((scope) => JSON.stringify(scope.range));
    expect(new Set(ranges).size).toBe(ranges.length);
  });

  it('reuses cached trees and retains UTF-16 columns', () => {
    const source = 'local emoji = "😀"; local f = function() end';
    const tree = getLuauParser().parse(source)!;
    expect(emitLuauScopeCaptures(source, 'unicode.luau', tree)).toEqual(
      emitLuauScopeCaptures(source, 'unicode.luau'),
    );
    const facts = getLuauFacts(source, 'unicode.luau', tree);
    expect(facts.declarations.find((def) => def.name === 'f')?.range.startCol).toBe(
      source.indexOf('function'),
    );
  });
});
