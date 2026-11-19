import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import type {
  ProviderSemanticGraph,
  ProviderSemanticNode,
  ProviderSemanticRelationship,
  ProviderSemanticSymbol,
} from '../../language-provider.js';
import { getLuauFacts } from './captures.js';
import { luauPosition, type LuauDeclaration } from './facts.js';

/** Names are display metadata; coordinates distinguish shadowed and anonymous declarations. */
export function luauGraphNodeId(filePath: string, declaration: LuauDeclaration): string {
  return generateId(
    declaration.kind,
    `${filePath}:${declaration.qualifiedName}@${luauPosition(declaration.range)}`,
  );
}

export function extractLuauSemanticGraph(
  tree: Parser.Tree,
  filePath: string,
  sourceText: string,
): ProviderSemanticGraph {
  const facts = getLuauFacts(sourceText, filePath, tree);
  const nodes: ProviderSemanticNode[] = [];
  const relationships: ProviderSemanticRelationship[] = [];
  const symbols: ProviderSemanticSymbol[] = [];
  const fileId = generateId('File', filePath);
  const declarationsByPosition = new Map(
    facts.declarations.map((declaration) => [
      `${declaration.kind}:${luauPosition(declaration.range)}`,
      declaration,
    ]),
  );
  const scopesById = new Map(facts.sideChannel.scopes.map((scope) => [scope.id, scope]));
  const callablesByScope = new Map(
    facts.declarations
      .filter((declaration) => declaration.kind === 'Function' || declaration.kind === 'Method')
      .map((declaration) => [declaration.scope, declaration]),
  );
  const lineOffsets = [0];
  for (let index = 0; index < sourceText.length; index++)
    if (sourceText[index] === '\n') lineOffsets.push(index + 1);
  for (const declaration of facts.declarations) {
    const id = luauGraphNodeId(filePath, declaration);
    const range = declaration.range;
    const content = sourceText.slice(
      (lineOffsets[range.startLine - 1] ?? 0) + range.startCol,
      (lineOffsets[range.endLine - 1] ?? sourceText.length) + range.endCol,
    );
    const parameterCount = declaration.parameterNames?.filter((name) => name !== '...').length;
    nodes.push({
      id,
      label: declaration.kind,
      properties: {
        name: declaration.name,
        qualifiedName: declaration.qualifiedName,
        filePath,
        startLine: range.startLine - 1,
        startColumn: range.startCol,
        endLine: range.endLine - 1,
        endColumn: range.endCol,
        language: SupportedLanguages.Luau,
        isExported: declaration.isExported,
        content,
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(declaration.parameterTypes ? { parameterTypes: declaration.parameterTypes } : {}),
        ...(declaration.returnType ? { returnType: declaration.returnType } : {}),
        ...(declaration.declaredType ? { declaredType: declaration.declaredType } : {}),
        ...(declaration.typeParameters?.length
          ? { typeParameters: declaration.typeParameters }
          : {}),
        ...(declaration.typeFunction ? { luauExecutionKind: 'type-function' } : {}),
        ...(declaration.isDefaultExport ? { isDefaultExport: true } : {}),
        ...(declaration.bindingName === '' &&
        (declaration.kind === 'Function' || declaration.kind === 'Method')
          ? { isUnboundCallable: true }
          : {}),
      },
    });
    relationships.push({
      id: generateId('DEFINES', `${fileId}->${id}`),
      sourceId: fileId,
      targetId: id,
      type: 'DEFINES',
      confidence: 1,
      reason: 'luau-syntax: declaration',
    });
    // Preserve lexical containment without representing closure factories as
    // classes. Parameters, nested functions and local state belong to the
    // nearest actual function body, independently of table/type membership.
    let lexicalScope = scopesById.get(declaration.scope);
    if (callablesByScope.get(declaration.scope) === declaration)
      lexicalScope = lexicalScope?.parent ? scopesById.get(lexicalScope.parent) : undefined;
    while (lexicalScope && lexicalScope.kind !== 'Function')
      lexicalScope = lexicalScope.parent ? scopesById.get(lexicalScope.parent) : undefined;
    const lexicalOwner = lexicalScope && callablesByScope.get(lexicalScope.id);
    if (lexicalOwner && declaration.kind !== 'Property') {
      const sourceId = luauGraphNodeId(filePath, lexicalOwner);
      relationships.push({
        id: generateId('DEFINES', `${sourceId}->${id}`),
        sourceId,
        targetId: id,
        type: 'DEFINES',
        confidence: 1,
        reason: 'luau-syntax: lexical declaration',
      });
    }
    const owner =
      declaration.owner &&
      declarationsByPosition.get(`${declaration.owner.kind}:${declaration.owner.position}`);
    if (owner && (declaration.kind === 'Method' || declaration.kind === 'Property')) {
      const sourceId = luauGraphNodeId(filePath, owner);
      const type = declaration.kind === 'Method' ? 'HAS_METHOD' : 'HAS_PROPERTY';
      relationships.push({
        id: generateId(type, `${sourceId}->${id}`),
        sourceId,
        targetId: id,
        type,
        confidence: 1,
        reason: 'luau-syntax: structural member',
      });
    }
    symbols.push({
      filePath,
      name: declaration.name,
      qualifiedName: declaration.qualifiedName,
      nodeId: id,
      type: declaration.kind,
      ...(parameterCount !== undefined ? { parameterCount } : {}),
      ...(declaration.parameterTypes ? { parameterTypes: declaration.parameterTypes } : {}),
      ...(declaration.returnType ? { returnType: declaration.returnType } : {}),
      ...(declaration.declaredType ? { declaredType: declaration.declaredType } : {}),
    });
  }
  return { nodes, relationships, symbols };
}
