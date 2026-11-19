import type { CaptureMatch, ParsedImport, ParsedTypeBinding } from 'gitnexus-shared';

/** Requires execute at their lexical site; no wildcard publication is implied. */
export function interpretLuauImport(captures: CaptureMatch): ParsedImport | null {
  const kind = captures['@import.kind']?.text;
  const targetRaw = captures['@import.source']?.text;
  const localName = captures['@import.name']?.text ?? '';
  if (targetRaw === undefined) return null;
  switch (kind) {
    case 'namespace':
      return { kind, localName, importedName: localName, targetRaw, bindsAtLexicalScope: true };
    case 'named': {
      const importedName = captures['@import.imported-name']?.text;
      return importedName === undefined
        ? null
        : { kind, localName, importedName, targetRaw, bindsAtLexicalScope: true };
    }
    case 'side-effect':
      return { kind, targetRaw };
    case 'dynamic-unresolved':
      return { kind, localName, targetRaw };
    default:
      return null;
  }
}

export function interpretLuauTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const boundName = captures['@type-binding.name']?.text;
  const rawTypeName = captures['@type-binding.type']?.text;
  if (boundName === undefined || rawTypeName === undefined) return null;
  return {
    boundName,
    rawTypeName,
    source: captures['@type-binding.return'] ? 'return-annotation' : 'annotation',
  };
}
