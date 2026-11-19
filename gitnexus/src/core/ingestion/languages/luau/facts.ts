import type { CaptureMatch, NameClaim, NodeLabel, Range, ScopeKind } from 'gitnexus-shared';

/** Source evidence only: evaluating arbitrary Luau expressions is deliberately outside this model. */
export type LuauValue =
  | { readonly kind: 'name'; readonly name: string; readonly scope: string; readonly at: Range }
  | { readonly kind: 'function'; readonly position: string }
  | { readonly kind: 'table'; readonly position: string }
  | { readonly kind: 'member'; readonly base: LuauValue; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | {
      readonly kind: 'call';
      readonly callee: LuauValue;
      readonly args: readonly LuauValue[];
      readonly at: Range;
      readonly method?: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: string;
      /** Possible source values for effect invalidation only, never target resolution. */
      readonly possibleValues?: readonly LuauValue[];
    };

export interface LuauDeclaration {
  readonly name: string;
  readonly qualifiedName: string;
  readonly bindingName: string;
  readonly bindingScope: string;
  readonly scope: string;
  readonly kind: NodeLabel;
  readonly range: Range;
  readonly nameRange: Range;
  readonly parameterNames?: readonly string[];
  readonly parameterTypes?: readonly string[];
  readonly variadic?: boolean;
  readonly returnType?: string;
  readonly declaredType?: string;
  readonly typeParameters?: readonly string[];
  readonly typeFunction?: boolean;
  readonly owner?: { readonly kind: NodeLabel; readonly position: string };
  isExported: boolean;
  isDefaultExport?: boolean;
}

export interface LuauScopeFact {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly parent: string | null;
  readonly range: Range;
  readonly claims: NameClaim[];
}

export interface LuauBinding {
  readonly name: string;
  readonly scope: string;
  readonly range: Range;
  readonly availableFrom: { readonly startLine: number; readonly startCol: number };
  readonly value: LuauValue;
  readonly declarationPosition?: string;
  /** Original binder identity survives assignment writes. */
  readonly bindingPosition?: string;
  readonly writeScope?: string;
  readonly parameter?: boolean;
}

export interface LuauTableFact {
  readonly position: string;
  readonly scope: string;
  readonly fields: Record<string, LuauValue>;
  readonly fieldPositions: Record<string, string>;
  /** Includes positional/computed entries for conservative table escape reachability. */
  readonly values: LuauValue[];
  /** A computed key or a duplicate write means the table shape is not exhaustive. */
  incomplete: boolean;
}

export interface LuauReferenceFact {
  readonly range: Range;
  readonly scope: string;
  readonly kind: string;
  readonly value: LuauValue;
}

export interface LuauMemberWrite {
  readonly base: LuauValue;
  readonly name: string | null;
  readonly value: LuauValue;
  readonly at: Range;
  readonly scope: string;
}

/** JSON-safe facts travel with ParsedFile through worker messages and the parse cache. */
export interface LuauSideChannel {
  readonly version: 1;
  readonly scopes: readonly LuauScopeFact[];
  readonly bindings: readonly LuauBinding[];
  readonly tables: readonly LuauTableFact[];
  readonly memberWrites: readonly LuauMemberWrite[];
  readonly returns: readonly LuauValue[];
  readonly functionReturns: Readonly<Record<string, readonly LuauValue[]>>;
  readonly references: readonly LuauReferenceFact[];
  readonly owners: readonly {
    readonly kind: NodeLabel;
    readonly position: string;
    readonly owner: NonNullable<LuauDeclaration['owner']>;
  }[];
}

export interface LuauFacts {
  readonly captures: readonly CaptureMatch[];
  readonly declarations: readonly LuauDeclaration[];
  readonly sideChannel: LuauSideChannel;
}

export function luauPosition(range: Range): string {
  return `${range.startLine}:${range.startCol}`;
}

export function luauSideChannel(value: unknown): LuauSideChannel | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<LuauSideChannel>;
  return candidate.version === 1 &&
    Array.isArray(candidate.scopes) &&
    Array.isArray(candidate.bindings) &&
    Array.isArray(candidate.tables) &&
    Array.isArray(candidate.memberWrites) &&
    Array.isArray(candidate.returns)
    ? (candidate as LuauSideChannel)
    : undefined;
}
