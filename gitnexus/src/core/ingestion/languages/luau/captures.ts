import type Parser from 'tree-sitter';
import {
  makeScopeId,
  type Capture,
  type CaptureMatch,
  type NameClaim,
  type Range,
  type ScopeKind,
} from 'gitnexus-shared';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { getLuauParser } from './query.js';
import {
  luauPosition,
  type LuauBinding,
  type LuauDeclaration,
  type LuauFacts,
  type LuauMemberWrite,
  type LuauReferenceFact,
  type LuauScopeFact,
  type LuauSideChannel,
  type LuauTableFact,
  type LuauValue,
} from './facts.js';

type Node = Parser.SyntaxNode;
const FUNCTION_NODES = new Set(['fn_stmt', 'local_fn_stmt', 'anon_fn', 'type_fn_stmt']);
const factsByTree = new WeakMap<Parser.Tree, Map<string, LuauFacts>>();
const pendingSideChannels = new Map<string, LuauSideChannel>();
const unknown = (reason: string): LuauValue => ({ kind: 'unknown', reason });
const capture = (name: string, range: Range, text = ''): Capture => ({ name, range, text });
const rangeOf = (node: Node): Range => ({
  startLine: node.startPosition.row + 1,
  startCol: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endCol: node.endPosition.column,
});
const atEnd = (range: Range) => ({ startLine: range.endLine, startCol: range.endCol });
const positionBefore = (
  a: { startLine: number; startCol: number },
  b: { startLine: number; startCol: number },
): boolean =>
  a.startLine < b.startLine || (a.startLine === b.startLine && a.startCol <= b.startCol);
const named = (node: Node, type: string): Node[] =>
  node.namedChildren.filter((child) => child.type === type);

/** Native Node tree-sitter string input uses UTF-16 columns; do not reinterpret these as UTF-8 bytes. */
function functionRange(node: Node): Range {
  const keyword = node.children.find((child) => child.type === 'function');
  return {
    ...rangeOf(node),
    ...(keyword
      ? { startLine: keyword.startPosition.row + 1, startCol: keyword.startPosition.column }
      : {}),
  };
}

