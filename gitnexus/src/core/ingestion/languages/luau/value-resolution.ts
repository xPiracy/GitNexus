import type { ParsedFile, Range, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  luauPosition,
  luauSideChannel,
  type LuauBinding,
  type LuauMemberWrite,
  type LuauReferenceFact,
  type LuauSideChannel,
  type LuauValue,
} from './facts.js';
import {
  resolveLuauModule,
  type LuauStaticExpression,
  type RojoModuleMap,
} from './module-resolution.js';

type Located = { readonly file: string; readonly position: string };
type LuauCall = Extract<LuauValue, { kind: 'call' }>;
interface EvaluationBudget {
  left: number;
  /** Compare allocation origins without recursively validating metatables. */
  readonly metatableOriginOnly?: boolean;
  /** The once-per-workspace effect pass compares identities before applying its result. */
  readonly ignoreTableEscapes?: boolean;
  readonly ignoreForeignWrites?: boolean;
  /** Mutable table identities used to derive a candidate purity proof. */
  readonly purityDependencies?: Set<string>;
}
type Resolved =
  | ({ readonly kind: 'function' | 'field' } & Located)
  | ({
      readonly kind: 'table';
      readonly metatable?: Resolved;
      readonly instance?: string;
      readonly frozen?: boolean;
    } & Located)
  | { readonly kind: 'unknown'; readonly reason: string };

interface FileFacts {
  readonly parsed: ParsedFile;
  readonly facts: LuauSideChannel;
  readonly scopes: ReadonlyMap<string, LuauSideChannel['scopes'][number]>;
  readonly bindings: ReadonlyMap<string, ReadonlyMap<string, readonly LuauBinding[]>>;
  /** Coordinate-to-ID join only; SymbolDefinition stays in the shared store. */
  readonly definitions: ReadonlyMap<string, string>;
  readonly tables: ReadonlyMap<string, LuauSideChannel['tables'][number]>;
  readonly references: ReadonlyMap<string, LuauReferenceFact>;
}

interface TargetResult {
  readonly definition?: SymbolDefinition;
  readonly reason: string;
}

interface PotentialOrigins {
  readonly file: string;
  readonly origins: readonly string[];
  readonly opaque: boolean;
  /** Empty lists also matter: a later store may expose a new reachable table. */
  readonly storedLengths: ReadonlyMap<string, number>;
  validatedAfterWrites: boolean;
}

const unknown = (reason: string): Resolved => ({ kind: 'unknown', reason });
const UNKNOWN_TABLE_ORIGIN = '@unknown-table-origin';
// Retaining every transitive origin set can be quadratic in workspace size.
// Eviction only repeats a conservative walk; it never changes its result.
const MAX_ORIGIN_CACHE_ENTRIES = 4096;
const MAX_CACHED_ORIGIN_FACTS = 65_536;
const before = (
  a: { startLine: number; startCol: number },
  b: { startLine: number; startCol: number },
): boolean =>
  a.startLine < b.startLine || (a.startLine === b.startLine && a.startCol <= b.startCol);
const key = (range: Range, kind: string): string =>
  `${luauPosition(range)}-${range.endLine}:${range.endCol}:${kind.startsWith('call.') ? 'call' : kind === 'type' ? 'type-reference' : kind}`;
const sameRange = (a: Range, b: Range): boolean =>
  a.startLine === b.startLine &&
  a.startCol === b.startCol &&
  a.endLine === b.endLine &&
  a.endCol === b.endCol;
const same = (a: Resolved, b: Resolved): boolean =>
  a.kind === b.kind &&
  a.kind !== 'unknown' &&
  b.kind !== 'unknown' &&
  a.file === b.file &&
  a.position === b.position &&
  (a.kind !== 'table' || b.kind !== 'table' || a.instance === b.instance);

/**
 * Evaluate only parser-proven value identities. This is deliberately not an
 * interpreter: control-dependent writes, injected arguments, dynamic keys and
 * cycles stay unknown. Each analysis owns its facts; no process-global filename
 * cache can leak values across workspaces or incremental runs.
 */
export class LuauValueResolver {
  private readonly files = new Map<string, FileFacts>();
  private readonly fileForScope = new Map<string, string>();
  private readonly exports = new Map<string, ReadonlyMap<string, SymbolDefinition>>();
  private readonly writesByFile = new Map<
    string,
    ReadonlyMap<string | null, readonly LuauMemberWrite[]>
  >();
  private readonly metatableCalls = new Map<string, readonly LuauCall[]>();
  private readonly foreignMetatableCalls: { file: string; call: LuauCall }[] = [];
  private escapedTables: Map<string, string> | undefined;
  private readonly readOnlyFunctions = new Map<string, ReadonlySet<string> | null>();
  private foreignWriteTargets: Map<string, Set<string | null>> | undefined;
  private writeTargetsReady = false;
  private readonly potentialOriginsCache = new Map<LuauValue | string, PotentialOrigins>();
  private cachedOriginFactCount = 0;
  private readonly localWriteTargets = new Map<string, LuauMemberWrite[]>();
  private readonly uncertainWriteReceivers: {
    file: string;
    value: LuauValue;
    exhausted: boolean;
  }[] = [];
  private readonly storedTableValues = new Map<string, { file: string; value: LuauValue }[]>();
  private readonly unknownStorageValues: { file: string; value: LuauValue }[] = [];
  private readonly reachableTables = new Map<string, readonly string[]>();
  private readonly limitOrigins = new Set<string>();
  private readonly targets = new WeakMap<
    ScopeResolutionIndexes,
    WeakMap<ReferenceSite, TargetResult>
  >();

