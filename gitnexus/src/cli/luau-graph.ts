import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareLuauConfiguration } from '../core/luau/configuration.js';
import { exportLuauRequireGraph } from '../core/luau/session.js';
import { parseIntegerOption } from './int-option.js';

interface LuauGraphOptions {
  project?: string;
  server?: string;
  platform?: string;
  securityLevel?: string;
  definitions?: string;
  docs?: string;
  currentFile?: boolean;
  timeout?: string;
}

/** Experimental export only: no language registry or native index mutation. */
export async function luauGraphCommand(file: string, options: LuauGraphOptions): Promise<void> {
  const controller = new AbortController();
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  const onInterrupt = () => {
    interrupted = 'SIGINT';
    controller.abort(new Error('Luau graph export interrupted'));
  };
  const onTerminate = () => {
    interrupted = 'SIGTERM';
    controller.abort(new Error('Luau graph export terminated'));
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    const timeoutMs =
      parseIntegerOption(options.timeout ?? '60', '--timeout', {
        minimum: 1,
        scale: 1000,
      }) * 1000;
    if (timeoutMs > 2_147_483_647) throw new Error('--timeout is too large');
    const projectPath = await realpath(options.project ?? process.cwd());
    const filePath = await realpath(path.resolve(projectPath, file));
    const relativeFile = path.relative(projectPath, filePath);
    // realpath closes symlink escapes; isAbsolute also rejects Windows cross-drive paths.
    if (
      relativeFile === '..' ||
      relativeFile.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeFile)
    ) {
      throw new Error(
        'The seed file must be inside the Luau project. Use --project to select its workspace.',
      );
    }
    if (!(await stat(filePath)).isFile() || !/\.(lua|luau)$/i.test(filePath)) {
      throw new Error('The seed must be a .luau or .lua file.');
    }
    if ((options.platform ?? 'roblox') === 'roblox') {
      // Without this mapping, script.Parent/game service requires can silently disappear.
      const sourcemap = path.join(projectPath, 'sourcemap.json');
      const info = await stat(sourcemap).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!info?.isFile()) {
        throw new Error(
          'Roblox export requires sourcemap.json in the project root. Generate it with rojo sourcemap --include-non-scripts default.project.json --output sourcemap.json.',
        );
      }
    }
    const configuration = await prepareLuauConfiguration({
      projectPath,
      serverPath: options.server,
      platform: options.platform,
      securityLevel: options.securityLevel,
      definitionsPath: options.definitions,
      docsPath: options.docs,
      signal: controller.signal,
    });
    const graph = await exportLuauRequireGraph({
      ...configuration,
      filePath,
      currentFile: options.currentFile,
      timeoutMs,
      signal: controller.signal,
    });
    // Only emit after successful completion; failures never leave a partial DOT document.
    process.stdout.write(graph.endsWith('\n') ? graph : `${graph}\n`);
  } catch (error) {
    process.stderr.write(
      `Luau graph export failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
