/*
 * Luau settings adapted from Serena's SolidLSP luau_lsp.py at
 * e14b02501da872394ada13f0b3f941056d462eee (MIT).
 * https://github.com/oraios/serena/blob/e14b02501da872394ada13f0b3f941056d462eee/src/solidlsp/language_servers/luau_lsp.py
 *
 * Copyright (c) 2025-2026 Jain & Panchenko IT-Berater Partnerschaft
 * (Oraios AI) and contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getGlobalDir } from '../../storage/global-dir.js';

export type LuauPlatform = 'roblox' | 'standard';
type RobloxSecurityLevel = 'None' | 'PluginSecurity' | 'LocalUserSecurity' | 'RobloxScriptSecurity';

const SECURITY_LEVELS: readonly string[] = [
  'None',
  'PluginSecurity',
  'LocalUserSecurity',
  'RobloxScriptSecurity',
];
const SUPPORT_ORIGIN = 'https://luau-lsp.pages.dev';
const MAX_SUPPORT_BYTES = 20 * 1024 * 1024;

export interface LuauConfigurationOptions {
  projectPath: string;
  serverPath?: string;
  platform?: string;
  securityLevel?: string;
  definitionsPath?: string;
  docsPath?: string;
  /** Defaults to the existing GitNexus home, never the game checkout. */
  cachePath?: string;
  signal?: AbortSignal;
}

export interface LuauLaunchConfiguration {
  projectPath: string;
  command: string;
  args: string[];
  workspaceConfiguration: { platform: { type: LuauPlatform } };
  initializationParams: Record<string, unknown>;
}

/** Keep the upstream capability shape so later symbol/navigation work can reuse it. */
function initializationParams(projectPath: string): Record<string, unknown> {
  const uri = pathToFileURL(projectPath).href;
  const symbolKinds = Array.from({ length: 26 }, (_, index) => index + 1);
  return {
    processId: process.pid,
    rootPath: projectPath,
    rootUri: uri,
    clientInfo: { name: 'gitnexus' },
    workspaceFolders: [{ uri, name: path.basename(projectPath) }],
    locale: 'en',
    capabilities: {
      textDocument: {
        synchronization: { didSave: true, dynamicRegistration: true },
        definition: { dynamicRegistration: true },
        references: { dynamicRegistration: true },
        documentSymbol: {
          dynamicRegistration: true,
          hierarchicalDocumentSymbolSupport: true,
          symbolKind: { valueSet: symbolKinds },
        },
        completion: {
          dynamicRegistration: true,
          completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            deprecatedSupport: true,
            preselectSupport: true,
          },
        },
        hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
        signatureHelp: {
          dynamicRegistration: true,
          signatureInformation: {
            documentationFormat: ['markdown', 'plaintext'],
            parameterInformation: { labelOffsetSupport: true },
          },
        },
        rename: { dynamicRegistration: true, prepareSupport: true },
        callHierarchy: { dynamicRegistration: true },
      },
      workspace: {
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: true },
        configuration: true,
        symbol: { dynamicRegistration: true, symbolKind: { valueSet: symbolKinds } },
      },
    },
    initializationOptions: {},
  };
}

/** Validate support files before launching, so an HTTP error never becomes cached input. */
function validateSupport(contents: Buffer, filePath: string): void {
  if (contents.length === 0 || contents.length > MAX_SUPPORT_BYTES) {
    throw new Error(`Luau support file must contain 1–${MAX_SUPPORT_BYTES} bytes: ${filePath}`);
  }
  if (filePath.endsWith('.json')) {
    try {
      const value: unknown = JSON.parse(contents.toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected an object');
      }
    } catch {
      throw new Error(`Invalid Luau API documentation JSON: ${filePath}`);
    }
  }
}

async function localSupport(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_SUPPORT_BYTES) {
    throw new Error(`Invalid Luau support file: ${filePath}`);
  }
  validateSupport(await readFile(filePath), filePath);
  return filePath;
}