  constructor(
    parsedFiles: readonly ParsedFile[],
    private readonly config?: RojoModuleMap,
  ) {
    for (const parsed of parsedFiles) {
      const facts = luauSideChannel(parsed.captureSideChannel);
      if (!facts) continue;
      const bindings = new Map<string, Map<string, LuauBinding[]>>();
      for (const binding of facts.bindings) {
        let names = bindings.get(binding.scope);
        if (!names) {
          names = new Map();
          bindings.set(binding.scope, names);
        }
        const entries = names.get(binding.name) ?? [];
        entries.push(binding);
        names.set(binding.name, entries);
      }
      const definitions = new Map<string, string>();
      for (const definition of parsed.localDefs) {
        if (definition.declarationRange)
          definitions.set(
            `${definition.type}:${luauPosition(definition.declarationRange)}`,
            definition.nodeId,
          );
      }
      this.files.set(parsed.filePath, {
        parsed,
        facts,
        bindings,
        definitions,
        scopes: new Map(facts.scopes.map((scope) => [scope.id, scope])),
        tables: new Map(facts.tables.map((table) => [table.position, table])),
        references: new Map(
          (facts.references ?? []).map((reference) => [
            key(reference.range, reference.kind),
            reference,
          ]),
        ),
      });
      for (const scope of facts.scopes) this.fileForScope.set(scope.id, parsed.filePath);
    }
    // Member spelling narrows candidates; receiver identity still decides
    // every match. Most writes have a local table root and cannot mutate an
    // imported allocation, so do not revisit them across workspace files.
    for (const [path, file] of this.files) {
      const local = new Map<string | null, LuauMemberWrite[]>();
      for (const write of file.facts.memberWrites) {
        const entries = local.get(write.name) ?? [];
        entries.push(write);
        local.set(write.name, entries);
      }
      this.writesByFile.set(path, local);
      const metatables: LuauCall[] = [];
      for (const reference of file.facts.references) {
        const call = reference.value;
        if (
          reference.kind.startsWith('call.') &&
          call.kind === 'call' &&
          this.isSetMetatable(file, call)
        ) {
          metatables.push(call);
          if (call.args[0] && this.mayReferenceForeignTable(file, call.args[0]))
            this.foreignMetatableCalls.push({ file: path, call });
        }
      }
      this.metatableCalls.set(path, metatables);
    }
  }

  private isSetMetatable(file: FileFacts, call: LuauCall): boolean {
    return (
      call.callee.kind === 'name' &&
      call.callee.name === 'setmetatable' &&
      !this.binding(file, call.callee.name, call.callee.scope, call.callee.at)
    );
  }

  private tableIdentity(value: Extract<Resolved, { kind: 'table' }>): string {
    return JSON.stringify([value.file, value.position, value.instance ?? null]);
  }

  private tableOrigin(value: Located): string {
    return `@origin:${JSON.stringify([value.file, value.position])}`;
  }

  /** Equivalent inputs to origin tracing only; never used to resolve a target. */
  private potentialOriginKey(path: string, root: LuauValue): LuauValue | string {
    let value = root;
    // The provenance walk follows a member's base regardless of field spelling.
    while (value.kind === 'member') value = value.base;
    if (value.kind === 'table' || value.kind === 'function')
      return JSON.stringify([path, value.kind, value.position]);
    if (value.kind === 'name') {
      const file = this.files.get(path);
      const binding = file && this.binding(file, value.name, value.scope, value.at);
      if (binding)
        // Select the lexical binder first. Its complete candidate group is
        // identical across occurrences, including writes that share its ID.
        // The explicit opaque seed preserves the parameter branch of tracing.
        return JSON.stringify([
          path,
          'binding',
          binding.scope,
          binding.name,
          binding.bindingPosition ?? null,
          Boolean(binding.parameter && binding.value.kind === 'unknown'),
        ]);
    }
    // Calls and compound unknowns keep occurrence identity; their children
    // and evaluation context have not been proven equivalent here.
    return value;
  }

  /**
   * A limit is not evidence of no effect. This nonrecursive graph walk only
   * collects possible source allocations; it never supplies a call target or
   * a purity exemption. Visited source values bound cycles and long chains.
   * An opaque frontier fails closed explicitly instead of silently dropping
   * the effect. Allocation origins cover all factory instances at that site.
   */
  private potentialTableOrigins(
    path: string,
    root: LuauValue,
    exhausted = true,
  ): readonly string[] {
    // Receiver indexing appends stored values. A complete walk can be reused
    // while that index grows only when every visited table's list is unchanged.
    // This avoids invalidating a large walk for an unrelated receiver's store.
    // After indexing, all those facts are immutable; escape/purity propagation
    // is deliberately excluded from the walk and cannot invalidate it.
    const cacheKey = this.potentialOriginKey(path, root);
    let result = this.potentialOriginsCache.get(cacheKey);
    if (
      result?.file !== path ||
      (!result.validatedAfterWrites &&
        [...result.storedLengths].some(
          ([identity, length]) => (this.storedTableValues.get(identity)?.length ?? 0) !== length,
        ))
    )
      result = undefined;
    if (result) {
      result.validatedAfterWrites = this.writeTargetsReady;
      this.potentialOriginsCache.delete(cacheKey);
      this.potentialOriginsCache.set(cacheKey, result);
    } else {
      result = this.traceTableOrigins(path, root);
      const prior = this.potentialOriginsCache.get(cacheKey);
      if (prior) {
        this.cachedOriginFactCount -= prior.origins.length + prior.storedLengths.size;
        this.potentialOriginsCache.delete(cacheKey);
      }
      const factCount = result.origins.length + result.storedLengths.size;
      if (factCount <= MAX_CACHED_ORIGIN_FACTS) {
        while (
          this.potentialOriginsCache.size >= MAX_ORIGIN_CACHE_ENTRIES ||
          this.cachedOriginFactCount + factCount > MAX_CACHED_ORIGIN_FACTS
        ) {
          const oldest = this.potentialOriginsCache.entries().next().value;
          if (!oldest) break;
          this.potentialOriginsCache.delete(oldest[0]);
          this.cachedOriginFactCount -= oldest[1].origins.length + oldest[1].storedLengths.size;
        }
        this.potentialOriginsCache.set(cacheKey, result);
        this.cachedOriginFactCount += factCount;
      }
    }
    // Exhaustion belongs to the requesting effect, not the immutable source
    // walk. A prior non-exhausted query must not hide an opaque frontier.
    const origins =
      result.opaque && exhausted ? [...result.origins, UNKNOWN_TABLE_ORIGIN] : result.origins;
    if (exhausted) for (const origin of origins) this.limitOrigins.add(origin);
    return origins;
  }

