import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareLuauConfiguration } from '../../src/core/luau/configuration.js';

describe('Luau launch configuration', () => {
  let root: string;
  let project: string;
  let cache: string;
  let requests: string[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gitnexus-luau-config-')));
    project = path.join(root, 'game with spaces');
    cache = path.join(root, 'cache');
    await mkdir(project);
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        return new Response(url.endsWith('.json') ? '{}' : 'declare game: any\n');
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it('ports Serena Roblox defaults and encoded workspace identity', async () => {
    const config = await prepareLuauConfiguration({ projectPath: project, cachePath: cache });
    expect(config.command).toBe('luau-lsp');
    expect(config.args).toEqual([
      'lsp',
      `--definitions:@roblox=${path.join(cache, 'globalTypes.PluginSecurity.d.luau')}`,
      `--docs=${path.join(cache, 'en-us.json')}`,
    ]);
    expect(config.workspaceConfiguration).toEqual({ platform: { type: 'roblox' } });
    expect(config.initializationParams).toMatchObject({
      rootUri: pathToFileURL(project).href,
      rootPath: project,
      workspaceFolders: [{ uri: pathToFileURL(project).href, name: 'game with spaces' }],
      locale: 'en',
      initializationOptions: {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: true },
        },
      },
    });
    expect(requests).toEqual([
      'https://luau-lsp.pages.dev/type-definitions/globalTypes.PluginSecurity.d.luau',
      'https://luau-lsp.pages.dev/api-docs/en-us.json',
    ]);
  });

  it('uses standard docs without injecting Roblox definitions', async () => {
    const config = await prepareLuauConfiguration({
      projectPath: project,
      cachePath: cache,
      platform: 'standard',
    });
    expect(config.args).toEqual(['lsp', `--docs=${path.join(cache, 'luau-en-us.json')}`]);
    expect(config.workspaceConfiguration).toEqual({ platform: { type: 'standard' } });
    expect(requests).toEqual(['https://luau-lsp.pages.dev/api-docs/luau-en-us.json']);
  });

  it('keeps each Roblox security level in a separate cached file', async () => {
    await prepareLuauConfiguration({ projectPath: project, cachePath: cache });
    const config = await prepareLuauConfiguration({
      projectPath: project,
      cachePath: cache,
      securityLevel: 'None',
    });
    expect(config.args).toContain(
      `--definitions:@roblox=${path.join(cache, 'globalTypes.None.d.luau')}`,
    );
    expect(requests).toHaveLength(3);
    expect(requests[2]).toBe('https://luau-lsp.pages.dev/type-definitions/globalTypes.None.d.luau');
  });

  it('reuses cached support files offline', async () => {
    await prepareLuauConfiguration({ projectPath: project, cachePath: cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('offline');
      }),
    );
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache }),
    ).resolves.toMatchObject({ command: 'luau-lsp' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses explicit local assets and executable without network access', async () => {
    await writeFile(path.join(project, 'types.d.luau'), 'declare game: any\n');
    await writeFile(path.join(project, 'docs.json'), '{}');
    const config = await prepareLuauConfiguration({
      projectPath: project,
      cachePath: cache,
      serverPath: path.join(root, 'tools', 'luau lsp'),
      definitionsPath: 'types.d.luau',
      docsPath: 'docs.json',
    });
    expect(config.command).toBe(path.join(root, 'tools', 'luau lsp'));
    expect(config.args).toContain(`--definitions:@roblox=${path.join(project, 'types.d.luau')}`);
    expect(requests).toEqual([]);
  });

  it.each([
    [{ platform: 'lua' }, 'platform'],
    [{ securityLevel: '../unsafe' }, 'security level'],
    [{ platform: 'standard', definitionsPath: 'types.d.luau' }, 'Roblox'],
  ])('rejects invalid settings before downloading: %j', async (options, message) => {
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache, ...options }),
    ).rejects.toThrow(message);
    expect(requests).toEqual([]);
  });

  it('fails visibly on a download error without caching an error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache }),
    ).rejects.toThrow('503');
    expect(await readdir(cache)).toEqual([]);
  });

  it('follows the official same-origin definition redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        if (url.includes('/type-definitions/')) {
          return new Response(null, {
            status: 302,
            headers: { location: '/globalTypes.PluginSecurity.d.luau' },
          });
        }
        return new Response(url.endsWith('.json') ? '{}' : 'declare game: any\n');
      }),
    );
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache }),
    ).resolves.toMatchObject({ command: 'luau-lsp' });
    expect(requests).toEqual([
      'https://luau-lsp.pages.dev/type-definitions/globalTypes.PluginSecurity.d.luau',
      'https://luau-lsp.pages.dev/globalTypes.PluginSecurity.d.luau',
      'https://luau-lsp.pages.dev/api-docs/en-us.json',
    ]);
  });

  it('refuses a redirect away from the official HTTPS origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://other.example/types.luau' },
          }),
      ),
    );
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache }),
    ).rejects.toThrow('untrusted');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(cache)).toEqual([]);
  });

  it('bounds redirects without caching an incomplete download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: '/loop' } })),
    );
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache }),
    ).rejects.toThrow('redirect');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await readdir(cache)).toEqual([]);
  });

  it('rejects invalid API documentation instead of persisting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>error</html>')),
    );
    await expect(
      prepareLuauConfiguration({ projectPath: project, cachePath: cache, platform: 'standard' }),
    ).rejects.toThrow('JSON');
    expect(await readdir(cache)).toEqual([]);
  });

  it('does not overwrite explicit local assets', async () => {
    const definitions = path.join(project, 'types.d.luau');
    await writeFile(definitions, '-- user definitions\n');
    await expect(
      prepareLuauConfiguration({
        projectPath: project,
        cachePath: cache,
        definitionsPath: definitions,
        docsPath: 'missing.json',
      }),
    ).rejects.toThrow('missing.json');
    expect(await readFile(definitions, 'utf8')).toBe('-- user definitions\n');
    expect(requests).toEqual([]);
  });
});