async function fetchSupport(relativeUrl: string, signal: AbortSignal): Promise<Response> {
  let url = new URL(relativeUrl, `${SUPPORT_ORIGIN}/`);
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url.href, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 3) {
      throw new Error(`Invalid or excessive Luau support redirect: ${relativeUrl}`);
    }
    const next = new URL(location, url);
    // The official definitions endpoint redirects within this origin. Validate
    // each hop before requesting it, preserving SolidLSP's allowed-host boundary.
    if (next.origin !== SUPPORT_ORIGIN || next.username || next.password) {
      throw new Error('Luau support download redirected to an untrusted origin');
    }
    url = next;
  }
}

async function cachedSupport(
  cachePath: string,
  relativeUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const destination = path.join(cachePath, path.basename(relativeUrl));
  try {
    return await localSupport(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(cachePath, { recursive: true });
  // A stalled CDN must not leave an agent waiting indefinitely.
  const downloadSignal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(signal ? [signal] : []),
  ]);
  const response = await fetchSupport(relativeUrl, downloadSignal);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cannot download Luau support file ${relativeUrl}: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error(`Empty Luau support response: ${relativeUrl}`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SUPPORT_BYTES)
        throw new Error(`Luau support file is too large: ${relativeUrl}`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const contents = Buffer.concat(chunks);
  validateSupport(contents, destination);
  downloadSignal.throwIfAborted();

  // Publish only a complete file. Concurrent invocations use separate temp files.
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

/** Port the SolidLSP Roblox defaults without importing Serena or starting Python. */
export async function prepareLuauConfiguration(
  options: LuauConfigurationOptions,
): Promise<LuauLaunchConfiguration> {
  options.signal?.throwIfAborted();
  const platform = options.platform ?? 'roblox';
  if (platform !== 'roblox' && platform !== 'standard') {
    throw new Error(`Unsupported Luau platform: ${platform}. Expected roblox or standard.`);
  }
  const securityLevel = options.securityLevel ?? 'PluginSecurity';
  if (!SECURITY_LEVELS.includes(securityLevel)) {
    throw new Error(
      `Unsupported Roblox security level: ${securityLevel}. Expected ${SECURITY_LEVELS.join(', ')}.`,
    );
  }
  if (platform === 'standard' && options.definitionsPath !== undefined) {
    throw new Error('--definitions supplies Roblox types and requires --platform roblox.');
  }
  const projectPath = await realpath(options.projectPath);
  if (!(await stat(projectPath)).isDirectory()) {
    throw new Error(`Luau project must be a directory: ${projectPath}`);
  }
  const cachePath = path.resolve(options.cachePath ?? path.join(getGlobalDir(), 'luau-lsp'));
  const args = ['lsp'];
  if (platform === 'roblox') {
    const definitions = options.definitionsPath
      ? await localSupport(path.resolve(projectPath, options.definitionsPath))
      : await cachedSupport(
          cachePath,
          `type-definitions/globalTypes.${securityLevel as RobloxSecurityLevel}.d.luau`,
          options.signal,
        );
    args.push(`--definitions:@roblox=${definitions}`);
  }
  const docs = options.docsPath
    ? await localSupport(path.resolve(projectPath, options.docsPath))
    : await cachedSupport(
        cachePath,
        `api-docs/${platform === 'roblox' ? 'en-us' : 'luau-en-us'}.json`,
        options.signal,
      );
  args.push(`--docs=${docs}`);

  return {
    projectPath,
    // Bare executable names use PATH; explicit relative paths are relative to cwd.
    command:
      options.serverPath && /[/\\]/.test(options.serverPath)
        ? path.resolve(options.serverPath)
        : (options.serverPath ?? 'luau-lsp'),
    args,
    workspaceConfiguration: { platform: { type: platform } },
    initializationParams: initializationParams(projectPath),
  };
}