  private traceTableOrigins(path: string, root: LuauValue): PotentialOrigins {
    const pending = [{ file: path, value: root }];
    const seen = new Map<string, Set<LuauValue>>();
    const origins = new Set<string>();
    const storedLengths = new Map<string, number>();
    let opaque = false;
    for (let index = 0; index < pending.length; index++) {
      const entry = pending[index]!;
      const file = this.files.get(entry.file);
      if (!file) {
        opaque = true;
        continue;
      }
      const visited = seen.get(entry.file) ?? new Set<LuauValue>();
      if (visited.has(entry.value)) continue;
      visited.add(entry.value);
      seen.set(entry.file, visited);
      const enqueue = (value: LuauValue): void => {
        pending.push({ file: entry.file, value });
      };
      const value = entry.value;
      if (value.kind === 'name') {
        const binding = this.binding(file, value.name, value.scope, value.at);
        if (!binding) {
          opaque = true;
          continue;
        }
        if (binding.parameter && binding.value.kind === 'unknown') opaque = true;
        for (const candidate of file.bindings.get(binding.scope)?.get(binding.name) ?? [])
          if (candidate.bindingPosition === binding.bindingPosition) enqueue(candidate.value);
      } else if (value.kind === 'function') {
        for (const returned of file.facts.functionReturns[value.position] ?? []) enqueue(returned);
      } else if (value.kind === 'table') {
        origins.add(this.tableOrigin({ file: entry.file, position: value.position }));
        const table = file.tables.get(value.position);
        for (const child of table?.values ?? Object.values(table?.fields ?? {})) enqueue(child);
        const identity = this.tableIdentity({
          kind: 'table',
          file: entry.file,
          position: value.position,
        });
        const storedValues = this.storedTableValues.get(identity) ?? [];
        storedLengths.set(identity, storedValues.length);
        for (const stored of storedValues) pending.push(stored);
      } else if (value.kind === 'member') {
        enqueue(value.base);
      } else if (value.kind === 'call') {
        const imported = file.parsed.parsedImports.find(
          (item) => item.atRange && sameRange(item.atRange, value.at),
        );
        if (imported && this.config) {
          try {
            const target = resolveLuauModule(this.config, {
              fromFile: entry.file,
              expression: JSON.parse(imported.targetRaw) as LuauStaticExpression,
            });
            if (target.status !== 'resolved') opaque = true;
            else
              for (const returned of this.files.get(target.filePath)?.facts.returns ?? [])
                pending.push({ file: target.filePath, value: returned });
          } catch {
            opaque = true;
          }
        } else if (this.nonMutatingBuiltin(file, value) || this.isSetMetatable(file, value)) {
          for (const argument of value.args) enqueue(argument);
        } else {
          const budget: EvaluationBudget = {
            left: 512,
            ignoreTableEscapes: true,
            ignoreForeignWrites: true,
            // Origin tracing must not recursively validate the metatable
            // mutations whose possible receivers this walk is finding.
            metatableOriginOnly: true,
          };
          let callee = this.evaluate(entry.file, value.callee, new Set(), budget);
          if (value.method) callee = this.member(callee, value.method, new Set(), budget);
          if (callee.kind === 'function') {
            for (const returned of this.files.get(callee.file)?.facts.functionReturns[
              callee.position
            ] ?? [])
              pending.push({ file: callee.file, value: returned });
          } else {
            // An unresolved callable can return an input. Do not conflate a
            // resolved method's receiver with the value that method returns.
            for (const argument of value.args) enqueue(argument);
            enqueue(value.callee);
          }
        }
      } else if (value.kind === 'unknown' && value.possibleValues) {
        for (const possible of value.possibleValues) enqueue(possible);
      } else if (
        value.kind === 'unknown' &&
        !['nil', 'true', 'false', 'number', 'missing-expression'].includes(value.reason)
      ) {
        opaque = true;
      }
    }
    return {
      file: path,
      origins: [...origins],
      opaque,
      storedLengths,
      validatedAfterWrites: this.writeTargetsReady,
    };
  }

  /** Nonmutating builtins; table.freeze's returned identity is modeled explicitly. */
  private nonMutatingBuiltin(file: FileFacts, call: LuauCall): boolean {
    const callee = call.callee;
    if (callee.kind === 'name')
      return (
        ['type', 'typeof', 'rawequal', 'rawlen'].includes(callee.name) &&
        !this.binding(file, callee.name, callee.scope, callee.at)
      );
    return (
      callee.kind === 'member' &&
      ['freeze', 'isfrozen'].includes(callee.name) &&
      callee.base.kind === 'name' &&
      callee.base.name === 'table' &&
      !this.binding(file, 'table', callee.base.scope, callee.base.at)
    );
  }

