import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { collectLuauCaptureSideChannel, emitLuauScopeCaptures } from './luau/captures.js';
import { interpretLuauImport, interpretLuauTypeBinding } from './luau/interpret.js';
import { extractLuauSemanticGraph } from './luau/semantic-graph.js';

/** Roblox Luau uses the native ingestion artifact and graph pipeline, including ordinary .lua project modules. */
export const luauProvider = defineLanguage({
  id: SupportedLanguages.Luau,
  extensions: ['.luau', '.lua'],
  incrementalResolutionGroup: () => 'workspace',
  incrementalResolutionContext: (filePath) =>
    filePath.replaceAll('\\', '/') === 'sourcemap.json' ? 'workspace' : undefined,
  resolutionContextFiles: ['sourcemap.json'],
  // A nonempty root query engages native workers. The semantic hook emits
  // exact positional declarations from the same AST facts as scope extraction.
  treeSitterQueries: '((chunk) @luau.root)',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => undefined,
    extractParameter: () => undefined,
  },
  exportChecker: () => false,
  emitScopeCaptures: emitLuauScopeCaptures,
  collectCaptureSideChannel: collectLuauCaptureSideChannel,
  extractSemanticGraph: extractLuauSemanticGraph,
  interpretImport: interpretLuauImport,
  interpretTypeBinding: interpretLuauTypeBinding,
  importsExecuteWhereWritten: true,
  importOwningScope: (_parsed, innermost) => innermost.id,
  bindingScopeFor: (captures) => captures['@binding.scope']?.text ?? null,
  receiverBinding: (scope) => scope.typeBindings.get('self') ?? null,
  // Arity cannot reject Luau calls: excess arguments are allowed and missing arguments become nil.
  arityCompatibility: () => 'unknown',
});
