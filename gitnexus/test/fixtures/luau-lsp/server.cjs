const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} = require('vscode-jsonrpc/node');

const [, , mode, projectPath, sourcemapFile] = process.argv;
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const file = path.join(projectPath, 'Café.luau');
const uri = pathToFileURL(file).href;
let configuration;
let opened;
let shutDown = false;

connection.onRequest('initialize', (params) => {
  assert.equal(process.cwd(), projectPath);
  assert.equal(params.rootUri, pathToFileURL(projectPath).href);
  assert.equal(params.capabilities.workspace.configuration, true);
  return { capabilities: { textDocumentSync: 1 } };
});

connection.onNotification('initialized', () => {
  configuration = connection.sendRequest('workspace/configuration', {
    items: [{ section: 'luau-lsp' }, { section: 'luau-lsp', scopeUri: uri }],
  });
});

connection.onNotification('textDocument/didOpen', (params) => {
  opened = params.textDocument;
});

connection.onRequest('luau-lsp/requireGraph', async (params) => {
  const expectedConfiguration = {
    platform: { type: 'roblox' },
    ...(sourcemapFile ? { sourcemap: { sourcemapFile } } : {}),
  };
  assert.deepEqual(await configuration, [
    expectedConfiguration,
    expectedConfiguration,
  ]);
  assert.deepEqual(opened, {
    uri,
    languageId: 'luau',
    version: 1,
    text: 'return "café"\n',
  });
  assert.deepEqual(params, {
    textDocument: { uri },
    fromTextDocumentOnly: mode === 'current-file',
  });

  if (mode === 'hang' || mode === 'unresponsive') {
    fs.writeFileSync(path.join(projectPath, 'server.pid'), String(process.pid));
    return new Promise(() => {});
  }
  if (mode === 'crash') {
    process.stderr.write('language server crashed\n');
    process.exit(23);
  }
  if (mode === 'warning') {
    await connection.sendNotification('window/showMessage', {
      type: 2,
      message: 'Workspace indexing reached its configured file limit',
    });
  }
  if (mode === 'error') throw new ResponseError(-32803, 'Seed file could not be parsed');
  return 'digraph luau_require_graph { Café -> Entrée; }\n';
});

connection.onRequest('shutdown', () => {
  if (mode === 'unresponsive') return new Promise(() => {});
  if (mode === 'stall-shutdown') {
    fs.writeFileSync(path.join(projectPath, 'server.pid'), String(process.pid));
    return new Promise(() => {});
  }
  shutDown = true;
  return null;
});

connection.onNotification('exit', () => {
  assert.equal(shutDown, true);
  fs.writeFileSync(path.join(projectPath, 'server.exited'), 'yes');
  process.exit(0);
});

connection.listen();
