import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectIndexContentDrift } from '../../src/core/index-content-drift.js';
import { captureResolutionContextHashes } from '../../src/core/incremental/resolution-context-hashes.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

let root: string;
const contents = 'return 1\n';
const sourceHashes = { 'main.luau': createHash('sha256').update(contents).digest('hex') };
const coverage = { maxFileSizeBytes: 512 * 1024, dirtyPaths: [] };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-context-freshness-'));
  await writeFile(path.join(root, 'main.luau'), contents);
  await writeFile(path.join(root, '.gitignore'), 'sourcemap.json\n');
  initGitRepo(root);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  commitAll(root, 'public context freshness fixture');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolution context freshness', () => {
  it('reports ignored config creation, edit, and deletion despite clean Git', async () => {
    const absent = await captureResolutionContextHashes(root, Object.keys(sourceHashes));
    expect(await detectIndexContentDrift(root, sourceHashes, coverage, absent)).toEqual({
      kind: 'current',
      coveredFileCount: 1,
    });
    await writeFile(path.join(root, 'sourcemap.json'), 'first');
    expect(await detectIndexContentDrift(root, sourceHashes, coverage, absent)).toEqual({
      kind: 'drifted',
      changed: [],
      added: ['sourcemap.json'],
      deleted: [],
    });
    const first = await captureResolutionContextHashes(root, Object.keys(sourceHashes));
    await writeFile(path.join(root, 'sourcemap.json'), 'second');
    expect(await detectIndexContentDrift(root, sourceHashes, coverage, first)).toEqual({
      kind: 'drifted',
      changed: ['sourcemap.json'],
      added: [],
      deleted: [],
    });
    await rm(path.join(root, 'sourcemap.json'));
    expect(await detectIndexContentDrift(root, sourceHashes, coverage, first)).toEqual({
      kind: 'drifted',
      changed: [],
      added: [],
      deleted: ['sourcemap.json'],
    });
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('compares oversized config bytes independently of coverage', async () => {
    await writeFile(path.join(root, '.gitignore'), '');
    await writeFile(path.join(root, 'sourcemap.json'), ' '.repeat(600_000) + '{}');
    commitAll(root, 'oversized config');
    const before = await captureResolutionContextHashes(root, Object.keys(sourceHashes));
    await writeFile(path.join(root, 'sourcemap.json'), ' '.repeat(600_000) + '[]');
    expect(await detectIndexContentDrift(root, sourceHashes, coverage, before)).toEqual({
      kind: 'drifted',
      changed: ['sourcemap.json'],
      added: [],
      deleted: [],
    });
  });

  it('does not certify a legacy receipt or an unreadable context as current', async () => {
    expect(await detectIndexContentDrift(root, sourceHashes, coverage)).toEqual({
      kind: 'unmeasurable',
      reason: 'no-resolution-context-hashes',
    });
    const absent = await captureResolutionContextHashes(root, Object.keys(sourceHashes));
    await mkdir(path.join(root, 'sourcemap.json'));
    expect(await detectIndexContentDrift(root, sourceHashes, coverage, absent)).toEqual({
      kind: 'unmeasurable',
      reason: 'scan-failed',
    });
  });
});