  /**
   * A small proof of no mutation/escape, not a guess from a function's name.
   * Unknown calls, writes, and returned containers/callables fail this proof.
   */
  private readOnlyFunction(callee: Resolved): ReadonlySet<string> | undefined {
    if (callee.kind !== 'function') return undefined;
    const key = `${callee.file}:${callee.position}`;
    const prior = this.readOnlyFunctions.get(key);
    if (prior !== undefined) return prior ?? undefined;
    this.readOnlyFunctions.set(key, null);
    const dependencies = new Set<string>();
    const file = this.files.get(callee.file)!;
    const scope = file.facts.scopes.find(
      (candidate) =>
        candidate.kind === 'Function' && luauPosition(candidate.range) === callee.position,
    );
    if (!scope) return undefined;
    if (file.facts.memberWrites.some((write) => this.functionScope(file, write.scope) === scope.id))
      return undefined;
    for (const reference of file.facts.references) {
      if (this.functionScope(file, reference.scope) !== scope.id) continue;
      if (reference.kind === 'write') return undefined;
      if (reference.kind.startsWith('call.')) {
        const call = reference.value;
        if (call.kind !== 'call') return undefined;
        if (this.nonMutatingBuiltin(file, call)) continue;
        const budget: EvaluationBudget = {
          left: 512,
          ignoreTableEscapes: true,
          purityDependencies: dependencies,
        };
        let target = this.evaluate(callee.file, call.callee, new Set(), budget);
        if (call.method) target = this.member(target, call.method, new Set(), budget);
        const nested = this.readOnlyFunction(target);
        if (!nested) return undefined;
        for (const dependency of nested) dependencies.add(dependency);
      }
    }
    for (const returned of file.facts.functionReturns[callee.position] ?? [])
      if (
        returned.kind !== 'string' &&
        !(
          returned.kind === 'unknown' &&
          ['nil', 'true', 'false', 'number'].includes(returned.reason)
        )
      )
        return undefined;
    this.readOnlyFunctions.set(key, dependencies);
    return dependencies;
  }

  private mayBeTableArgument(
    file: FileFacts,
    value: LuauValue,
    seen = new Set<LuauBinding>(),
  ): boolean {
    if (value.kind === 'table' || value.kind === 'member' || value.kind === 'call') return true;
    if (value.kind === 'unknown')
      return (
        value.possibleValues?.some((possible) => this.mayBeTableArgument(file, possible, seen)) ??
        false
      );
    if (value.kind !== 'name') return false;
    const binding = this.binding(file, value.name, value.scope, value.at);
    if (!binding || seen.has(binding)) return false;
    seen.add(binding);
    return this.mayBeTableArgument(file, binding.value, seen);
  }

  private collectTableEscapes(): ReadonlyMap<string, string> {
    if (this.escapedTables) return this.escapedTables;
    const escaped = new Map<string, string>();
    this.escapedTables = escaped;
    this.collectForeignWriteTargets();
    const effects: { targets: readonly string[]; dependencies?: ReadonlySet<string> }[] = [];
    // Inspect each call once. Repeating this workspace scan per member would
    // turn common shared module tables into a quadratic resolution cost.
    for (const [path, file] of this.files)
      for (const reference of file.facts.references) {
        const call = reference.value;
        if (
          !reference.kind.startsWith('call.') ||
          call.kind !== 'call' ||
          this.nonMutatingBuiltin(file, call) ||
          this.isSetMetatable(file, call)
        )
          continue;
        const argumentsToCheck = call.args.filter((argument) =>
          this.mayBeTableArgument(file, argument),
        );
        // Colon calls also pass their receiver as the first argument.
        if (call.method && this.mayBeTableArgument(file, call.callee))
          argumentsToCheck.unshift(call.callee);
        if (argumentsToCheck.length === 0) continue;
        const dependencies = new Set<string>();
        const budget: EvaluationBudget = {
          left: 512,
          ignoreTableEscapes: true,
          purityDependencies: dependencies,
        };
        let callee = this.evaluate(path, call.callee, new Set(), budget);
        if (call.method) callee = this.member(callee, call.method, new Set(), budget);
        const proof = this.readOnlyFunction(callee);
        if (proof) for (const dependency of proof) dependencies.add(dependency);
        const targets: string[] = [];
        for (const argument of argumentsToCheck) {
          const argumentBudget: EvaluationBudget = {
            left: 512,
            ignoreTableEscapes: true,
          };
          const table = this.evaluate(path, argument, new Set(), argumentBudget);
          // A proven frozen value cannot be mutated by its consumer. An
          // earlier escape of its unfrozen allocation remains in this pass.
          if (table.kind === 'table') targets.push(...this.escapableTables(table));
          else if (table.kind === 'unknown')
            targets.push(...this.potentialTableOrigins(path, argument, argumentBudget.left < 0));
        }
        if (targets.length) effects.push({ targets, ...(proof ? { dependencies } : {}) });
      }
    // Storing a table in an unknown receiver exposes it independently of any
    // call we can resolve (for example, a host-owned global registry).
    for (const stored of this.unknownStorageValues) {
      const budget: EvaluationBudget = {
        left: 512,
        ignoreTableEscapes: true,
      };
      const table = this.evaluate(stored.file, stored.value, new Set(), budget);
      if (table.kind === 'table') effects.push({ targets: this.escapableTables(table) });
      else if (table.kind === 'unknown')
        effects.push({
          targets: this.potentialTableOrigins(stored.file, stored.value, budget.left < 0),
        });
    }
    for (const receiver of this.uncertainWriteReceivers)
      effects.push({
        targets: this.potentialTableOrigins(receiver.file, receiver.value, receiver.exhausted),
      });
    // Purity is conditional on every table used to identify its callees.
    // Propagate invalidation before granting exemptions. Each allocation is
    // queued once; a long wrapper chain does not rescan every workspace call.
    const dependents = new Map<string, (readonly string[])[]>();
    const pending: string[] = [];
    const invalidate = (targets: readonly string[]): void => {
      for (const target of targets)
        if (!escaped.has(target)) {
          escaped.set(
            target,
            target === UNKNOWN_TABLE_ORIGIN
              ? 'table-effect-limit-unknown-origin'
              : this.limitOrigins.has(target)
                ? 'table-effect-resolution-limit'
                : target.startsWith('@')
                  ? 'table-escaped-through-uncertain-value'
                  : 'table-escaped-to-unproven-call',
          );
          pending.push(target);
        }
    };
    for (const effect of effects) {
      if (!effect.dependencies) invalidate(effect.targets);
      else
        for (const dependency of effect.dependencies) {
          const targets = dependents.get(dependency) ?? [];
          targets.push(effect.targets);
          dependents.set(dependency, targets);
        }
    }
    for (let index = 0; index < pending.length; index++)
      for (const targets of dependents.get(pending[index]!) ?? []) invalidate(targets);
    return escaped;
  }

