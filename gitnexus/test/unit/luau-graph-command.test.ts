import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

const fixture = fileURLToPath(new URL('../fixtures/luau-lsp/server.cjs', import.meta.url));

describe('luau-graph CLI', () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gitnexus-luau-cli-')));
    project = path.join(root, 'game with spaces');
    await mkdir(project);
    await writeFile(path.join(project, 'main.luau'), 'return {}\n');
    await writeFile(path.join(project, 'docs.json'), '{}');
    await writeFile(path.join(project, 'types.d.luau'), 'declare game: any\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(args: string[], cwd = project) {
    return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'luau-graph', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        GITNEXUS_HOME: path.join(root, 'home'),
        GITNEXUS_LANG: 'en',
        NO_UPDATE_NOTIFIER: '1',
      },
    });
  }

  it('documents the experimental export and configurable Roblox settings', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout.replace(/\s+/g, ' ')).toContain('does not update the index');
    expect(result.stdout).toContain('--security-level');
    expect(result.stdout).toContain('PluginSecurity');
    expect(result.stdout).toContain('--current-file');
    expect(result.stdout).toContain('--sourcemap');
  });

  it('rejects a seed outside the selected workspace before launching or downloading', async () => {
    const outside = path.join(root, 'outside.luau');
    await writeFile(outside, 'return {}\n');
    const result = run([outside, '--project', project, '--platform', 'standard']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('inside the Luau project');
  });

  it('requires a Roblox sourcemap instead of silently omitting instance dependencies', () => {
    const result = run(['main.luau']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('sourcemap.json');
    expect(result.stderr).toContain('rojo sourcemap');
  });

  it.each(['default', 'project-relative', 'absolute'])(
    'forwards the %s map through the CLI and LSP configuration',
    async (kind) => {
      const sourcemapFile = path.join(
        kind === 'absolute' ? root : project,
        kind === 'default' ? 'sourcemap.json' : 'dev.sourcemap.json',
      );
      await writeFile(path.join(project, 'sourcemap.json'), '[]');
      await writeFile(sourcemapFile, '{"name":"SyntheticGame","className":"DataModel"}');
      await writeFile(path.join(project, 'Café.luau'), 'return "café"\n');
      // Node runs this synthetic server entry from the selected project directory.
      // The protocol fixture verifies the actual workspace/configuration response.
      await writeFile(
        path.join(project, 'lsp'),
        `process.argv = ${JSON.stringify([process.execPath, fixture, 'sourcemap', project, sourcemapFile])};\nrequire(${JSON.stringify(fixture)});\n`,
      );
      const selectedMap = kind === 'absolute' ? sourcemapFile : 'dev.sourcemap.json';
      const result = run(
        [
          'Café.luau',
          '--project',
          project,
          '--server',
          process.execPath,
          '--definitions',
          'types.d.luau',
          '--docs',
          'docs.json',
          ...(kind === 'default' ? [] : ['--sourcemap', selectedMap]),
        ],
        root,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('digraph luau_require_graph { Café -> Entrée; }\n');
    },
  );

  it('rejects a missing selected map even when the default map exists', async () => {
    await writeFile(path.join(project, 'sourcemap.json'), '{}');
    const result = run([
      'main.luau',
      '--sourcemap',
      'missing-map.json',
      '--definitions',
      'types.d.luau',
      '--docs',
      'docs.json',
      '--server',
      path.join(root, 'must-not-start'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing-map.json');
    expect(result.stderr).not.toContain('must-not-start');
  });

  it('validates the default map JSON before launching the server', async () => {
    await writeFile(path.join(project, 'sourcemap.json'), '[]');
    const result = run([
      'main.luau',
      '--definitions',
      'types.d.luau',
      '--docs',
      'docs.json',
      '--server',
      path.join(root, 'must-not-start'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/sourcemap.*JSON/i);
    expect(result.stderr).not.toContain('must-not-start');
  });

  it('rejects a Roblox sourcemap for the standard platform', () => {
    const result = run(['main.luau', '--platform', 'standard', '--sourcemap', 'dev.json']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--platform roblox');
  });

  it('reports an unavailable installed server with nonzero status and clean stdout', () => {
    const result = run([
      'main.luau',
      '--platform',
      'standard',
      '--docs',
      'docs.json',
      '--server',
      path.join(root, 'missing-luau-lsp'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing-luau-lsp');
  });

  it('rejects an invalid platform before fetching support files', () => {
    const result = run(['main.luau', '--platform', 'lua']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported Luau platform');
  });

  it('rejects an invalid timeout before launching a server', () => {
    const result = run(['main.luau', '--timeout', '1e3']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--timeout must be a positive integer');
  });
});
