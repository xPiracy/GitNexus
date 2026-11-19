import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getProviderForFile } = vi.hoisted(() => ({ getProviderForFile: vi.fn() }));
vi.mock('../../src/core/ingestion/languages/index.js', () => ({ getProviderForFile }));

import {
  captureResolutionContextHashes,
  diffResolutionContextHashes,
} from '../../src/core/incremental/resolution-context-hashes.js';

let root: string;
const sourceFiles = ['src/main.fixture', 'src/helper.fixture'];
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-resolution-input-'));
  const provider = { id: 'fixture', resolutionContextFiles: ['project-map.json'] };
  getProviderForFile.mockImplementation((filePath: string) =>
    filePath.endsWith('.fixture') ? provider : undefined,
  );
});

afterEach(async () => {
  getProviderForFile.mockReset();
  await rm(root, { recursive: true, force: true });
});

describe('resolution context hashes', () => {
  it('hashes declared ignored and oversized inputs absent from the source scan', async () => {
    const contents = '{"padding":"' + 'x'.repeat(600_000) + '"}';
    await writeFile(path.join(root, '.gitignore'), 'project-map.json\n');
    await writeFile(path.join(root, 'project-map.json'), contents);
    expect(await captureResolutionContextHashes(root, sourceFiles)).toEqual({
      'project-map.json': digest(contents),
    });
  });

  it('records absence and detects creation, content changes, deletion, and recreation', async () => {
    const missing = await captureResolutionContextHashes(root, sourceFiles);
    expect(missing).toEqual({ 'project-map.json': null });
    await writeFile(path.join(root, 'project-map.json'), 'first');
    const added = await captureResolutionContextHashes(root, sourceFiles);
    await writeFile(path.join(root, 'project-map.json'), 'second');
    const changed = await captureResolutionContextHashes(root, sourceFiles);
    await rm(path.join(root, 'project-map.json'));
    const deleted = await captureResolutionContextHashes(root, sourceFiles);
    await writeFile(path.join(root, 'project-map.json'), 'first');
    const recreated = await captureResolutionContextHashes(root, sourceFiles);
    for (const [current, previous] of [
      [added, missing],
      [changed, added],
      [deleted, changed],
      [recreated, deleted],
    ]) {
      expect(diffResolutionContextHashes(current!, previous)).toEqual(['project-map.json']);
    }
    expect(diffResolutionContextHashes(recreated, added)).toEqual([]);
  });

  it('treats a missing receipt as unknown even when the declared file is absent', async () => {
    const current = await captureResolutionContextHashes(root, sourceFiles);
    expect(diffResolutionContextHashes(current, undefined)).toEqual(['project-map.json']);
    expect(diffResolutionContextHashes(current, current)).toEqual([]);
    expect(diffResolutionContextHashes({}, undefined)).toEqual([]);
  });

  it('only reads declarations from represented providers, never metadata keys', async () => {
    await mkdir(path.join(root, 'project-map.json'));
    expect(await captureResolutionContextHashes(root, ['README.md'])).toEqual({});
    expect(diffResolutionContextHashes({}, { 'removed.config': 'old' })).toEqual([
      'removed.config',
    ]);
  });

  it('rejects non-file inputs instead of certifying them as absent', async () => {
    await mkdir(path.join(root, 'project-map.json'));
    await expect(captureResolutionContextHashes(root, sourceFiles)).rejects.toThrow(/regular file/);
  });

  it.each([
    '../outside.json',
    '/absolute.json',
    'C:\\absolute.json',
    'C:relative.json',
    'dir/../map.json',
    '',
  ])('rejects a noncanonical declaration %j before reading it', async (contextPath) => {
    getProviderForFile.mockReturnValue({ id: 'fixture', resolutionContextFiles: [contextPath] });
    await expect(captureResolutionContextHashes(root, sourceFiles)).rejects.toThrow(
      /repo-relative/,
    );
  });

  it('allows hidden config paths and normalizes declared separators', async () => {
    await mkdir(path.join(root, '.config'));
    await writeFile(path.join(root, '.config', 'project.json'), '{}');
    getProviderForFile.mockReturnValue({
      id: 'fixture',
      resolutionContextFiles: ['.config\\project.json', '.config/project.json'],
    });
    expect(await captureResolutionContextHashes(root, sourceFiles)).toEqual({
      '.config/project.json': digest('{}'),
    });
  });
});