/** Reject unfamiliar escape forms instead of guessing a module or member name. */
export function luauStringValue(node: Node | null): string | undefined {
  if (node?.type !== 'string') return undefined;
  const text = node.text;
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(text);
  if (long) return long[2]!.replace(/^\r?\n/, '');
  if (!((text[0] === '"' || text[0] === "'") && text.at(-1) === text[0])) return undefined;
  let value = '';
  for (let index = 1; index < text.length - 1; index++) {
    if (text[index] !== '\\') {
      value += text[index];
      continue;
    }
    const escaped = text[++index];
    const simple: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      '"': '"',
      "'": "'",
    };
    if (escaped !== undefined && simple[escaped] !== undefined) {
      value += simple[escaped];
      continue;
    }
    if (escaped === 'z') {
      while (/\s/.test(text[index + 1] ?? '') && index < text.length - 2) index++;
      continue;
    }
    if (escaped === '\n') {
      value += '\n';
      continue;
    }
    const decimal = /^\d{1,3}/.exec(text.slice(index));
    if (decimal) {
      const n = Number(decimal[0]);
      if (n > 255) return undefined;
      value += String.fromCharCode(n);
      index += decimal[0].length - 1;
      continue;
    }
    if (escaped === 'x') {
      const hex = /^[\da-fA-F]{2}/.exec(text.slice(index + 1));
      if (!hex) return undefined;
      value += String.fromCharCode(parseInt(hex[0], 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      const hex = /^\{([\da-fA-F]+)\}/.exec(text.slice(index + 1));
      if (!hex) return undefined;
      const n = parseInt(hex[1]!, 16);
      if (n > 0x10ffff) return undefined;
      value += String.fromCodePoint(n);
      index += hex[0].length;
      continue;
    }
    return undefined;
  }
  return value;
}

function keyName(node: Node | undefined): { name: string; node: Node } | undefined {
  if (node === undefined) return undefined;
  const identifier = node.childForFieldName('field_name');
  if (identifier) return { name: identifier.text, node: identifier };
  const indexerType = node.childForFieldName('indexer_type_specifier');
  const index =
    node.childForFieldName('field_indexer') ??
    (indexerType?.type === 'singleton' ? indexerType.namedChild(0) : null);
  const literal = luauStringValue(index);
  return literal === undefined || index === null ? undefined : { name: literal, node: index };
}

interface Context {
  readonly scope: LuauScopeFact;
  readonly callable?: LuauDeclaration;
  readonly typeOnly?: boolean;
}

/** One source walk builds declarations/scopes first; the second classifies uses with the complete lexical environment. */
function collectFacts(tree: Parser.Tree, source: string, filePath: string): LuauFacts {
  if (tree.rootNode.hasError)
    throw new Error(`Luau syntax errors prevent complete scope extraction: ${filePath}`);
  const captures: CaptureMatch[] = [];
  const declarations: LuauDeclaration[] = [];
  const scopes: LuauScopeFact[] = [];
  const bindings: LuauBinding[] = [];
  const bindingsByScope = new Map<string, Map<string, LuauBinding[]>>();
  const tables: LuauTableFact[] = [];
  const memberWrites: LuauMemberWrite[] = [];
  const returns: LuauValue[] = [];
  const functionReturns: Record<string, LuauValue[]> = {};
  const references: LuauReferenceFact[] = [];
  const contextByNode = new Map<number, Context>();
  const declarationByNode = new Map<number, LuauDeclaration>();
  const scopeById = new Map<string, LuauScopeFact>();
  const bindingByInitializer = new Map<number, LuauBinding>();
  const memberFunctionBase = new Map<number, { base: string; name: Node; context: Context }>();
  const functionAssignments = new Map<number, Context>();

  function addScope(
    node: Node,
    kind: ScopeKind,
    parent: LuauScopeFact | null,
    range = rangeOf(node),
  ): LuauScopeFact {
    // A block containing just one loop/type statement can have exactly that
    // statement's range. The shared scope tree requires strict containment;
    // these are one lexical region, so reuse its scope rather than emit twins.
    if (
      parent &&
      parent.kind !== 'Module' &&
      parent.range.startLine === range.startLine &&
      parent.range.startCol === range.startCol &&
      parent.range.endLine === range.endLine &&
      parent.range.endCol === range.endCol
    )
      return parent;
    const scope: LuauScopeFact = {
      id: makeScopeId({ filePath, range, kind }),
      kind,
      parent: parent?.id ?? null,
      range,
      claims: [],
    };
    scopes.push(scope);
    scopeById.set(scope.id, scope);
    return scope;
  }
  const moduleScope = addScope(tree.rootNode, 'Module', null);

  function value(node: Node | null, scope: string): LuauValue {
    if (node === null) return unknown('missing-expression');
    if (node.type === 'name') return { kind: 'name', name: node.text, scope, at: rangeOf(node) };
    if (FUNCTION_NODES.has(node.type))
      return { kind: 'function', position: luauPosition(functionRange(node)) };
    if (node.type === 'table') return { kind: 'table', position: luauPosition(rangeOf(node)) };
    if (node.type === 'string') {
      const literal = luauStringValue(node);
      return literal === undefined ? unknown('string-escape') : { kind: 'string', value: literal };
    }
    if (node.type === 'exp_wrap' || node.type === 'cast')
      return value(node.childForFieldName('left') ?? node.namedChild(0), scope);
    if (node.type === 'type_instantiator')
      return value(node.childForFieldName('instantiatee'), scope);
    if (node.type === 'ifexp') {
      const branches: LuauValue[] = [];
      let branch = false;
      for (const child of node.children) {
        if (child.type === 'then' || child.type === 'else') branch = true;
        else if (branch && child.isNamed) {
          branches.push(value(child, scope));
          branch = false;
        }
      }
      return { kind: 'unknown', reason: 'ifexp', possibleValues: branches };
    }
    if (
      node.type === 'binexp' &&
      node.children.some((child) => child.type === 'and' || child.type === 'or')
    )
      return {
        kind: 'unknown',
        reason: 'conditional-boolean-value',
        possibleValues: node.namedChildren.map((child) => value(child, scope)),
      };
    if (node.type === 'var') {
      const baseName =
        node.childForFieldName('variable_name') ?? node.childForFieldName('table_name');
      let result: LuauValue = baseName
        ? { kind: 'name', name: baseName.text, scope, at: rangeOf(baseName) }
        : value(node.namedChildren.find((child) => child.type !== 'key') ?? null, scope);
      for (const key of named(node, 'key')) {
        const known = keyName(key);
        if (!known) return { kind: 'unknown', reason: 'computed-member', possibleValues: [result] };
        result = { kind: 'member', base: result, name: known.name };
      }
      return result;
    }
    if (node.type === 'call_stmt') {
      const method = node.childForFieldName('method_name');
      const callee = value(
        node.childForFieldName('invoked') ?? node.childForFieldName('method_table'),
        scope,
      );
      const args =
        named(node, 'arglist')[0]?.namedChildren.map((argument) => value(argument, scope)) ?? [];
      return {
        kind: 'call',
        callee,
        args,
        at: rangeOf(node),
        ...(method ? { method: method.text } : {}),
      };
    }
    return unknown(node.type);
  }

  function tableName(node: Node): string | undefined {
    const parent = node.parent;
    if (parent?.type === 'explist') {
      const statement = parent.parent;
      const index = parent.namedChildren.findIndex((child) => child.id === node.id);
      const list = statement?.namedChildren.find(
        (child) => child.type === 'bindinglist' || child.type === 'varlist',
      );
      const lhs = list?.namedChild(index);
      return (
        lhs?.childForFieldName('variable_name')?.text ??
        (lhs?.type === 'var' ? lhs.text : undefined)
      );
    }
    if (parent?.type === 'field' && parent.parent?.type === 'table') {
      const owner = tableName(parent.parent);
      const key = keyName(parent);
      return owner && key ? `${owner}.${key.name}` : undefined;
    }
    return undefined;
  }

  function describeFunction(node: Node): {
    name: string;
    qualified: string;
    binding: string;
    nameRange: Range;
    member?: { base: string; name: Node };
    typeFunction: boolean;
  } {
    const range = functionRange(node);
    const plain = node.childForFieldName('function_name');
    const owner = node.childForFieldName('table_name');
    const keys = named(node, 'key');
    const method = node.childForFieldName('method_name');
    if (owner) {
      const parts = [owner.text, ...keys.map((key) => keyName(key)?.name ?? '[computed]')];
      const last = method ?? keyName(keys.at(-1)!)?.node;
      if (last) {
        const base = method ? parts.join('.') : parts.slice(0, -1).join('.');
        return {
          name: last.text,
          qualified: `${base}.${last.text}`,
          binding: '',
          nameRange: rangeOf(last),
          member: { base, name: last },
          typeFunction: false,
        };
      }
    }
    if (plain)
      return {
        name: plain.text,
        qualified: plain.text,
        binding: plain.text,
        nameRange: rangeOf(plain),
        typeFunction: node.type === 'type_fn_stmt',
      };
    const parent = node.parent;
    if (parent?.type === 'explist') {
      const statement = parent.parent;
      const index = parent.namedChildren.findIndex((child) => child.id === node.id);
      const lhs = statement?.namedChildren
        .find((child) => child.type === 'bindinglist' || child.type === 'varlist')
        ?.namedChild(index);
      const name = lhs?.childForFieldName('variable_name');
      if (name && lhs?.namedChildren.every((child) => child.type !== 'key'))
        return {
          name: name.text,
          qualified: name.text,
          binding: name.text,
          nameRange: rangeOf(name),
          typeFunction: false,
        };
      if (lhs?.type === 'var') {
        const key = named(lhs, 'key').at(-1);
        const tail = key && keyName(key);
        if (tail) {
          const base = source.slice(lhs.startIndex, key.startIndex);
          return {
            name: tail.name,
            qualified: `${base}.${tail.name}`,
            binding: '',
            nameRange: rangeOf(tail.node),
            member: { base, name: tail.node },
            typeFunction: false,
          };
        }
      }
    }
    if (parent?.type === 'field' && parent.parent?.type === 'table') {
      const key = keyName(parent);
      const ownerName = tableName(parent.parent);
      if (key)
        return {
          name: key.name,
          qualified: ownerName ? `${ownerName}.${key.name}` : key.name,
          binding: '',
          nameRange: rangeOf(key.node),
          typeFunction: false,
        };
    }
    const name = `anonymous_${range.startLine}_${range.startCol}`;
    return {
      name,
      qualified: name,
      binding: '',
      nameRange: { ...range, endLine: range.startLine, endCol: range.startCol },
      typeFunction: false,
    };
  }

  function addBinding(
    name: string,
    scope: LuauScopeFact,
    range: Range,
    availableFrom: LuauBinding['availableFrom'],
    boundValue: LuauValue,
    options: Pick<
      LuauBinding,
      'declarationPosition' | 'parameter' | 'bindingPosition' | 'writeScope'
    > = {},
  ): LuauBinding {
    const binding: LuauBinding = {
      name,
      scope: scope.id,
      range,
      availableFrom,
      value: boundValue,
      bindingPosition: luauPosition(range),
      ...options,
    };
    bindings.push(binding);
    let names = bindingsByScope.get(scope.id);
    if (!names) {
      names = new Map();
      bindingsByScope.set(scope.id, names);
    }
    const entries = names.get(name) ?? [];
    entries.push(binding);
    names.set(name, entries);
    const claim: NameClaim = {
      name,
      range,
      kind: 'binding',
      availableFrom,
      inactive: 'outer',
      purpose: 'value',
    };
    scope.claims.push(claim);
    return binding;
  }

  function localLookup(name: string, scopeId: string, at: Range): LuauBinding | undefined {
    let scope: LuauScopeFact | undefined = scopeById.get(scopeId);
    while (scope) {
      let latest: LuauBinding | undefined;
      for (const binding of bindingsByScope.get(scope.id)?.get(name) ?? []) {
        if (
          positionBefore(binding.availableFrom, at) &&
          (!latest || positionBefore(latest.availableFrom, binding.availableFrom))
        )
          latest = binding;
      }
      if (latest) return latest;
      scope = scope.parent ? scopeById.get(scope.parent) : undefined;
    }
    return undefined;
  }

  function functionScope(scopeId: string): string | undefined {
    let scope = scopeById.get(scopeId);
    while (scope) {
      if (scope.kind === 'Function') return scope.id;
      scope = scope.parent ? scopeById.get(scope.parent) : undefined;
    }
    return undefined;
  }

  /** A table value has a structural owner only when a source binder names it. */
  function tableOwner(table: Node): LuauDeclaration['owner'] {
    const binding = bindingByInitializer.get(table.id);
    if (binding) return { kind: 'Variable', position: binding.bindingPosition! };
    if (table.parent?.type === 'field') {
      const name = keyName(table.parent);
      if (name) return { kind: 'Property', position: luauPosition(rangeOf(name.node)) };
    }
    return undefined;
  }

  function walk(node: Node, inherited: Context): void {
    let context = inherited;
    if (FUNCTION_NODES.has(node.type)) {
      const range = functionRange(node);
      const details = describeFunction(node);
      const scope = addScope(node, 'Function', inherited.scope, range);
      const parameters = named(node, 'paramlist')[0]?.namedChildren ?? [];
      const parameterNames = parameters.map(
        (parameter) => parameter.childForFieldName('parameter_name')?.text ?? '...',
      );
      const parameterTypes = parameters.map(
        (parameter) =>
          parameter
            .childrenForFieldName('type_specifier')
            .map((type) => type.text)
            .join('') || 'unknown',
      );
      const typeParameters = node.namedChildren
        .filter((child) => child.type === 'generic' || child.type === 'genpack')
        .map((child) => child.text);
      const returnType = node
        .childrenForFieldName('return_type')
        .map((type) => type.text)
        .join('');
      let bindingScope = inherited.scope;
      const existing =
        node.type === 'fn_stmt' && details.binding
          ? localLookup(details.binding, inherited.scope.id, range)
          : undefined;
      if (node.type === 'fn_stmt' && details.binding) {
        bindingScope = existing ? scopeById.get(existing.scope)! : moduleScope;
        if (existing) functionAssignments.set(node.id, inherited);
      }
      const ownerBinding =
        details.member && !details.member.base.includes('.')
          ? localLookup(details.member.base, inherited.scope.id, range)
          : undefined;
      const structuralOwner =
        node.parent?.type === 'field' && node.parent.parent?.type === 'table'
          ? tableOwner(node.parent.parent)
          : ownerBinding
            ? { kind: 'Variable' as const, position: ownerBinding.bindingPosition! }
            : undefined;
      const declaration: LuauDeclaration = {
        name: details.name,
        qualifiedName: details.qualified,
        // Reassignment creates a callable value, not a second lexical binder.
        // Retaining the name here would make shared write lookup select the
        // new function instead of the original variable receiving that value.
        bindingName: existing ? '' : details.binding,
        bindingScope: bindingScope.id,
        scope: scope.id,
        kind: details.member || node.parent?.type === 'field' ? 'Method' : 'Function',
        range,
        nameRange: details.nameRange,
        parameterNames,
        parameterTypes,
        variadic: parameterNames.includes('...'),
        ...(returnType ? { returnType } : {}),
        ...(typeParameters.length ? { typeParameters } : {}),
        ...(details.typeFunction ? { typeFunction: true } : {}),
        ...(structuralOwner ? { owner: structuralOwner } : {}),
        isExported: false,
      };
      declarations.push(declaration);
      declarationByNode.set(node.id, declaration);
      if (details.binding && node.type !== 'anon_fn') {
        addBinding(
          details.binding,
          bindingScope,
          range,
          { startLine: range.startLine, startCol: range.startCol },
          { kind: 'function', position: luauPosition(range) },
          {
            declarationPosition: luauPosition(range),
            // `function existing()` assigns the enclosing binding. Its body
            // is a new callable, but this write executes outside that body.
            ...(existing
              ? { bindingPosition: existing.bindingPosition, writeScope: inherited.scope.id }
              : {}),
          },
        );
        if (details.typeFunction)
          (bindingScope.claims.at(-1)! as { purpose: string }).purpose = 'type';
      }
      if (details.member) {
        // Assignment expressions are already recorded by collectAssignments;
        // only declaration-form methods need a separate member write.
        if (node.type === 'fn_stmt')
          memberFunctionBase.set(node.id, { ...details.member, context: inherited });
        if (node.childForFieldName('method_name')) {
          const parts = details.member.base.split('.');
          let receiver: LuauValue = {
            kind: 'name',
            name: parts[0]!,
            scope: inherited.scope.id,
            at: range,
          };
          for (const part of parts.slice(1))
            receiver = { kind: 'member', base: receiver, name: part };
          addBinding(
            'self',
            scope,
            range,
            { startLine: range.startLine, startCol: range.startCol },
            receiver,
            { parameter: true },
          );
        }
      }
      context = { ...inherited, scope, callable: declaration };
    } else if (node.type === 'block' && node.parent?.type !== 'repeat_stmt') {
      context = { ...inherited, scope: addScope(node, 'Block', inherited.scope) };
    } else if (node.type === 'table') {
      context = { ...inherited, scope: addScope(node, 'Object', inherited.scope) };
      tables.push({
        position: luauPosition(rangeOf(node)),
        scope: inherited.scope.id,
        // Luau keys are data, including __proto__ and constructor. Plain JS
        // dictionaries would invoke/inherit prototype properties here.
        fields: Object.create(null) as Record<string, LuauValue>,
        fieldPositions: Object.create(null) as Record<string, string>,
        values: [],
        incomplete: false,
      });
    } else if (
      node.type === 'type_stmt' ||
      node.type === 'fntype' ||
      ['for_in_stmt', 'for_range_stmt', 'repeat_stmt'].includes(node.type)
    ) {
      context = { ...inherited, scope: addScope(node, 'Expression', inherited.scope) };
    } else if (node.type === 'dyntype') {
      // typeof inspects an expression without executing it. Calls nested in
      // that expression are uses of a callable, not runtime invocations.
      context = { ...inherited, typeOnly: true };
    }
    contextByNode.set(node.id, context);

    if (node.type === 'type_stmt') {
      const name = node.childForFieldName('left')!;
      const typeParameters = node.namedChildren
        .filter((child) => child.type === 'genericdef' || child.type === 'genpackdef')
        .map(
          (child) =>
            (child.childForFieldName('generic_type_name') ?? child.namedChild(0))?.text ?? '',
        )
        .filter(Boolean);
      const declaration: LuauDeclaration = {
        name: name.text,
        qualifiedName: name.text,
        bindingName: name.text,
        bindingScope: inherited.scope.id,
        scope: context.scope.id,
        kind: 'TypeAlias',
        range: rangeOf(node),
        nameRange: rangeOf(name),
        declaredType: node
          .childrenForFieldName('right')
          .map((child) => child.text)
          .join(''),
        typeParameters,
        isExported: node.children.some((child) => child.type === 'export'),
      };
      declarations.push(declaration);
      declarationByNode.set(node.id, declaration);
      inherited.scope.claims.push({
        name: name.text,
        range: rangeOf(node),
        kind: 'binding',
        purpose: 'type',
        availableFrom: atEnd(rangeOf(name)),
        inactive: 'outer',
      });
    }
    if (node.type === 'generic' || node.type === 'genpack') {
      const name = node.namedChild(0)?.text;
      if (name)
        context.scope.claims.push({ name, range: rangeOf(node), kind: 'blocked', purpose: 'type' });
    }
    if (node.type === 'field' || node.type === 'proptype' || node.type === 'indexertype') {
      const key = keyName(node);
      const initializer = node.childForFieldName('value');
      if (key && (!initializer || !FUNCTION_NODES.has(initializer.type))) {
        let owner: string | undefined;
        let structuralOwner: LuauDeclaration['owner'];
        if (node.parent?.type === 'table') {
          owner = tableName(node.parent);
          structuralOwner = tableOwner(node.parent);
        } else {
          let ancestor = node.parent;
          while (ancestor && ancestor.type !== 'type_stmt' && ancestor.type !== 'chunk')
            ancestor = ancestor.parent;
          owner = ancestor?.childForFieldName('left')?.text;
          if (ancestor?.type === 'type_stmt')
            structuralOwner = { kind: 'TypeAlias', position: luauPosition(rangeOf(ancestor)) };
        }
        const declaredType = [
          ...node.childrenForFieldName('type_specifier'),
          ...node.childrenForFieldName('value_type_specifier'),
        ]
          .map((type) => type.text)
          .join('');
        declarations.push({
          name: key.name,
          qualifiedName: owner ? `${owner}.${key.name}` : key.name,
          bindingName: '',
          bindingScope: context.scope.id,
          scope: context.scope.id,
          kind: 'Property',
          range: rangeOf(key.node),
          nameRange: rangeOf(key.node),
          ...(declaredType ? { declaredType } : {}),
          ...(structuralOwner ? { owner: structuralOwner } : {}),
          isExported: false,
        });
      }
    }
    if (node.type === 'binding' || node.type === 'param') {
      const name = node.childForFieldName(
        node.type === 'param' ? 'parameter_name' : 'variable_name',
      );
      if (name) {
        const statement = node.parent?.type === 'bindinglist' ? node.parent.parent : node.parent;
        const index = node.parent?.namedChildren.findIndex((child) => child.id === node.id) ?? 0;
        const initializer =
          statement?.namedChildren.find((child) => child.type === 'explist')?.namedChild(index) ??
          null;
        const range = rangeOf(name);
        const boundValue = value(initializer, inherited.scope.id);
        const isParameter = node.type === 'param';
        const loopBody =
          statement && ['for_in_stmt', 'for_range_stmt'].includes(statement.type)
            ? statement.namedChildren.find((child) => child.type === 'block')
            : undefined;
        const availableFrom = isParameter
          ? { startLine: range.startLine, startCol: range.startCol }
          : loopBody
            ? { startLine: loopBody.startPosition.row + 1, startCol: loopBody.startPosition.column }
            : statement
              ? atEnd(rangeOf(statement))
              : atEnd(range);
        const binding = addBinding(name.text, context.scope, range, availableFrom, boundValue, {
          ...(initializer && FUNCTION_NODES.has(initializer.type)
            ? { declarationPosition: luauPosition(functionRange(initializer)) }
            : {}),
          ...(isParameter ? { parameter: true } : {}),
        });
        if (initializer) bindingByInitializer.set(initializer.id, binding);
        if (!initializer || !FUNCTION_NODES.has(initializer.type)) {
          const declaredType = node
            .childrenForFieldName('type_specifier')
            .map((type) => type.text)
            .join('');
          const declaration: LuauDeclaration = {
            name: name.text,
            qualifiedName: name.text,
            bindingName: name.text,
            bindingScope: context.scope.id,
            scope: context.scope.id,
            kind: 'Variable',
            range,
            nameRange: range,
            ...(declaredType ? { declaredType } : {}),
            isExported: false,
          };
          declarations.push(declaration);
          declarationByNode.set(node.id, declaration);
        }
      }
    }
    for (const child of node.namedChildren) walk(child, context);
  }
  // The root already owns the Module scope.
  contextByNode.set(tree.rootNode.id, { scope: moduleScope });
  for (const child of tree.rootNode.namedChildren) walk(child, { scope: moduleScope });

  // Collect all writes before folding any aliases. A later assignment or an
  // uncalled closure must not disappear merely because the read occurs first
  // in a source traversal. Control-flow execution is not inferred here.
  function collectAssignments(node: Node): void {
    const context = contextByNode.get(node.id)!;
    if (node.type === 'assign_stmt') {
      const lhs = named(node, 'varlist')[0]?.namedChildren ?? [];
      const rhs = named(node, 'explist')[0]?.namedChildren ?? [];
      lhs.forEach((target, index) => {
        const assigned = value(rhs[index] ?? null, context.scope.id);
        const targetValue = value(target, context.scope.id);
        if (targetValue.kind === 'member')
          memberWrites.push({
            base: targetValue.base,
            name: targetValue.name,
            value: assigned,
            at: rangeOf(target),
            scope: context.scope.id,
          });
        else if (targetValue.kind === 'name') {
          const previous = localLookup(targetValue.name, context.scope.id, rangeOf(target));
          const host = previous ? scopeById.get(previous.scope)! : moduleScope;
          addBinding(targetValue.name, host, rangeOf(target), atEnd(rangeOf(node)), assigned, {
            writeScope: context.scope.id,
            bindingPosition: previous?.bindingPosition ?? luauPosition(rangeOf(target)),
          });
          if (!previous && assigned.kind !== 'function')
            declarations.push({
              name: targetValue.name,
              qualifiedName: targetValue.name,
              bindingName: targetValue.name,
              bindingScope: host.id,
              scope: host.id,
              kind: 'Variable',
              range: rangeOf(target),
              nameRange: rangeOf(target),
              isExported: false,
            });
        } else {
          const root =
            target.childForFieldName('table_name') ?? target.childForFieldName('variable_name');
          const keys = named(target, 'key');
          if (root && keys.length > 0) {
            let base: LuauValue = {
              kind: 'name',
              name: root.text,
              scope: context.scope.id,
              at: rangeOf(root),
            };
            for (const key of keys.slice(0, -1)) {
              const known = keyName(key);
              base = known
                ? { kind: 'member', base, name: known.name }
                : unknown('computed-member-base');
            }
            memberWrites.push({
              base,
              name: null,
              value: assigned,
              at: rangeOf(target),
              scope: context.scope.id,
            });
          }
        }
      });
    }
    for (const child of node.namedChildren) collectAssignments(child);
  }
  for (const child of tree.rootNode.namedChildren) collectAssignments(child);

  function immutable(binding: LuauBinding): boolean {
    return !(bindingsByScope.get(binding.scope)?.get(binding.name) ?? []).some(
      (candidate) => candidate.writeScope !== undefined,
    );
  }

  function parameterValue(v: LuauValue, seen = new Set<LuauBinding>()): boolean {
    if (v.kind !== 'name') return false;
    const binding = localLookup(v.name, v.scope, v.at);
    if (!binding || !immutable(binding) || seen.has(binding)) return false;
    if (binding.parameter) return binding.name !== 'self';
    const next = new Set(seen);
    next.add(binding);
    return parameterValue(binding.value, next);
  }

  function operand(role: string, name: string, range: Range): Record<string, Capture> {
    return {
      [`@callable-flow.${role}`]: capture(`@callable-flow.${role}`, range, name),
      [`@callable-flow.${role}-kind`]: capture(`@callable-flow.${role}-kind`, range, 'binding'),
    };
  }

  // Shared callable flow handles immutable copies and actual/formal argument
  // transfer. No target is inferred merely because a callback is passed.
  for (const binding of bindings) {
    if (
      binding.parameter ||
      binding.writeScope ||
      !immutable(binding) ||
      binding.value.kind !== 'name'
    )
      continue;
    const source = localLookup(binding.value.name, binding.value.scope, binding.value.at);
    if (!source || !immutable(source)) continue;
    captures.push({
      '@callable-flow.copy': capture('@callable-flow.copy', binding.range),
      ...operand('source', binding.value.name, binding.value.at),
      ...operand('destination', binding.name, binding.range),
    });
  }

  function isRequire(node: Node, scope: string): boolean {
    const callee = node.childForFieldName('invoked');
    const identifier = callee?.childForFieldName('variable_name');
    return (
      node.type === 'call_stmt' &&
      identifier?.text === 'require' &&
      named(callee!, 'key').length === 0 &&
      !localLookup('require', scope, rangeOf(identifier))
    );
  }

  /** Keep alias folding lexical: `local script` is never the Roblox script root. */
  function staticExpression(v: LuauValue, seen = new Set<LuauBinding>()): unknown {
    if (v.kind === 'string') return v;
    if (v.kind === 'member')
      return { kind: 'member', base: staticExpression(v.base, seen), name: v.name };
    if (v.kind === 'name') {
      const binding = localLookup(v.name, v.scope, v.at);
      if (binding) {
        const writes = (bindingsByScope.get(binding.scope)?.get(binding.name) ?? []).filter(
          (candidate) => candidate.writeScope !== undefined,
        );
        if (
          writes.some((write) => write.writeScope !== binding.scope) ||
          (writes.length > 0 && functionScope(v.scope) !== functionScope(binding.scope))
        )
          return { kind: 'unknown', reason: 'mutable-captured-or-conditional-alias' };
        if (seen.has(binding)) return { kind: 'unknown', reason: 'alias-cycle' };
        const next = new Set(seen);
        next.add(binding);
        return staticExpression(binding.value, next);
      }
      if (v.name === 'script' || v.name === 'game') return { kind: v.name };
      return { kind: 'binding', name: v.name };
    }
    if (
      v.kind === 'call' &&
      v.method &&
      v.args[0]?.kind === 'string' &&
      ['GetService', 'FindFirstChild', 'WaitForChild'].includes(v.method)
    ) {
      return {
        kind:
          v.method === 'GetService'
            ? 'getService'
            : v.method === 'FindFirstChild'
              ? 'findFirstChild'
              : 'waitForChild',
        base: staticExpression(v.callee, seen),
        name: v.args[0].value,
        ...(v.args.length > 1 ? { recursive: true } : {}),
      };
    }
    return { kind: 'unknown', reason: v.kind === 'unknown' ? v.reason : 'non-instance-expression' };
  }

  function addReference(
    node: Node,
    context: Context,
    kind: string,
    name: string,
    nameRange: Range,
    receiver?: string,
    qualified?: string,
    extras: Record<string, Capture> = {},
  ): void {
    const range = rangeOf(node);
    const tag = `@reference.${kind}`;
    let referenceValue = value(node, context.scope.id);
    if (context.typeOnly && referenceValue.kind === 'call')
      referenceValue = referenceValue.method
        ? { kind: 'member', base: referenceValue.callee, name: referenceValue.method }
        : referenceValue.callee;
    references.push({ range, scope: context.scope.id, kind, value: referenceValue });
    captures.push({
      [tag]: capture(tag, range),
      '@reference.name': capture('@reference.name', nameRange, name),
      '@reference.caller-scope': capture(
        '@reference.caller-scope',
        range,
        context.callable?.scope ?? moduleScope.id,
      ),
      ...(receiver
        ? { '@reference.receiver': capture('@reference.receiver', nameRange, receiver) }
        : {}),
      ...(qualified
        ? {
            '@reference.qualified-name': capture('@reference.qualified-name', nameRange, qualified),
          }
        : {}),
      ...extras,
    });
  }

  function inspect(node: Node): void {
    const context = contextByNode.get(node.id)!;
    if (node.type === 'table') {
      const table = tables.find((candidate) => candidate.position === luauPosition(rangeOf(node)))!;
      for (const field of named(node, 'field')) {
        const initializer = value(field.childForFieldName('value'), context.scope.id);
        table.values.push(initializer);
        const key = keyName(field);
        if (!key) {
          // List entries use numeric keys, so they cannot overwrite a named
          // string field. Only an explicit unknown index can do that.
          if (field.childForFieldName('field_indexer')) table.incomplete = true;
          continue;
        }
        if (Object.hasOwn(table.fields, key.name)) {
          table.fields[key.name] = unknown('duplicate-field');
          table.incomplete = true;
          continue;
        }
        table.fields[key.name] = initializer;
        table.fieldPositions[key.name] = luauPosition(rangeOf(key.node));
      }
    }
    if (memberFunctionBase.has(node.id)) {
      const member = memberFunctionBase.get(node.id)!;
      const parts = member.base.split('.');
      let base: LuauValue = {
        kind: 'name',
        name: parts[0]!,
        scope: member.context.scope.id,
        at: rangeOf(node),
      };
      for (const part of parts.slice(1)) base = { kind: 'member', base, name: part };
      memberWrites.push({
        base,
        name: member.name.text,
        value: { kind: 'function', position: luauPosition(functionRange(node)) },
        at: rangeOf(node),
        scope: member.context.scope.id,
      });
      // A declaration-form member assignment evaluates its receiver in the
      // enclosing function, before the new method can ever be invoked.
      const root = node.childForFieldName('table_name');
      if (root) addReference(root, member.context, 'read', root.text, rangeOf(root));
    }
    const assignmentContext = functionAssignments.get(node.id);
    if (assignmentContext) {
      const name = node.childForFieldName('function_name')!;
      addReference(name, assignmentContext, 'write', name.text, rangeOf(name));
    }
    if (node.type === 'ret_stmt') {
      const expressions = named(node, 'explist')[0]?.namedChildren ?? [];
      const values = expressions.map((expression) => value(expression, context.scope.id));
      if (context.callable)
        (functionReturns[luauPosition(context.callable.range)] ??= []).push(...values);
      else returns.push(...values);
    }
    if (node.type === 'call_stmt') {
      const invoked = node.childForFieldName('invoked');
      const method = node.childForFieldName('method_name');
      const methodTable = node.childForFieldName('method_table');
      const args = named(node, 'arglist')[0]?.namedChildren ?? [];
      const calleeValue = value(invoked, context.scope.id);
      if (!context.typeOnly && parameterValue(calleeValue) && calleeValue.kind === 'name') {
        captures.push({
          '@callable-flow.invoke': capture('@callable-flow.invoke', rangeOf(node)),
          ...operand('callee', calleeValue.name, calleeValue.at),
          '@callable-flow.invocation-kind': capture(
            '@callable-flow.invocation-kind',
            rangeOf(node),
            'indirect',
          ),
          '@callable-flow.arity': capture(
            '@callable-flow.arity',
            rangeOf(node),
            String(args.length),
          ),
        });
      }
      args.forEach((argument, index) => {
        if (context.typeOnly) return;
        const argumentValue = value(argument, context.scope.id);
        if (argumentValue.kind !== 'name') return;
        const bound = localLookup(argumentValue.name, argumentValue.scope, argumentValue.at);
        if (!bound || !immutable(bound)) return;
        captures.push({
          '@callable-flow.argument': capture('@callable-flow.argument', rangeOf(node)),
          ...operand('source', argumentValue.name, argumentValue.at),
          '@callable-flow.parameter-index': capture(
            '@callable-flow.parameter-index',
            rangeOf(node),
            String(index),
          ),
        });
      });
      if (isRequire(node, context.scope.id)) {
        const argument = args[0];
        const expression = staticExpression(value(argument ?? null, context.scope.id));
        let initializer: Node = node;
        if (node.parent?.type === 'var') initializer = node.parent;
        const binding = bindingByInitializer.get(initializer.id);
        const keys = initializer.type === 'var' ? named(initializer, 'key') : [];
        const selector = keys.length === 1 ? keyName(keys[0]!)?.name : undefined;
        const dynamic = (expression as { kind: string }).kind === 'unknown';
        const importKind = dynamic
          ? 'dynamic-unresolved'
          : binding && keys.length === 0
            ? 'namespace'
            : binding && selector
              ? 'named'
              : 'side-effect';
        const range = rangeOf(node);
        captures.push({
          '@import.statement': capture('@import.statement', range),
          '@import.kind': capture('@import.kind', range, importKind),
          '@import.source': capture(
            '@import.source',
            argument ? rangeOf(argument) : range,
            dynamic ? (argument?.text ?? '') : JSON.stringify(expression),
          ),
          '@import.name': capture('@import.name', range, binding?.name ?? ''),
          ...(selector
            ? { '@import.imported-name': capture('@import.imported-name', range, selector) }
            : {}),
        });
        // Namespace/named imports bind their local directly; a redundant Variable would hide that binding.
        if (binding && (importKind === 'namespace' || importKind === 'named')) {
          const index = declarations.findIndex(
            (declaration) =>
              declaration.kind === 'Variable' &&
              declaration.bindingScope === binding.scope &&
              declaration.name === binding.name &&
              luauPosition(declaration.range) === luauPosition(binding.range),
          );
          if (index !== -1) declarations.splice(index, 1);
          const claim = scopeById
            .get(binding.scope)
            ?.claims.find(
              (candidate) => candidate.name === binding.name && candidate.range === binding.range,
            );
          if (claim) (claim as { kind: string }).kind = 'import';
        }
      }
      const callKind = (kind: string) => (context.typeOnly ? 'value-ref' : kind);
      if (method && methodTable)
        addReference(
          node,
          context,
          callKind('call.member'),
          method.text,
          rangeOf(method),
          methodTable.text,
        );
      else if (invoked?.type === 'var') {
        const keys = named(invoked, 'key');
        const lastKey = keys.at(-1);
        const rootName = invoked.childForFieldName('variable_name');
        if (lastKey) {
          const known = keyName(lastKey);
          const receiver = source.slice(invoked.startIndex, lastKey.startIndex);
          addReference(
            node,
            context,
            callKind(known ? 'call.member' : 'call.index'),
            known?.name ?? `[${lastKey.childForFieldName('field_indexer')?.text ?? '?'}]`,
            rangeOf(known?.node ?? lastKey),
            receiver,
          );
        } else if (rootName)
          addReference(node, context, callKind('call.free'), rootName.text, rangeOf(rootName));
        else addReference(node, context, callKind('call.index'), invoked.text, rangeOf(invoked));
      } else if (invoked)
        addReference(node, context, callKind('call.index'), invoked.text, rangeOf(invoked));
    }
    if (node.type === 'var') {
      const parent = node.parent;
      const isCallee =
        parent?.type === 'call_stmt' &&
        (parent.childForFieldName('invoked')?.id === node.id ||
          parent.childForFieldName('method_table')?.id === node.id);
      const root = node.childForFieldName('variable_name') ?? node.childForFieldName('table_name');
      const rootBinding = root && localLookup(root.text, context.scope.id, rangeOf(root));
      const keys = named(node, 'key');
      const valueBinder = rootBinding && rootBinding.declarationPosition === undefined;
      const callableValue =
        rootBinding?.value.kind === 'function' ||
        rootBinding?.value.kind === 'name' ||
        rootBinding?.parameter === true;
      const write =
        parent?.type === 'varlist' ||
        (parent?.type === 'var_stmt' && parent.childForFieldName('left')?.id === node.id);
      // `object.member` reads the object binding as well as its member. The
      // grammar exposes that root as a name field, not a nested `var` node.
      // Keep the original binder read even when its current value is mutable,
      // injected, a table, or a callable alias whose invocation targets another
      // declaration. A bare named-function call already links its declaration.
      if (root && (keys.length > 0 || (valueBinder && (isCallee || (!write && callableValue))))) {
        addReference(root, context, 'read', root.text, rangeOf(root));
      }
      if (!isCallee) {
        const last = keys.at(-1);
        const tail = last && keyName(last);
        const rootName = node.childForFieldName('variable_name');
        // Luau table fields are scoped to table identity. The generic registry
        // property-key channel is workspace-wide and would conflate unrelated
        // returned tables with the same key; the value remains an ordinary use.
        const extras: Record<string, Capture> = {};
        if (tail)
          addReference(
            node,
            context,
            write ? 'write' : 'read',
            tail.name,
            rangeOf(tail.node),
            source.slice(node.startIndex, last!.startIndex),
            undefined,
            extras,
          );
        else if (rootName) {
          addReference(
            node,
            context,
            write ? 'write' : callableValue ? 'value-ref' : 'read',
            rootName.text,
            rangeOf(rootName),
            undefined,
            undefined,
            extras,
          );
        }
      }
    }
    if (node.type === 'param' && context.callable && !context.callable.typeFunction) {
      const name = node.childForFieldName('parameter_name');
      const index = node.parent?.namedChildren.findIndex((child) => child.id === node.id) ?? -1;
      const binding = name && localLookup(name.text, context.scope.id, rangeOf(name));
      if (name && index >= 0 && binding && immutable(binding))
        captures.push({
          '@callable-flow.formal': capture('@callable-flow.formal', context.callable.range),
          '@callable-flow.owner': capture(
            '@callable-flow.owner',
            context.callable.range,
            context.callable.qualifiedName,
          ),
          ...operand('binding', name.text, rangeOf(name)),
          '@callable-flow.parameter-index': capture(
            '@callable-flow.parameter-index',
            rangeOf(node),
            String(index),
          ),
          '@callable-flow.passing-mode': capture(
            '@callable-flow.passing-mode',
            rangeOf(node),
            'value',
          ),
        });
    }
    if (node.type === 'namedtype') {
      const name = node.childForFieldName('type_name')!;
      const namespace = node.childForFieldName('module_namespace');
      addReference(
        node,
        context,
        'type',
        name.text,
        rangeOf(name),
        namespace?.text,
        namespace ? `${namespace.text}.${name.text}` : undefined,
        {
          '@reference.lookup-purpose': capture('@reference.lookup-purpose', rangeOf(name), 'type'),
        },
      );
    }
    for (const child of node.namedChildren) inspect(child);
  }
  for (const child of tree.rootNode.namedChildren) inspect(child);

  // Scope metadata is emitted last because assignment writes may add ordered name claims.
  for (const scope of scopes) {
    const tag = `@scope.${scope.kind.toLowerCase()}`;
    captures.push({
      [tag]: capture(tag, scope.range),
      '@scope.name-claims': capture(
        '@scope.name-claims',
        scope.range,
        JSON.stringify(scope.claims),
      ),
      '@scope.lookup-policy': capture(
        '@scope.lookup-policy',
        scope.range,
        JSON.stringify({
          allowImplicitReceiver: false,
          callerScopeIsAuthoritative: true,
          nameClaimsComplete: true,
        }),
      ),
    });
  }
  for (const declaration of declarations) {
    const tag = `@declaration.${declaration.kind.toLowerCase()}`;
    captures.push({
      [tag]: capture(tag, declaration.range),
      '@declaration.name': capture('@declaration.name', declaration.nameRange, declaration.name),
      '@declaration.qualified_name': capture(
        '@declaration.qualified_name',
        declaration.nameRange,
        declaration.qualifiedName,
      ),
      '@declaration.binding-name': capture(
        '@declaration.binding-name',
        declaration.range,
        declaration.bindingName,
      ),
      '@binding.scope': capture('@binding.scope', declaration.range, declaration.bindingScope),
      '@declaration.is-exported': capture(
        '@declaration.is-exported',
        declaration.range,
        String(declaration.isExported),
      ),
      ...(declaration.typeParameters?.length
        ? {
            '@declaration.type-parameters': capture(
              '@declaration.type-parameters',
              declaration.range,
              `<${declaration.typeParameters.map((name) => name.replace(/\.\.\.$/, '')).join(',')}>`,
            ),
          }
        : {}),
      ...(declaration.parameterNames
        ? {
            '@declaration.parameter-count': capture(
              '@declaration.parameter-count',
              declaration.range,
              String(declaration.parameterNames.filter((name) => name !== '...').length),
            ),
          }
        : {}),
      ...(declaration.parameterTypes
        ? {
            '@declaration.parameter-types': capture(
              '@declaration.parameter-types',
              declaration.range,
              JSON.stringify(declaration.parameterTypes),
            ),
          }
        : {}),
      ...(declaration.returnType
        ? {
            '@declaration.return-type': capture(
              '@declaration.return-type',
              declaration.range,
              declaration.returnType,
            ),
          }
        : {}),
      ...(declaration.declaredType
        ? {
            '@declaration.field-type': capture(
              '@declaration.field-type',
              declaration.range,
              declaration.declaredType,
            ),
          }
        : {}),
    });
    if (declaration.declaredType && declaration.bindingName)
      captures.push({
        '@type-binding.annotation': capture('@type-binding.annotation', declaration.range),
        '@type-binding.name': capture(
          '@type-binding.name',
          declaration.nameRange,
          declaration.bindingName,
        ),
        '@type-binding.type': capture(
          '@type-binding.type',
          declaration.range,
          declaration.declaredType,
        ),
        '@binding.scope': capture('@binding.scope', declaration.range, declaration.bindingScope),
      });
    if (declaration.returnType && declaration.bindingName)
      captures.push({
        '@type-binding.return': capture('@type-binding.return', declaration.range),
        '@type-binding.name': capture(
          '@type-binding.name',
          declaration.nameRange,
          declaration.bindingName,
        ),
        '@type-binding.type': capture(
          '@type-binding.type',
          declaration.range,
          declaration.returnType,
        ),
        '@binding.scope': capture('@binding.scope', declaration.range, declaration.bindingScope),
      });
  }
  const owners = declarations.flatMap((declaration) =>
    declaration.owner
      ? [
          {
            kind: declaration.kind,
            position: luauPosition(declaration.range),
            owner: declaration.owner,
          },
        ]
      : [],
  );
  return {
    captures,
    declarations,
    sideChannel: {
      version: 1,
      scopes,
      bindings,
      tables,
      memberWrites,
      returns,
      functionReturns,
      references,
      owners,
    },
  };
}

/** The cache is keyed by the immutable parsed tree, never just a filename. */
export function getLuauFacts(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): LuauFacts {
  const tree =
    (cachedTree as Parser.Tree | undefined) ??
    parseSourceSafe(
      getLuauParser(),
      sourceText,
      undefined,
      { bufferSize: getTreeSitterBufferSize(sourceText) },
      filePath,
    );
  let files = factsByTree.get(tree);
  if (files === undefined) {
    files = new Map();
    factsByTree.set(tree, files);
  }
  let facts = files.get(filePath);
  if (facts === undefined) {
    facts = collectFacts(tree, sourceText, filePath);
    files.set(filePath, facts);
  }
  return facts;
}

export function emitLuauScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  const facts = getLuauFacts(sourceText, filePath, cachedTree);
  pendingSideChannels.set(filePath, facts.sideChannel);
  return facts.captures;
}

/** Consume immediately after extraction so worker memory does not retain previous files. */
export function collectLuauCaptureSideChannel(filePath: string): LuauSideChannel | undefined {
  const facts = pendingSideChannels.get(filePath);
  pendingSideChannels.delete(filePath);
  return facts;
}
