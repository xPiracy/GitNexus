import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Range } from 'gitnexus-shared';

/** Parser-proven instance expressions; names never acquire global meaning by spelling. */
export type LuauStaticExpression =
  | { readonly kind: 'game' | 'script' }
  | { readonly kind: 'binding'; readonly name: string }
  | {
      readonly kind: 'member' | 'getService';
      readonly base: LuauStaticExpression;
      readonly name: string;
    }
  | {
      readonly kind: 'findFirstChild' | 'waitForChild';
      readonly base: LuauStaticExpression;
      readonly name: string;
      readonly recursive?: boolean;
    }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'unknown'; readonly reason?: string };

/** Already-selected alias scope; baseDirectory is relative to the project, not the importer. */
export interface LuauRequireAlias {
  readonly target: string;
  readonly baseDirectory: string;
}

export interface LoadRojoModuleMapOptions {
  readonly projectPath: string;
  /** Omit for a filesystem-only context. An explicitly selected missing map is an error. */
  readonly sourcemapPath?: string;
  /** Complete scanned source universe, including files not represented in the map. */
  readonly sourceFiles?: readonly string[];
  readonly requireAliases?: ReadonlyMap<string, LuauRequireAlias>;
  /** No inferred server-version default: instance IR works when this is omitted. */
  readonly stringRequireMode?: 'filesystem' | 'datamodel';
}

interface SourcePath {
  readonly status: 'indexed' | 'external' | 'missing';
  readonly filePath?: string;
}

export interface RojoModuleInstance {
  readonly id: string;
  readonly name: string;
  readonly className: string;
  readonly parentId?: string;
  readonly children: readonly string[];
  readonly sources: readonly SourcePath[];
}

export interface RojoModuleMap {
  readonly projectPath: string;
  readonly sourcemapPath?: string;
  readonly rootId?: string;
  readonly instances: ReadonlyMap<string, RojoModuleInstance>;
  readonly instancesByFile: ReadonlyMap<string, readonly string[]>;
  readonly sourceFiles: ReadonlyMap<string, SourcePath>;
  readonly directories: ReadonlySet<string>;
  readonly requireAliases: ReadonlyMap<string, LuauRequireAlias>;
  readonly stringRequireMode?: 'filesystem' | 'datamodel';
}

export interface LuauModuleCandidate {
  readonly filePath: string;
  readonly instanceIds: readonly string[];
}

interface ResolutionDetails {
  readonly origin: { readonly filePath: string; readonly range?: Range };
  readonly candidates: readonly LuauModuleCandidate[];
  readonly reason: string;
}

export type LuauModuleResolution = ResolutionDetails &
  (
    | { readonly status: 'resolved'; readonly filePath: string }
    | { readonly status: 'ambiguous' | 'unresolved' | 'external' }
  );

export interface LuauModuleRequest {
  readonly fromFile: string;
  readonly expression: LuauStaticExpression;
  readonly bindings?: ReadonlyMap<string, LuauStaticExpression>;
  readonly range?: Range;
}

interface MapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: MapNode[];
}

const portable = (value: string): string => value.replaceAll('\\', '/');
const isSource = (value: string): boolean => /\.(?:lua|luau)$/.test(value);
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
  (error as NodeJS.ErrnoException)?.code === 'ENOTDIR';

/** A lexical boundary check precedes realpath/stat, so an explicit escape is never read. */
function relativeInside(projectPath: string, value: string): string | undefined {
  const normalized = portable(value);
  if (path.sep === '/' && path.win32.isAbsolute(value) && !path.posix.isAbsolute(normalized))
    return undefined;
  const relative = portable(path.relative(projectPath, path.resolve(projectPath, normalized)));
  return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
    ? undefined
    : relative || '.';
}

function assertMapNode(value: unknown): asserts value is MapNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Rojo sourcemap node');
  const node = value as Partial<MapNode>;
  if (
    typeof node.name !== 'string' ||
    typeof node.className !== 'string' ||
    !node.className ||
    (node.filePaths !== undefined &&
      (!Array.isArray(node.filePaths) ||
        node.filePaths.some((file) => typeof file !== 'string'))) ||
    (node.children !== undefined && !Array.isArray(node.children))
  ) {
    throw new Error('Invalid Rojo sourcemap node');
  }
}

