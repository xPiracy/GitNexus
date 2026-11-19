import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportLuauRequireGraph } from '../../src/core/luau/session.js';

const fixture = fileURLToPath(new URL('../fixtures/luau-lsp/server.cjs', import.meta.url));

describe('Luau require graph session', () => {
  let projectPath: string;
  let filePath: string;

  beforeEach(async () => {
    projectPath = await realpath(await mkdtemp(path.join(tmpdir(), 'gitnexus-luau-')));
    filePath = path.join(projectPath, 'Café.luau');
    await writeFile(filePath, 'return "café"\n');
  });

  afterEach(async () => {
    await rm(projectPath, { force: true, recursive: true });
  });

  function options(mode: string) {
    return {
      projectPath,
      filePath,
      command: process.execPath,
      args: [fixture, mode, projectPath],
      workspaceConfiguration: { platform: { type: 'roblox' as const } },
      initializationParams: {
        rootUri: pathToFileURL(projectPath).href,
        capabilities: { workspace: { configuration: true } },
      },
    };
  }

  it.each([
    ['workspace', undefined],
    ['current-file', true],
  ] as const)(
    'exports UTF-8 DOT in %s mode and gracefully closes the server',
    async (mode, currentFile) => {
      await expect(exportLuauRequireGraph({ ...options(mode), currentFile })).resolves.toBe(
        'digraph luau_require_graph { Café -> Entrée; }\n',
      );
      await expect(readFile(path.join(projectPath, 'server.exited'), 'utf8')).resolves.toBe('yes');
    },
  );

  it('reports an LSP graph request error and gracefully closes the server', async () => {
    await expect(exportLuauRequireGraph(options('error'))).rejects.toThrow(/could not be parsed/);
    await expect(readFile(path.join(projectPath, 'server.exited'), 'utf8')).resolves.toBe('yes');
  });

  it('times out an unresponsive server and closes its process', async () => {
    await expect(
      exportLuauRequireGraph({ ...options('unresponsive'), timeoutMs: 1200 }),
    ).rejects.toThrow(/timed out/i);
    const pid = Number(await readFile(path.join(projectPath, 'server.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('cancels an in-flight graph export and closes its process', async () => {
    const controller = new AbortController();
    const rejected = expect(
      exportLuauRequireGraph({ ...options('hang'), signal: controller.signal }),
    ).rejects.toThrow('stop graph export');
    const pid = await vi.waitFor(async () =>
      Number(await readFile(path.join(projectPath, 'server.pid'), 'utf8')),
    );

    controller.abort(new Error('stop graph export'));
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('discards the graph if cancelled during server shutdown', async () => {
    const controller = new AbortController();
    const exportResult = exportLuauRequireGraph({
      ...options('stall-shutdown'),
      signal: controller.signal,
    });
    const pid = await vi.waitFor(async () => {
      const serverPid = Number(await readFile(path.join(projectPath, 'server.pid'), 'utf8'));
      expect(serverPid).toBeGreaterThan(0);
      return serverPid;
    });

    controller.abort(new Error('stop during shutdown'));
    await expect(exportResult).rejects.toThrow('stop during shutdown');
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports when the configured executable cannot start', async () => {
    await expect(
      exportLuauRequireGraph({
        ...options('workspace'),
        command: path.join(projectPath, 'missing'),
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('reports a server crash with the exit code and diagnostics', async () => {
    await expect(exportLuauRequireGraph(options('crash'))).rejects.toThrow(
      /code 23.*language server crashed/,
    );
  });

  it('fails the export if Luau LSP warns that the graph is partial', async () => {
    await expect(exportLuauRequireGraph(options('warning'))).rejects.toThrow(/file limit/);
    await expect(readFile(path.join(projectPath, 'server.exited'), 'utf8')).resolves.toBe('yes');
  });
});
