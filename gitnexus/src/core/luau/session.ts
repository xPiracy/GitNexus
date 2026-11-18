import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  type Message,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';

export interface LuauRequireGraphOptions {
  projectPath: string;
  filePath: string;
  command: string;
  args: readonly string[];
  workspaceConfiguration: { platform: { type: 'roblox' | 'standard' } };
  initializationParams: Record<string, unknown>;
  currentFile?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 500;

class LuauMessageWriter extends StreamMessageWriter {
  constructor(
    stream: NodeJS.WritableStream,
    private readonly reportError: (error: Error) => void,
  ) {
    super(stream);
  }

  override async write(message: Message): Promise<void> {
    // vscode-jsonrpc 8.2.1 rethrows request write failures from an async Promise
    // executor. Report them to the session so a closed pipe cannot crash the CLI.
    await super.write(message).catch(this.reportError);
  }
}

async function untilAborted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, work()]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Run one native Luau LSP session against an on-disk worktree. */
export async function exportLuauRequireGraph(options: LuauRequireGraphOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  try {
    const result = await runSession(options, signal);
    // The session waits for process cleanup after receiving the graph.
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted && (error === signal.reason || (error as Error)?.cause === signal.reason)) {
      if (signal.reason === deadline.reason) {
        throw new Error(`Luau require graph export timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      signal.throwIfAborted();
    }
    throw error;
  }
}

async function runSession(options: LuauRequireGraphOptions, signal: AbortSignal): Promise<string> {
  const text = await readFile(options.filePath, { encoding: 'utf8', signal });
  signal.throwIfAborted();
  const uri = pathToFileURL(options.filePath).href;
  const child = spawn(options.command, options.args, {
    cwd: options.projectPath,
    shell: false,
    stdio: 'pipe',
    windowsHide: true,
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let reportError: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    reportError = resolve;
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new LuauMessageWriter(child.stdin, (error) => reportError(error)),
  );

  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  let finished = false;
  const closed = new Promise<Error>((resolve) => {
    child.once('close', (code, exitSignal) => {
      finished = true;
      const detail = stderr.trim();
      resolve(
        new Error(
          `Luau language server exited (${exitSignal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });

  connection.onRequest('workspace/configuration', (params: { items: unknown[] }) =>
    params.items.map(() => options.workspaceConfiguration),
  );
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('window/workDoneProgress/create', () => null);
  connection.onNotification('window/showMessage', (params: { type: number; message: string }) => {
    if (params.type === 1 || params.type === 2) {
      reportError(new Error(`Luau language server reported: ${params.message}`));
    }
  });
  connection.listen();

  let initialized = false;
  async function requestGraph(): Promise<string> {
    await spawned;
    signal.throwIfAborted();
    await connection.sendRequest('initialize', options.initializationParams);
    signal.throwIfAborted();
    await connection.sendNotification('initialized', {});
    initialized = true;

    // Luau LSP queues these messages until workspace configuration arrives.
    // didOpen initializes and indexes the workspace before the graph request runs.
    await connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'luau', version: 1, text },
    });
    signal.throwIfAborted();
    const dot = await connection.sendRequest<unknown>('luau-lsp/requireGraph', {
      textDocument: { uri },
      fromTextDocumentOnly: options.currentFile ?? false,
    });
    if (typeof dot !== 'string') {
      throw new Error('Luau language server returned an invalid require graph');
    }
    return dot;
  }

  try {
    return await untilAborted(signal, () =>
      Promise.race([
        requestGraph(),
        Promise.race([closed, failure]).then((error) => {
          throw error;
        }),
      ]),
    );
  } finally {
    if (initialized && !finished) {
      try {
        await untilAborted(AbortSignal.timeout(EXIT_TIMEOUT_MS), async () => {
          await connection.sendRequest('shutdown');
          await connection.sendNotification('exit');
          await closed;
        });
      } catch {
        // A server blocked on a request may also ignore shutdown.
      }
    }
    connection.dispose();
    if (!finished) {
      child.kill('SIGKILL');
      try {
        await untilAborted(AbortSignal.timeout(EXIT_TIMEOUT_MS), () => closed);
      } catch {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    }
  }
}