/**
 * Capture filesystem facts once per workspace. Resolution below does no I/O.
 * Rojo filePaths are relative to the workspace where Rojo ran, NOT to the map
 * artifact's directory (luau-lsp RobloxSourcemap::getRealPathFromSourceNode).
 * Only explicitly scanned or mapped source files enter this index.
 */
export async function loadRojoModuleMap(options: LoadRojoModuleMapOptions): Promise<RojoModuleMap> {
  const projectPath = await realpath(options.projectPath);
  if (!(await stat(projectPath)).isDirectory())
    throw new Error('Luau project path must be a directory');
  let sourcemapPath: string | undefined;
  let root: MapNode | undefined;
  if (options.sourcemapPath !== undefined) {
    try {
      sourcemapPath = await realpath(path.resolve(projectPath, options.sourcemapPath));
      if (!(await stat(sourcemapPath)).isFile()) throw new Error('Not a regular file');
      const parsed: unknown = JSON.parse(await readFile(sourcemapPath, 'utf8'));
      assertMapNode(parsed);
      root = parsed;
    } catch (error) {
      throw new Error('Cannot load Rojo sourcemap', { cause: error });
    }
  }

  // IDs use structural positions, not names: siblings and physical sources can
  // legitimately appear more than once and must never overwrite each other.
  const rawNodes: { id: string; parentId?: string; node: MapNode }[] = [];
  const stack = root ? [{ id: '0', node: root, parentId: undefined as string | undefined }] : [];
  while (stack.length) {
    const item = stack.pop()!;
    assertMapNode(item.node);
    rawNodes.push(item);
    for (let i = (item.node.children?.length ?? 0) - 1; i >= 0; i--) {
      stack.push({ id: `${item.id}/${i}`, parentId: item.id, node: item.node.children![i] });
    }
  }

  const rawPaths = new Set((options.sourceFiles ?? []).filter(isSource));
  for (const { node } of rawNodes)
    for (const file of node.filePaths ?? []) if (isSource(file)) rawPaths.add(file);
  const records = new Map<string, SourcePath>();
  const sourceFiles = new Map<string, SourcePath>();
  const directories = new Set<string>(['.']);
  const directoryProbes = new Set<string>();
  const addDirectories = (file: string) => {
    let directory = path.posix.dirname(file);
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  };
  const paths = [...rawPaths];
  let next = 0;
  // Bound metadata concurrency; large maps can contain thousands of files.
  await Promise.all(
    Array.from({ length: Math.min(24, paths.length) }, async () => {
      while (next < paths.length) {
        const raw = paths[next++];
        const logical = relativeInside(projectPath, raw);
        let record: SourcePath = { status: 'external' };
        if (logical !== undefined) {
          try {
            const canonical = await realpath(path.resolve(projectPath, logical));
            const filePath = relativeInside(projectPath, canonical);
            if (filePath !== undefined) {
              record = (await stat(canonical)).isFile()
                ? { status: 'indexed', filePath }
                : { status: 'missing' };
            }
          } catch (error) {
            if (!missing(error)) throw error;
            record = { status: 'missing' };
          }
          sourceFiles.set(logical, record);
          if (record.filePath !== undefined) {
            sourceFiles.set(record.filePath, record);
            addDirectories(logical);
            addDirectories(record.filePath);
            // A same-name empty directory also makes `require("./name")`
            // ambiguous in Luau. It need not contain another indexed source.
            directoryProbes.add(logical.replace(/\.(?:lua|luau)$/, ''));
            directoryProbes.add(record.filePath.replace(/\.(?:lua|luau)$/, ''));
          }
        }
        records.set(raw, record);
      }
    }),
  );
  const probes = [...directoryProbes];
  next = 0;
  await Promise.all(
    Array.from({ length: Math.min(24, probes.length) }, async () => {
      while (next < probes.length) {
        const relative = probes[next++];
        try {
          const canonical = await realpath(path.resolve(projectPath, relative));
          if (
            relativeInside(projectPath, canonical) !== undefined &&
            (await stat(canonical)).isDirectory()
          ) {
            directories.add(relative);
          }
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
    }),
  );

  const instances = new Map<string, RojoModuleInstance>();
  const instancesByFile = new Map<string, string[]>();
  for (const { id, parentId, node } of rawNodes) {
    const sources = (node.filePaths ?? []).filter(isSource).map((file) => records.get(file)!);
    instances.set(id, {
      id,
      parentId,
      name: node.name,
      className: node.className,
      children: (node.children ?? []).map((_, index) => `${id}/${index}`),
      sources,
    });
    for (const source of sources) {
      if (source.filePath === undefined) continue;
      const placements = instancesByFile.get(source.filePath) ?? [];
      if (!placements.includes(id)) placements.push(id);
      instancesByFile.set(source.filePath, placements);
    }
  }
  const requireAliases = new Map<string, LuauRequireAlias>();
  for (const [name, alias] of options.requireAliases ?? []) {
    const key = name.toLowerCase();
    if (requireAliases.has(key)) throw new Error(`Duplicate Luau require alias: ${name}`);
    requireAliases.set(key, { ...alias });
  }
  return {
    projectPath,
    sourcemapPath,
    rootId: root ? '0' : undefined,
    instances,
    instancesByFile,
    sourceFiles,
    directories,
    requireAliases,
    stringRequireMode: options.stringRequireMode,
  };
}

/** Default native-graph capture: a missing map disables instance resolution only. */
export async function loadLuauResolutionConfig(
  repoPath: string,
  sourceFiles: readonly string[] = [],
): Promise<RojoModuleMap> {
  const sourcemapPath = path.resolve(repoPath, 'sourcemap.json');
  let exists = true;
  try {
    // A dangling selected artifact is a broken configuration, not an absent map.
    await lstat(sourcemapPath);
  } catch (error) {
    if (!missing(error)) throw error;
    exists = false;
  }
  return loadRojoModuleMap({
    projectPath: repoPath,
    sourcemapPath: exists ? sourcemapPath : undefined,
    sourceFiles,
    stringRequireMode: 'filesystem',
  });
}

type Failure = { kind: 'failure'; status: 'unresolved' | 'external'; reason: string };
type Selection = { kind: 'nodes'; ids: readonly string[]; ambiguous: boolean; incomplete?: string };
type Evaluated = Failure | Selection | { kind: 'string'; value: string };
const fail = (reason: string, status: Failure['status'] = 'unresolved'): Failure => ({
  kind: 'failure',
  status,
  reason,
});

/** init.luau/init.lua represent their enclosing module, not a child named init. */
function modulePath(filePath: string): string {
  return /(?:^|\/)init\.(?:lua|luau)$/.test(filePath)
    ? path.posix.dirname(filePath)
    : filePath.replace(/\.(?:lua|luau)$/, '');
}

export function resolveLuauModule(
  map: RojoModuleMap,
  request: LuauModuleRequest,
): LuauModuleResolution {
  const relative = relativeInside(map.projectPath, request.fromFile);
  const source = relative === undefined ? undefined : map.sourceFiles.get(relative);
  const fromFile = source?.filePath ?? relative ?? portable(request.fromFile);
  const origin = { filePath: fromFile, range: request.range };
  const result = (
    status: 'ambiguous' | 'unresolved' | 'external',
    reason: string,
    candidates: readonly LuauModuleCandidate[] = [],
  ): LuauModuleResolution => ({ status, reason, candidates, origin });
  const finishFile = (
    filePath: string,
    candidates: readonly LuauModuleCandidate[],
  ): LuauModuleResolution =>
    filePath === fromFile
      ? result('unresolved', 'self-require', candidates)
      : { status: 'resolved', reason: 'static-module', filePath, candidates, origin };
  if (relative === undefined || source?.status === 'external')
    return result('external', 'outside-project');
  if (source?.status !== 'indexed') return result('unresolved', 'source-not-indexed');

  const root = (): Selection | Failure =>
    map.rootId !== undefined && map.instances.get(map.rootId)?.className === 'DataModel'
      ? { kind: 'nodes', ids: [map.rootId], ambiguous: false }
      : fail('missing-datamodel');
  const current = (): Selection | Failure => {
    const ids = map.instancesByFile.get(fromFile) ?? [];
    return ids.length
      ? { kind: 'nodes', ids, ambiguous: ids.length > 1 }
      : fail('source-not-mapped');
  };
  const step = (selection: Selection, name: string, parent: boolean): Selection => {
    const ids = new Set<string>();
    let ambiguous = selection.ambiguous;
    let incomplete = selection.incomplete;
    for (const id of selection.ids) {
      const node = map.instances.get(id)!;
      const matches = parent
        ? node.parentId
          ? [node.parentId]
          : []
        : node.children.filter((child) => map.instances.get(child)!.name === name);
      if (!matches.length) incomplete ??= parent ? 'missing-parent' : 'child-not-found';
      if (matches.length > 1) ambiguous = true;
      for (const match of matches) ids.add(match);
    }
    return { kind: 'nodes', ids: [...ids], ambiguous, incomplete };
  };

  let budget = 256;
  const evaluate = (
    expression: LuauStaticExpression,
    active: ReadonlySet<string>,
    depth: number,
  ): Evaluated => {
    if (--budget < 0 || depth > 128) return fail('expression-limit');
    if (typeof expression !== 'object' || expression === null) return fail('invalid-expression');
    switch (expression.kind) {
      case 'game':
        return root();
      case 'script':
        return current();
      case 'string':
        return typeof expression.value === 'string' ? expression : fail('invalid-expression');
      case 'unknown':
        return fail('dynamic-expression');
      case 'binding': {
        if (active.has(expression.name)) return fail('cyclic-binding');
        const bound = request.bindings?.get(expression.name);
        return bound
          ? evaluate(bound, new Set([...active, expression.name]), depth + 1)
          : fail('unknown-binding');
      }
      case 'member':
      case 'getService':
      case 'findFirstChild':
      case 'waitForChild': {
        if (typeof expression.name !== 'string') return fail('dynamic-expression');
        if (expression.kind === 'findFirstChild' && expression.recursive)
          return fail('recursive-child-search');
        const base = evaluate(expression.base, active, depth + 1);
        if (base.kind === 'failure') return base;
        if (base.kind !== 'nodes') return fail('invalid-instance-base');
        if (expression.kind === 'getService' && base.ids.some((id) => id !== map.rootId))
          return fail('unsupported-service-receiver');
        return step(
          base,
          expression.name,
          expression.kind === 'member' && expression.name === 'Parent',
        );
      }
      default:
        return fail('invalid-expression');
    }
  };

  const finishNodes = (selection: Selection): LuauModuleResolution => {
    const files = new Map<string, Set<string>>();
    let problem = selection.incomplete;
    let external = false;
    for (const id of selection.ids) {
      const node = map.instances.get(id)!;
      if (node.className !== 'ModuleScript') {
        problem ??= 'not-module-script';
        continue;
      }
      if (!node.sources.length) problem ??= 'module-source-missing';
      for (const source of node.sources) {
        if (source.status !== 'indexed' || source.filePath === undefined) {
          external ||= source.status === 'external';
          problem ??= source.status === 'external' ? 'outside-project' : 'module-source-missing';
          continue;
        }
        const placements = files.get(source.filePath) ?? new Set<string>();
        placements.add(id);
        files.set(source.filePath, placements);
      }
    }
    const candidates = [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, ids]) => ({
        filePath,
        instanceIds: [...ids].sort(),
      }));
    if (!candidates.length)
      return result(external ? 'external' : 'unresolved', problem ?? 'module-source-missing');
    if (
      selection.ambiguous ||
      problem !== undefined ||
      candidates.length > 1 ||
      candidates[0].instanceIds.length > 1
    ) {
      return result('ambiguous', 'ambiguous-instance', candidates);
    }
    return finishFile(candidates[0].filePath, candidates);
  };

  const filesystem = (target: string): LuauModuleResolution => {
    const relativeTarget = relativeInside(map.projectPath, target);
    if (relativeTarget === undefined) return result('external', 'outside-project');
    const filesAt = (name: string): SourcePath[] =>
      path.posix.basename(name) === 'init'
        ? []
        : [map.sourceFiles.get(`${name}.luau`), map.sourceFiles.get(`${name}.lua`)].filter(
            (entry): entry is SourcePath => entry !== undefined && entry.status !== 'missing',
          );
    // An ambiguous intermediate module cannot become definite by appending a
    // child. Check only the selected path, never a repository-wide basename.
    let prefix = path.posix.dirname(relativeTarget);
    while (prefix !== '.') {
      const sources = filesAt(prefix);
      if (sources.length > 1 || (sources.length && map.directories.has(prefix))) {
        return result('ambiguous', 'ambiguous-filesystem-path');
      }
      prefix = path.posix.dirname(prefix);
    }
    const direct = filesAt(relativeTarget);
    const init = [`${relativeTarget}/init.luau`, `${relativeTarget}/init.lua`]
      .map((file) => map.sourceFiles.get(path.posix.normalize(file)))
      .filter((entry): entry is SourcePath => entry !== undefined && entry.status !== 'missing');
    const entries = [...direct, ...init];
    const candidates = [
      ...new Set(entries.flatMap((entry) => (entry.filePath ? [entry.filePath] : []))),
    ]
      .sort()
      .map((filePath) => ({ filePath, instanceIds: [] }));
    if (entries.length > 1 || (direct.length && map.directories.has(relativeTarget))) {
      return result('ambiguous', 'ambiguous-filesystem-path', candidates);
    }
    if (entries.some((entry) => entry.status === 'external'))
      return result('external', 'outside-project');
    return candidates.length
      ? finishFile(candidates[0].filePath, candidates)
      : result('unresolved', 'module-not-indexed');
  };

  const aliasPath = (specifier: string, visited: ReadonlySet<string>): string | Failure => {
    if (visited.size > 128) return fail('alias-limit');
    const [rawName, ...suffix] = specifier.slice(1).split('/');
    const name = rawName.toLowerCase();
    if (name === 'self') return path.posix.join(modulePath(fromFile), ...suffix);
    if (visited.has(name)) return fail('cyclic-alias');
    const alias = map.requireAliases.get(name);
    if (!alias) return fail('unknown-alias');
    const base = alias.target.startsWith('@')
      ? aliasPath(alias.target, new Set([...visited, name]))
      : relativeInside(
          map.projectPath,
          path.resolve(map.projectPath, portable(alias.baseDirectory), portable(alias.target)),
        );
    if (base === undefined) return fail('outside-project', 'external');
    return typeof base === 'string' ? path.posix.join(base, ...suffix) : base;
  };

  const stringModule = (specifier: string): LuauModuleResolution => {
    if (!map.stringRequireMode) return result('unresolved', 'string-mode-not-configured');
    // These are Luau require-path separators, not host-platform path syntax.
    if (!specifier || specifier.includes('\\') || specifier.includes('\0'))
      return result('unresolved', 'invalid-module-path');
    const relativePath = specifier.startsWith('./') || specifier.startsWith('../');
    const alias = specifier.startsWith('@')
      ? specifier.slice(1).split('/')[0].toLowerCase()
      : undefined;
    if (!relativePath && alias === undefined)
      return result('unresolved', 'unsupported-module-path');
    if (
      map.stringRequireMode === 'datamodel' &&
      (relativePath || alias === 'self' || (alias === 'game' && !map.requireAliases.has('game')))
    ) {
      let selected = alias === 'game' ? root() : current();
      // An unmapped filesystem module retains normal Luau path semantics.
      if (selected.kind !== 'failure' || alias === 'game') {
        if (selected.kind === 'failure') return result(selected.status, selected.reason);
        if (relativePath) selected = step(selected, 'Parent', true);
        const segments = alias ? specifier.split('/').slice(1) : specifier.split('/');
        for (const segment of segments) {
          if (segment === '.' || segment === '') continue;
          selected = step(selected, segment, segment === '..');
        }
        return finishNodes(selected);
      }
    }
    const target =
      alias !== undefined
        ? aliasPath(specifier, new Set())
        : path.posix.join(path.posix.dirname(modulePath(fromFile)), specifier);
    return typeof target === 'string' ? filesystem(target) : result(target.status, target.reason);
  };

  const evaluated = evaluate(request.expression, new Set(), 0);
  return evaluated.kind === 'failure'
    ? result(evaluated.status, evaluated.reason)
    : evaluated.kind === 'string'
      ? stringModule(evaluated.value)
      : finishNodes(evaluated);
}
