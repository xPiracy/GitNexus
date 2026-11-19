import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { statusCommand } from '../../src/cli/status.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const SOURCE_FILES = ['src/Client.luau', 'src/First.luau', 'src/Second.lua'];
const options = { skipAgentsMd: true, skipSkills: true, skipFts: true, workerPoolSize: 1 };
const callbacks = { onProgress: () => {} };

function sourcemap(libraryFile: string, oversized: boolean): string {
  return (
    JSON.stringify({
      name: 'Fixture',
      className: 'DataModel',
      children: [
        {
          name: 'ReplicatedStorage',
          className: 'ReplicatedStorage',
          children: [
            { name: 'Client', className: 'ModuleScript', filePaths: [SOURCE_FILES[0]] },
            { name: 'Library', className: 'ModuleScript', filePaths: [libraryFile] },
          ],
        },
      ],
    }) + (oversized ? ' '.repeat(600_000) : '')
  );
}

/** Real persisted rows, not the fresh in-memory graph returned by the pipeline. */
async function persistedCalls(databasePath: string): Promise<unknown[]> {
  await adapter.initLbug(databasePath);
  try {
    return await adapter.executeQuery(
      'MATCH (caller:Function)-[edge:CodeRelation]->(target:Function) ' +
        "WHERE edge.type = 'CALLS' AND caller.name = 'run' " +
        'RETURN target.filePath AS filePath, target.name AS name ORDER BY filePath, name',
    );
  } finally {
    await adapter.closeLbug();
  }
}

/** Exercise the actual status command against the same stored graph receipt. */
async function repositoryStatus(repo: string): Promise<{
  status: string;
  contentDrift: { status: string; changed?: string[]; added?: string[]; deleted?: string[] };
}> {
  const previousCwd = process.cwd();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.chdir(repo);
    await statusCommand({ json: true });
    const json = output.mock.calls.find(
      ([value]) => typeof value === 'string' && value.startsWith('{'),
    )?.[0];
    expect(json).toBeDefined();
    return JSON.parse(json as string);
  } finally {
    process.chdir(previousCwd);
    output.mockRestore();
  }
}

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Luau))(
  'resolution context invalidation outside source coverage',
  () => {
    it.each(['ignored', 'oversized'] as const)(
      'refreshes persisted calls for %s map edits, deletion, and recreation',
      async (mode) => {
        const temp = await createTempDir();
        try {
          const repo = path.join(temp.dbPath, 'repo');
          await mkdir(path.join(repo, 'src'), { recursive: true });
          vi.stubEnv('GITNEXUS_HOME', path.join(temp.dbPath, 'settings'));
          vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
          vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
          vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
          vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
          vi.stubEnv('GITNEXUS_MAX_FILE_SIZE', '512');
          await writeFile(
            path.join(repo, '.gitignore'),
            '.gitnexus/\n' + (mode === 'ignored' ? 'sourcemap.json\n' : ''),
          );
          await writeFile(
            path.join(repo, SOURCE_FILES[0]!),
            [
              'local Library = require(script.Parent.Library)',
              'local function run() return Library.leaf() end',
              'return run',
            ].join('\n'),
          );
          await writeFile(
            path.join(repo, SOURCE_FILES[1]!),
            'local function first() return 1 end\nreturn { leaf = first }\n',
          );
          await writeFile(
            path.join(repo, SOURCE_FILES[2]!),
            'local function second() return 2 end\nreturn { leaf = second }\n',
          );
          const mapPath = path.join(repo, 'sourcemap.json');
          const firstMap = sourcemap(SOURCE_FILES[1]!, mode === 'oversized');
          await writeFile(mapPath, firstMap);
          initGitRepo(repo);
          execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
          commitAll(repo, 'public resolution context fixture');
          const { storagePath, lbugPath } = getStoragePaths(repo);

          await runFullAnalysis(repo, options, callbacks);
          const baseline = (await loadMeta(storagePath))!;
          expect(baseline.fileHashes).not.toHaveProperty('sourcemap.json');
          expect(baseline.resolutionContextHashes).toEqual({
            'sourcemap.json': createHash('sha256').update(firstMap).digest('hex'),
          });
          expect(await persistedCalls(lbugPath)).toEqual([
            { filePath: SOURCE_FILES[1], name: 'first' },
          ]);
          expect((await runFullAnalysis(repo, options, callbacks)).alreadyUpToDate).toBe(true);
          expect(await repositoryStatus(repo)).toMatchObject({
            status: 'up-to-date',
            contentDrift: { status: 'current' },
          });

          const sourceBytes = await Promise.all(
            SOURCE_FILES.map((file) => readFile(path.join(repo, file))),
          );
          const mutations = [
            {
              content: sourcemap(SOURCE_FILES[2]!, mode === 'oversized'),
              expected: [{ filePath: SOURCE_FILES[2], name: 'second' }],
            },
            { content: null, expected: [] },
            { content: firstMap, expected: [{ filePath: SOURCE_FILES[1], name: 'first' }] },
          ];
          for (const mutation of mutations) {
            if (mutation.content === null) await rm(mapPath);
            else await writeFile(mapPath, mutation.content);
            if (mode === 'ignored') {
              expect(
                execFileSync('git', ['status', '--porcelain'], {
                  cwd: repo,
                  encoding: 'utf8',
                }).trim(),
              ).toBe('');
            }
            const beforeRefresh = await repositoryStatus(repo);
            expect(beforeRefresh).toMatchObject({
              status: 'stale',
              contentDrift: { status: 'drifted' },
            });
            expect([
              ...(beforeRefresh.contentDrift.changed ?? []),
              ...(beforeRefresh.contentDrift.added ?? []),
              ...(beforeRefresh.contentDrift.deleted ?? []),
            ]).toContain('sourcemap.json');
            const refreshed = await runFullAnalysis(repo, options, callbacks);
            expect(refreshed.alreadyUpToDate).not.toBe(true);
            expect(refreshed.incrementalStats).toMatchObject({
              changedFiles: 0,
              deletedFiles: 0,
              writeMode: 'incremental',
            });
            expect(await persistedCalls(lbugPath)).toEqual(mutation.expected);
            const metadata = (await loadMeta(storagePath))!;
            expect(metadata.fileHashes).toEqual(baseline.fileHashes);
            expect(metadata.resolutionContextHashes).toEqual({
              'sourcemap.json':
                mutation.content === null
                  ? null
                  : createHash('sha256').update(mutation.content).digest('hex'),
            });
            expect(
              await Promise.all(SOURCE_FILES.map((file) => readFile(path.join(repo, file)))),
            ).toEqual(sourceBytes);
          }
          // The unchanged map returns to the cheap clean-Git path after the
          // successful refresh; stale context does not permanently disable it.
          expect((await runFullAnalysis(repo, options, callbacks)).alreadyUpToDate).toBe(true);
          expect(await repositoryStatus(repo)).toMatchObject({
            status: 'up-to-date',
            contentDrift: { status: 'current' },
          });
        } finally {
          await adapter.closeLbug();
          vi.unstubAllEnvs();
          await temp.cleanup();
        }
      },
      180_000,
    );
  },
);