  private collectForeignWriteTargets(): ReadonlyMap<string, ReadonlySet<string | null>> {
    if (this.foreignWriteTargets) return this.foreignWriteTargets;
    const targets = new Map<string, Set<string | null>>();
    this.foreignWriteTargets = targets;
    // Resolve each possible receiver once with its own budget. Hundreds of
    // unrelated computed writes must not consume one member site's budget.
    for (const [path, file] of this.files)
      for (const write of file.facts.memberWrites) {
        const budget: EvaluationBudget = {
          left: 512,
          ignoreTableEscapes: true,
          ignoreForeignWrites: true,
        };
        const receiver = this.evaluate(path, write.base, new Set(), budget);
        if (receiver.kind !== 'table') {
          if (receiver.kind === 'unknown' && this.mayBeTableArgument(file, write.base))
            this.uncertainWriteReceivers.push({
              file: path,
              value: write.base,
              exhausted: budget.left < 0,
            });
          if (this.mayBeTableArgument(file, write.value))
            this.unknownStorageValues.push({ file: path, value: write.value });
          continue;
        }
        if (receiver.frozen) continue;
        const identity = this.tableIdentity(receiver);
        const values = this.storedTableValues.get(identity) ?? [];
        values.push({ file: path, value: write.value });
        this.storedTableValues.set(identity, values);
        if (receiver.file === path) {
          const local = this.localWriteTargets.get(identity) ?? [];
          local.push(write);
          this.localWriteTargets.set(identity, local);
          continue;
        }
        const names = targets.get(identity) ?? new Set<string | null>();
        names.add(write.name);
        targets.set(identity, names);
      }
    this.writeTargetsReady = true;
    return targets;
  }

