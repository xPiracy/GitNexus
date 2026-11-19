import { createHash } from 'node:crypto';
import { lstat, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { getProviderForFile } from '../ingestion/languages/index.js';

/** Null records a proven absence; a missing key is unknown or no longer declared. */
export type ResolutionContextHashes = Record<string, string | null>;

/** Canonical finite inputs for the providers represented by the source scan. */
export function collectResolutionContextPaths(sourceFiles: readonly string[]): string[] {
  const contextPaths = new Set<string>();
  const providers = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const provider = getProviderForFile(sourceFile);
    if (!provider || providers.has(provider.id)) continue;
    providers.add(provider.id);
    for (const declaration of provider.resolutionContextFiles ?? []) {
      const relative = declaration.replaceAll('\\', '/');
      if (
        !relative ||
        path.posix.isAbsolute(relative) ||
        path.win32.parse(relative).root !== '' ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        throw new Error(
          `Resolution context must be a canonical repo-relative path: ${declaration}`,
        );
      }
      contextPaths.add(relative);
    }
  }

  return [...contextPaths].sort();
}

/**
 * Capture provider-declared inputs independently of source scan exclusions and
 * size limits. Only current provider declarations authorize reads: metadata
 * keys are compared later, never interpreted as filesystem paths.
 */
export async function captureResolutionContextHashes(
  repoPath: string,
  sourceFiles: readonly string[],
): Promise<ResolutionContextHashes> {
  const entries: [string, string | null][] = [];
  for (const relative of collectResolutionContextPaths(sourceFiles)) {
    const absolute = path.resolve(repoPath, relative);
    try {
      // Check the link itself: a dangling configured link is an error, not a
      // missing optional input that may certify a stale graph as current.
      await lstat(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      entries.push([relative, null]);
      continue;
    }
    // Reject directories and special files before open (a FIFO could block).
    if (!(await stat(absolute)).isFile()) {
      throw new Error(`Resolution context must be a regular file: ${relative}`);
    }
    const file = await open(absolute, 'r');
    try {
      if (!(await file.stat()).isFile()) {
        throw new Error(`Resolution context must be a regular file: ${relative}`);
      }
      // Config inputs can intentionally exceed the source-file size limit.
      // Stream their bytes so fingerprinting adds no file-sized allocation.
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      entries.push([relative, hash.digest('hex')]);
    } finally {
      await file.close();
    }
  }
  return Object.fromEntries(entries);
}

/** Include removed declarations and absent files; neither may authorize reuse. */
export function diffResolutionContextHashes(
  current: ResolutionContextHashes,
  previous: ResolutionContextHashes | undefined,
): string[] {
  return [...new Set([...Object.keys(current), ...Object.keys(previous ?? {})])]
    .filter((relative) => current[relative] !== previous?.[relative])
    .sort();
}
