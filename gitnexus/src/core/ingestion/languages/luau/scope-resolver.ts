import {
  SupportedLanguages,
  type BindingRef,
  type ParsedFile,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { luauProvider } from '../luau.js';
import {
  loadLuauResolutionConfig,
  resolveLuauModule,
  type LuauStaticExpression,
  type RojoModuleMap,
} from './module-resolution.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { tryEmitEdge } from '../../scope-resolution/graph-bridge/edges.js';
import { LuauValueResolver } from './value-resolution.js';
import { luauPosition, luauSideChannel } from './facts.js';

const workspacesByFile = new WeakMap<ParsedFile, LuauValueResolver>();
const workspacesByIndexes = new WeakMap<ScopeResolutionIndexes, LuauValueResolver>();

/** Module exports come from explicit type exports and the returned value only. */
export function luauModuleExports(file: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  return (workspacesByFile.get(file) ?? new LuauValueResolver([file])).moduleExports(file);
}

/** Native scope integration. Unproven dynamic values never use a global-name guess. */
export const luauScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Luau,
  languageProvider: luauProvider,
  importEdgeReason: 'luau-scope: static require',
  importsBindAtLexicalScope: true,
  ownedMembersBindAtModuleScope: false,
  namespaceExportsFromModuleExports: true,
  moduleExports: luauModuleExports,
  allowGlobalFreeCallFallback: false,
  fieldFallbackOnMethodLookup: false,
  loadResolutionConfig: loadLuauResolutionConfig,
  captureResolutionConfig: loadLuauResolutionConfig,
  refreshResolutionConfig: loadLuauResolutionConfig,
  resolveImportTarget: (targetRaw, fromFile, _allFilePaths, config, context) => {
    if (!config) return null;
    let expression: LuauStaticExpression;
    try {
      expression = JSON.parse(targetRaw) as LuauStaticExpression;
    } catch {
      return null;
    }
    const result = resolveLuauModule(config as RojoModuleMap, {
      fromFile,
      expression,
      range: context?.parsedImport?.atRange,
    });
    return result.status === 'resolved' ? result.filePath : null;
  },
  mergeBindings: (existing, incoming) => {
    const unique = new Map<string, BindingRef>();
    for (const binding of [...existing, ...incoming])
      if (!unique.has(binding.def.nodeId)) unique.set(binding.def.nodeId, binding);
    return [...unique.values()];
  },
  arityCompatibility: () => 'unknown',
  buildMro: () => new Map(),
  populateOwners: (parsed) => {
    const facts = luauSideChannel(parsed.captureSideChannel);
    if (!facts) return;
    const definitions = new Map(
      parsed.localDefs
        .filter((definition) => definition.declarationRange)
        .map((definition) => [
          `${definition.type}:${luauPosition(definition.declarationRange!)}`,
          definition,
        ]),
    );
    for (const fact of facts.owners ?? []) {
      const member = definitions.get(`${fact.kind}:${fact.position}`);
      const owner = definitions.get(`${fact.owner.kind}:${fact.owner.position}`);
      if (member && owner) member.ownerId = owner.nodeId;
    }
  },
  populateWorkspaceOwners: (files, context) => {
    const workspace = new LuauValueResolver(
      files,
      context.resolutionConfig as RojoModuleMap | undefined,
    );
    for (const file of files) workspacesByFile.set(file, workspace);
  },
  populateRangeBindings: (files, indexes) => {
    const workspace = files[0] && workspacesByFile.get(files[0]);
    if (workspace) workspacesByIndexes.set(indexes, workspace);
  },
  resolveUnqualifiedCall: (site, indexes) => {
    const target = workspacesByIndexes.get(indexes)?.target(site, indexes);
    return target?.definition
      ? { kind: 'resolved', definition: target.definition }
      : {
          kind: 'unknown',
          candidateIds: [],
          candidateSetComplete: false,
          detail: target?.reason ?? 'missing-workspace-facts',
        };
  },
  resolveQualifiedReceiverMember: (_receiver, _member, _scope, indexes, _files, site) => {
    if (!site || !('kind' in site)) return undefined;
    return workspacesByIndexes
      .get(indexes)
      ?.target(site as import('gitnexus-shared').ReferenceSite, indexes).definition;
  },
  emitPostResolutionEdges: (graph, files, lookup, indexes, context) => {
    const workspace = workspacesByIndexes.get(indexes);
    if (!workspace) return;
    const seen = new Set<string>();
    for (const file of files)
      for (const site of file.referenceSites) {
        const target = workspace.target(site, indexes);
        if (target.definition) {
          // Shared free calls collapse by caller/target. Use the same identity,
          // while referenceBindings below retains every exact source occurrence.
          tryEmitEdge(
            graph,
            indexes,
            lookup,
            site,
            target.definition,
            `luau-scope: ${site.kind}; ${target.reason}`,
            seen,
            1,
            site.kind === 'call' && site.explicitReceiver === undefined,
          );
          context.recordSourceBinding?.(site, {
            status: 'resolved',
            targetDefIds: [target.definition.nodeId],
            basis: `luau:${target.reason}`,
          });
        } else if (site.kind === 'call' || site.explicitReceiver) {
          context.recordSourceBinding?.(site, {
            status: 'unresolved',
            targetDefIds: [],
            basis: `luau:${target.reason}`,
          });
        }
      }
  },
  isSuperReceiver: () => false,
};