  /** Frozen containers still expose their mutable children and metatables. */
  private escapableTables(root: Extract<Resolved, { kind: 'table' }>): readonly string[] {
    const visitKey = (table: Extract<Resolved, { kind: 'table' }>): string =>
      JSON.stringify([
        this.tableIdentity(table),
        table.frozen ?? false,
        table.metatable?.kind === 'table' ? this.tableIdentity(table.metatable) : null,
      ]);
    const rootKey = visitKey(root);
    const cached = this.reachableTables.get(rootKey);
    if (cached) return cached;
    const pending = [root];
    const seen = new Set<string>();
    const mutable = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const table = pending[index]!;
      const key = visitKey(table);
      if (seen.has(key)) continue;
      seen.add(key);
      const identity = this.tableIdentity(table);
      if (!table.frozen) mutable.add(identity);
      if (table.metatable?.kind === 'table') pending.push(table.metatable);
      const contents = this.files.get(table.file)?.tables.get(table.position);
      const values = [
        ...(contents?.values ?? Object.values(contents?.fields ?? {})).map((value) => ({
          file: table.file,
          value,
        })),
        ...(this.storedTableValues.get(identity) ?? []),
      ];
      for (const entry of values) {
        const file = this.files.get(entry.file)!;
        if (!this.mayBeTableArgument(file, entry.value)) continue;
        const budget: EvaluationBudget = {
          left: 512,
          ignoreTableEscapes: true,
        };
        const child = this.evaluate(entry.file, entry.value, new Set(), budget);
        if (child.kind === 'table') pending.push(child);
        else if (child.kind === 'unknown')
          for (const origin of this.potentialTableOrigins(entry.file, entry.value, budget.left < 0))
            mutable.add(origin);
      }
    }
    const result = [...mutable];
    this.reachableTables.set(rootKey, result);
    return result;
  }

  /** A cheap exclusion filter, never evidence that two receivers are equal. */
  private mayReferenceForeignTable(
    file: FileFacts,
    value: LuauValue,
    seen = new Set<LuauBinding>(),
  ): boolean {
    if (value.kind === 'call' || value.kind === 'member') return true;
    if (value.kind !== 'name') return false;
    const binding = this.binding(file, value.name, value.scope, value.at);
    if (!binding || seen.has(binding)) return false;
    seen.add(binding);
    return this.mayReferenceForeignTable(file, binding.value, seen);
  }

  private binding(
    file: FileFacts,
    name: string,
    scopeId: string,
    at: Range,
  ): LuauBinding | undefined {
    let scope: string | null = scopeId;
    while (scope) {
      let selected: LuauBinding | undefined;
      for (const candidate of file.bindings.get(scope)?.get(name) ?? []) {
        if (
          before(candidate.availableFrom, at) &&
          (!selected || before(selected.availableFrom, candidate.availableFrom))
        )
          selected = candidate;
      }
      if (selected) return selected;
      scope = file.scopes.get(scope)?.parent ?? null;
    }
    return undefined;
  }

  private definition(
    value: Resolved,
    indexes?: ScopeResolutionIndexes,
  ): SymbolDefinition | undefined {
    if (value.kind !== 'function' && value.kind !== 'field') return undefined;
    const file = this.files.get(value.file);
    if (!file) return undefined;
    const labels = value.kind === 'function' ? ['Function', 'Method'] : ['Property', 'Variable'];
    for (const label of labels) {
      const id = file.definitions.get(`${label}:${value.position}`);
      if (id)
        return indexes
          ? indexes.defs.get(id)
          : file.parsed.localDefs.find((definition) => definition.nodeId === id);
    }
    return undefined;
  }

  private functionScope(file: FileFacts, scopeId: string): string | undefined {
    let scope = file.scopes.get(scopeId);
    while (scope) {
      if (scope.kind === 'Function') return scope.id;
      scope = scope.parent ? file.scopes.get(scope.parent) : undefined;
    }
    return undefined;
  }

  private evaluate(
    filePath: string,
    value: LuauValue,
    active: Set<LuauValue>,
    budget: EvaluationBudget,
  ): Resolved {
    if (--budget.left < 0) return unknown('value-resolution-limit');
    if (active.has(value)) return unknown('cyclic-value');
    const file = this.files.get(filePath);
    if (!file) return unknown('unindexed-module');
    active.add(value);
    try {
      switch (value.kind) {
        case 'function':
          return { kind: 'function', file: filePath, position: value.position };
        case 'table':
          return { kind: 'table', file: filePath, position: value.position };
        case 'name': {
          const binding = this.binding(file, value.name, value.scope, value.at);
          if (!binding) return unknown('unbound-name');
          const writes = (file.bindings.get(binding.scope)?.get(binding.name) ?? []).filter(
            (candidate) => candidate.writeScope !== undefined,
          );
          if (
            writes.some((write) => write.writeScope !== binding.scope) ||
            (writes.length > 0 &&
              this.functionScope(file, value.scope) !== this.functionScope(file, binding.scope))
          )
            return unknown('mutable-captured-or-conditional-binding');
          return this.evaluate(filePath, binding.value, active, budget);
        }
        case 'member':
          return this.member(
            this.evaluate(filePath, value.base, active, budget),
            value.name,
            active,
            budget,
          );
        case 'call': {
          // A captured import proves this is the builtin require. A local
          // function with the same spelling never enters this import list.
          const imported = file.parsed.parsedImports.find(
            (item) => item.atRange && sameRange(item.atRange, value.at),
          );
          if (imported && this.config) {
            let expression: LuauStaticExpression;
            try {
              expression = JSON.parse(imported.targetRaw) as LuauStaticExpression;
            } catch {
              return unknown('dynamic-require');
            }
            const target = resolveLuauModule(this.config, {
              fromFile: filePath,
              expression,
              range: value.at,
            });
            return target.status === 'resolved'
              ? this.moduleValue(target.filePath, active, budget)
              : unknown(target.reason);
          }
          // Luau table.freeze returns the same table. This is a builtin rule
          // only when the root table namespace is lexically unshadowed.
          if (
            value.callee.kind === 'member' &&
            value.callee.name === 'freeze' &&
            value.callee.base.kind === 'name' &&
            value.callee.base.name === 'table' &&
            !this.binding(file, 'table', value.callee.base.scope, value.callee.base.at)
          ) {
            const table = value.args[0] && this.evaluate(filePath, value.args[0], active, budget);
            return table?.kind === 'table'
              ? { ...table, frozen: true }
              : unknown('invalid-freeze-argument');
          }
          if (this.isSetMetatable(file, value)) {
            const object = value.args[0] && this.evaluate(filePath, value.args[0], active, budget);
            const metatable =
              value.args[1] && this.evaluate(filePath, value.args[1], active, budget);
            if (object?.kind !== 'table' || metatable?.kind !== 'table')
              return unknown('dynamic-metatable');
            if (object.frozen) return unknown('frozen-table-metatable');
            if (!budget.metatableOriginOnly) {
              const candidates = [
                ...(this.metatableCalls.get(object.file) ?? []).map((call) => ({
                  file: object.file,
                  call,
                })),
                ...this.foreignMetatableCalls.filter((entry) => entry.file !== object.file),
              ];
              for (const candidate of candidates) {
                if (
                  !candidate.call.args[0] ||
                  (candidate.file === filePath && sameRange(candidate.call.at, value.at))
                )
                  continue;
                // An alias can itself be initialized by this setmetatable
                // call. Compare its allocation with a separate, bounded walk
                // so that the current validation does not create a false cycle.
                const comparison: EvaluationBudget = {
                  left: budget.left,
                  metatableOriginOnly: true,
                  ignoreTableEscapes: budget.ignoreTableEscapes,
                  ignoreForeignWrites: budget.ignoreForeignWrites,
                };
                const other = this.evaluate(
                  candidate.file,
                  candidate.call.args[0],
                  new Set(),
                  comparison,
                );
                budget.left = comparison.left;
                if (budget.left < 0) return unknown('value-resolution-limit');
                if (same(object, other)) return unknown('multiple-metatable-writes');
                if (other.kind === 'unknown') {
                  const origins = this.potentialTableOrigins(
                    candidate.file,
                    candidate.call.args[0],
                    false,
                  );
                  if (origins.includes(this.tableOrigin(object)))
                    return unknown('uncertain-metatable-write');
                }
              }
            }
            return { ...object, metatable };
          }
          if (budget.purityDependencies) return unknown('call-derived-purity-unproven');
          let callee = this.evaluate(filePath, value.callee, active, budget);
          if (value.method) callee = this.member(callee, value.method, active, budget);
          if (callee.kind !== 'function') return unknown('unknown-call-result');
          const returned = this.files.get(callee.file)?.facts.functionReturns[callee.position];
          if (returned?.length !== 1) return unknown('nonunique-call-result');
          const result = this.evaluate(callee.file, returned[0]!, active, budget);
          if (result.kind !== 'table') return result;
          const resultFile = this.files.get(result.file)!;
          const creationScope = resultFile.tables.get(result.position)?.scope;
          const ownerScope = creationScope && this.functionScope(resultFile, creationScope);
          const owner = ownerScope && resultFile.scopes.get(ownerScope);
          // Two calls allocating fresh tables share a syntax node, but never
          // share mutations. Returned module state keeps its original identity.
          return result.instance ||
            (result.file === callee.file && owner && luauPosition(owner.range) === callee.position)
            ? {
                ...result,
                instance: `${filePath}:${luauPosition(value.at)}:${result.instance ?? result.position}`,
              }
            : result;
        }
        default:
          return unknown(value.kind === 'unknown' ? value.reason : 'non-callable-value');
      }
    } finally {
      active.delete(value);
    }
  }

  private moduleValue(
    filePath: string,
    active: Set<LuauValue>,
    budget: EvaluationBudget,
  ): Resolved {
    const returned = this.files.get(filePath)?.facts.returns;
    return returned?.length === 1
      ? this.evaluate(filePath, returned[0]!, active, budget)
      : unknown('nonunique-module-return');
  }

  private member(
    base: Resolved,
    name: string,
    active: Set<LuauValue>,
    budget: EvaluationBudget,
    field = false,
  ): Resolved {
    if (--budget.left < 0) return unknown('member-resolution-limit');
    if (base.kind !== 'table')
      return unknown(base.kind === 'unknown' ? base.reason : 'non-table-receiver');
    const file = this.files.get(base.file)!;
    const table = file.tables.get(base.position);
    if (!table) return unknown('missing-table');
    const values: LuauValue[] = [];
    // JSON replay restores ordinary object prototypes; only captured own keys
    // are Luau fields, even when their spelling matches a JS prototype key.
    const initial = Object.hasOwn(table.fields, name) ? table.fields[name] : undefined;
    const fieldPosition = Object.hasOwn(table.fieldPositions, name)
      ? table.fieldPositions[name]
      : undefined;
    if (field && fieldPosition) return { kind: 'field', file: base.file, position: fieldPosition };
    // A frozen value may still have escaped before freezing; retain that
    // dependency while consumer-side frozen escapes are excluded separately.
    budget.purityDependencies?.add(this.tableIdentity(base));
    budget.purityDependencies?.add(this.tableOrigin(base));
    budget.purityDependencies?.add(UNKNOWN_TABLE_ORIGIN);
    if (!budget.ignoreTableEscapes) {
      const effects = this.collectTableEscapes();
      const escaped =
        effects.get(this.tableIdentity(base)) ??
        effects.get(this.tableOrigin(base)) ??
        effects.get(UNKNOWN_TABLE_ORIGIN);
      if (escaped) return unknown(escaped);
    }
    // An unknown constructor key may overwrite a named initializer. The
    // declaration still exists, but its original value is no longer proven.
    if (table.incomplete) return unknown('computed-table-field');
    if (initial) values.push(initial);
    if (!budget.ignoreForeignWrites) this.collectForeignWriteTargets();
    const fileWrites = this.writesByFile.get(base.file);
    const localWrites = budget.ignoreForeignWrites
      ? [...(fileWrites?.get(name) ?? []), ...(fileWrites?.get(null) ?? [])]
      : (this.localWriteTargets.get(this.tableIdentity(base)) ?? []);
    for (const write of localWrites) {
      if (write.name !== name && write.name !== null) continue;
      const receiver = budget.ignoreForeignWrites
        ? this.evaluate(base.file, write.base, active, budget)
        : base;
      if (budget.left < 0) return unknown('member-resolution-limit');
      if (same(base, receiver)) {
        if (budget.ignoreForeignWrites && receiver.kind === 'table' && receiver.frozen) continue;
        if (write.name === null) return unknown('computed-member-write');
        if (write.scope !== table.scope) return unknown('conditional-or-captured-member-write');
        values.push(write.value);
      }
    }
    if (!budget.ignoreForeignWrites) {
      const writes = this.collectForeignWriteTargets().get(this.tableIdentity(base));
      if (writes?.has(name) || writes?.has(null)) return unknown('cross-module-member-write');
    }
    let resolved: Resolved | undefined;
    for (const value of values) {
      const candidate = this.evaluate(base.file, value, active, budget);
      if (candidate.kind === 'unknown') return candidate;
      if (resolved && !same(resolved, candidate)) return unknown('multiple-member-writes');
      resolved = candidate;
    }
    if (resolved) return resolved;
    if (base.metatable && name !== '__index') {
      const inherited = this.member(base.metatable, '__index', active, budget);
      return inherited.kind === 'table'
        ? this.member(inherited, name, active, budget, field)
        : unknown('dynamic-index-metamethod');
    }
    return unknown('member-not-proven');
  }

  private reference(site: ReferenceSite): { file: FileFacts; fact: LuauReferenceFact } | undefined {
    const path = this.fileForScope.get(site.inScope);
    const file = path && this.files.get(path);
    const fact = file && file.references.get(key(site.atRange, site.kind));
    return file && fact ? { file, fact } : undefined;
  }

  target(site: ReferenceSite, indexes: ScopeResolutionIndexes): TargetResult {
    let cached = this.targets.get(indexes);
    if (!cached) {
      cached = new WeakMap();
      this.targets.set(indexes, cached);
    }
    const prior = cached.get(site);
    if (prior) return prior;
    // Several shared passes ask about the same occurrence. Cache only this
    // complete query, which starts with its own stack and budget; intermediate
    // cycle/limit results depend on their callers and must never be cached.
    const result = this.resolveTarget(site, indexes);
    cached.set(site, result);
    return result;
  }

  private resolveTarget(site: ReferenceSite, indexes: ScopeResolutionIndexes): TargetResult {
    const reference = this.reference(site);
    if (!reference) return { reason: 'missing-source-fact' };
    const { file, fact } = reference;
    if (site.kind === 'type-reference') return this.typeTarget(file, fact.scope, site, indexes);
    const active = new Set<LuauValue>();
    const budget = { left: 512 };
    let target: Resolved;
    if (site.kind === 'call' && fact.value.kind === 'call') {
      target = this.evaluate(file.parsed.filePath, fact.value.callee, active, budget);
      if (fact.value.method) target = this.member(target, fact.value.method, active, budget);
    } else if (fact.value.kind === 'member') {
      const base = this.evaluate(file.parsed.filePath, fact.value.base, active, budget);
      target = this.member(base, fact.value.name, active, budget, true);
      if (!this.definition(target, indexes))
        target = this.member(base, fact.value.name, active, budget);
    } else if ((site.kind === 'write' || site.kind === 'read') && fact.value.kind === 'name') {
      const binding = this.binding(file, fact.value.name, fact.value.scope, fact.value.at);
      target = binding
        ? {
            kind: 'field',
            file: file.parsed.filePath,
            position: binding.bindingPosition ?? luauPosition(binding.range),
          }
        : unknown('missing-binding');
    } else {
      target = this.evaluate(file.parsed.filePath, fact.value, active, budget);
      if (target.kind === 'unknown' && fact.value.kind === 'name') {
        const binding = this.binding(file, fact.value.name, fact.value.scope, fact.value.at);
        if (binding)
          target = {
            kind: 'field',
            file: file.parsed.filePath,
            position: binding.bindingPosition ?? luauPosition(binding.range),
          };
      }
    }
    const definition = this.definition(target, indexes);
    return definition && (site.kind !== 'call' || target.kind === 'function')
      ? { definition, reason: 'static-value-identity' }
      : { reason: target.kind === 'unknown' ? target.reason : 'not-a-callable-definition' };
  }

  private typeTarget(
    file: FileFacts,
    scopeId: string,
    site: ReferenceSite,
    indexes: ScopeResolutionIndexes,
  ): { definition?: SymbolDefinition; reason: string } {
    if (site.explicitReceiver) {
      const visited = new Set<LuauBinding>();
      let value: LuauValue = {
        kind: 'name',
        name: site.explicitReceiver.name,
        scope: scopeId,
        at: site.atRange,
      };
      while (value.kind === 'name') {
        const binding = this.binding(file, value.name, value.scope, value.at);
        if (
          !binding ||
          visited.has(binding) ||
          (file.bindings.get(binding.scope)?.get(binding.name) ?? []).some(
            (candidate) => candidate.writeScope,
          )
        )
          return { reason: 'unknown-type-namespace' };
        visited.add(binding);
        value = binding.value;
      }
      const imported =
        value.kind === 'call' &&
        file.parsed.parsedImports.find((item) => item.atRange && sameRange(item.atRange, value.at));
      if (!imported || !this.config) return { reason: 'unknown-type-namespace' };
      let expression: LuauStaticExpression;
      try {
        expression = JSON.parse(imported.targetRaw) as LuauStaticExpression;
      } catch {
        return { reason: 'dynamic-type-namespace' };
      }
      const target = resolveLuauModule(this.config, { fromFile: file.parsed.filePath, expression });
      if (target.status !== 'resolved') return { reason: target.reason };
      const candidates =
        this.files
          .get(target.filePath)
          ?.parsed.localDefs.filter(
            (definition) =>
              definition.type === 'TypeAlias' &&
              definition.isExported &&
              definition.qualifiedName === site.name,
          ) ?? [];
      return candidates.length === 1
        ? { definition: indexes.defs.get(candidates[0]!.nodeId), reason: 'exported-type-identity' }
        : { reason: 'type-not-exported' };
    }
    let scope: string | null = scopeId;
    while (scope) {
      const current = file.scopes.get(scope);
      const claims =
        current?.claims.filter(
          (claim) =>
            claim.name === site.name &&
            (claim.purpose === 'type' || claim.purpose === 'both') &&
            (!claim.availableFrom || before(claim.availableFrom, site.atRange)),
        ) ?? [];
      if (claims.length) {
        const claim = claims.at(-1)!;
        if (claim.kind === 'blocked') return { reason: 'type-parameter' };
        const id =
          file.definitions.get(`TypeAlias:${luauPosition(claim.range)}`) ??
          file.definitions.get(`Function:${luauPosition(claim.range)}`);
        return id
          ? { definition: indexes.defs.get(id), reason: 'lexical-type-identity' }
          : { reason: 'unindexed-type' };
      }
      scope = current?.parent ?? null;
    }
    return { reason: 'external-or-intrinsic-type' };
  }

  moduleExports(file: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
    const cached = this.exports.get(file.filePath);
    if (cached) return cached;
    const result = new Map<string, SymbolDefinition>();
    this.exports.set(file.filePath, result);
    for (const definition of file.localDefs) {
      if (definition.isExported && definition.type === 'TypeAlias' && definition.qualifiedName)
        result.set(definition.qualifiedName, definition);
    }
    const active = new Set<LuauValue>();
    const budget = { left: 2048 };
    const returned = this.moduleValue(file.filePath, active, budget);
    if (returned.kind !== 'table') return result;
    const owner = this.files.get(returned.file)!;
    const names = new Set(Object.keys(owner.tables.get(returned.position)?.fields ?? {}));
    for (const write of owner.facts.memberWrites) {
      if (
        write.name !== null &&
        same(returned, this.evaluate(returned.file, write.base, active, budget))
      )
        names.add(write.name);
    }
    for (const name of names) {
      const value = this.member(returned, name, active, { left: 512 });
      const definition =
        this.definition(value) ??
        this.definition(this.member(returned, name, active, { left: 512 }, true));
      // Type and value namespaces may share a spelling. Keep the type in the
      // shared namespace surface; runtime calls use exact value facts above.
      if (definition && !result.has(name)) result.set(name, definition);
    }
    return result;
  }
}
