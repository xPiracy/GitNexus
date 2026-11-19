import { getProviderForFile } from '../ingestion/languages/index.js';
import type { LanguageProvider } from '../ingestion/language-provider.js';

/**
 * Collect current files whose resolution may change with a sibling or config.
 * Provider keys are language-local, and changed paths may include deleted files.
 * File scans remain linear; config hooks run only for represented providers.
 */
export function collectResolutionGroupFiles(
  changedFiles: readonly string[],
  currentFiles: readonly string[],
): Set<string> {
  const affected = new Set<string>();
  if (changedFiles.length === 0) return affected;
  const changedGroups = new Set<string>();
  const contextProviders = new Map<LanguageProvider['id'], LanguageProvider>();
  for (const filePath of changedFiles) {
    const provider = getProviderForFile(filePath);
    if (!provider?.incrementalResolutionGroup) continue;
    if (provider.incrementalResolutionContext) contextProviders.set(provider.id, provider);
    const group = provider.incrementalResolutionGroup(filePath);
    if (group !== undefined) changedGroups.add(`${provider.id}\0${group}`);
  }

  // A config has no source provider of its own. Gather the providers and their
  // current members before interpreting it, including config-only changes.
  const currentGroups = new Map<string, string[]>();
  for (const filePath of currentFiles) {
    const provider = getProviderForFile(filePath);
    if (!provider?.incrementalResolutionGroup) continue;
    if (provider.incrementalResolutionContext) contextProviders.set(provider.id, provider);
    const group = provider.incrementalResolutionGroup(filePath);
    if (group === undefined) continue;
    const key = `${provider.id}\0${group}`;
    const members = currentGroups.get(key);
    if (members) members.push(filePath);
    else currentGroups.set(key, [filePath]);
  }

  for (const filePath of changedFiles) {
    for (const provider of contextProviders.values()) {
      const group = provider.incrementalResolutionContext?.(filePath);
      if (group !== undefined) changedGroups.add(`${provider.id}\0${group}`);
    }
  }
  for (const group of changedGroups) {
    for (const filePath of currentGroups.get(group) ?? []) affected.add(filePath);
  }
  return affected;
}

/** Whether any current file belongs to a resolution group. Repositories with
 * none never pay for per-file row digests. */
export function hasResolutionGroups(currentFiles: readonly string[]): boolean {
  return currentFiles.some((filePath) => {
    const provider = getProviderForFile(filePath);
    return provider?.incrementalResolutionGroup?.(filePath) !== undefined;
  });
}
