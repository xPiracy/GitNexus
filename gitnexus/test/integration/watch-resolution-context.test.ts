import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWatchFileLoop, type WatchFileLoop } from '../../src/cli/analyze-watch.js';
import { WATCH_FULL_REFRESH_PATH } from '../../src/cli/watch-queue.js';

const loops: WatchFileLoop[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function fixture(withSource: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-context-'));
  directories.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, '.gitignore'), 'sourcemap.json\nsourcemap.json.tmp\n');
  if (withSource) await writeFile(path.join(root, 'main.luau'), 'return 1\n');
  return root;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Resolution context event was not observed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('watching provider-declared resolution inputs', () => {
  it('catches up when a config reload admits the first provider source during refresh', async () => {
    const root = await fixture(true);
    vi.stubEnv('GITNEXUS_MAX_FILE_SIZE', '1');
    await writeFile(path.join(root, 'main.luau'), 'return 1\n' + ' '.repeat(1_100));
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      root,
      25,
      async (paths) => {
        batches.push([...paths]);
        // The command reloads its source-size policy inside this callback.
        if (paths.includes('.gitnexusrc')) process.env.GITNEXUS_MAX_FILE_SIZE = '2';
      },
      (error) => {
        throw error;
      },
    );
    loops.push(loop);
    await writeFile(path.join(root, '.gitnexusrc'), '{"maxFileSize":"2"}');
    await waitFor(() => batches.flat().includes(WATCH_FULL_REFRESH_PATH));
    await writeFile(path.join(root, 'sourcemap.json'), 'newly consumed input');
    await waitFor(() => batches.flat().includes('sourcemap.json'));
  });

  it('observes ignored creation, edits, atomic replacement, deletion, recreation, then closes', async () => {
    const root = await fixture(true);
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      root,
      25,
      async (paths) => {
        batches.push([...paths]);
      },
      (error) => {
        throw error;
      },
    );
    loops.push(loop);
    const map = path.join(root, 'sourcemap.json');
    const count = () => batches.filter((batch) => batch.includes('sourcemap.json')).length;
    expect(batches).toEqual([[]]);
    await writeFile(map, 'one');
    await waitFor(() => count() >= 1);
    await writeFile(map, 'two');
    await waitFor(() => count() >= 2);
    await writeFile(`${map}.tmp`, 'three');
    await rename(`${map}.tmp`, map);
    await waitFor(() => count() >= 3);
    await rm(map);
    await waitFor(() => count() >= 4);
    await writeFile(map, 'four');
    await waitFor(() => count() >= 5);
    await loop.waitForIdle();
    await loop.close();
    loops.pop();
    const closedCount = batches.length;
    await writeFile(map, 'after close');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(batches).toHaveLength(closedCount);
  });

  it('starts and stops context polling as the first/last provider source enters or leaves', async () => {
    const root = await fixture(false);
    const batches: string[][] = [];
    const loop = await startWatchFileLoop(
      root,
      25,
      async (paths) => {
        batches.push([...paths]);
      },
      (error) => {
        throw error;
      },
    );
    loops.push(loop);
    const map = path.join(root, 'sourcemap.json');
    await writeFile(map, 'before provider');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(batches).toEqual([[]]);
    await writeFile(path.join(root, 'main.luau'), 'return 1\n');
    await waitFor(() => batches.flat().includes('main.luau'));
    await writeFile(map, 'active provider');
    await waitFor(() => batches.flat().includes('sourcemap.json'));
    await rm(path.join(root, 'main.luau'));
    await waitFor(() => batches.flat().filter((file) => file === 'main.luau').length >= 2);
    await loop.waitForIdle();
    const count = batches.length;
    await writeFile(map, 'after provider');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(batches).toHaveLength(count);
  });
});
