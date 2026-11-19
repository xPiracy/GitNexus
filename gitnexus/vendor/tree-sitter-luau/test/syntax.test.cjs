const assert = require('node:assert/strict');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const Parser = require('tree-sitter');
const language = require('..');
const fixtures = require('./syntax-fixtures.json');

function makeParser() {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

for (const fixture of fixtures) {
  test(`${fixture.expected}: ${fixture.name}`, () => {
    const tree = makeParser().parse(fixture.source);
    assert.equal(tree.rootNode.hasError, fixture.expected !== 'valid', tree.rootNode.toString());
  });
}

test('function bodies remain distinct from type signatures', () => {
  const source = 'type F = (number) -> number; local function outer() '
    + 'local callback = function() end; return callback end; '
    + 'function object:method() end; type function identity(t) return t end';
  const root = makeParser().parse(source).rootNode;
  assert.equal(root.hasError, false);
  const kinds = new Set(['fn_stmt', 'local_fn_stmt', 'anon_fn', 'type_fn_stmt']);
  const stack = [root];
  const bodies = [];
  while (stack.length) {
    const node = stack.pop();
    if (kinds.has(node.type)) bodies.push(node);
    stack.push(...node.namedChildren);
  }
  assert.equal(bodies.length, 4);
  for (const node of bodies) {
    assert.equal(node.children.filter(child => child.type === 'function').length, 1);
  }
});

test('Node string offsets and columns use UTF-16, including CRLF', () => {
  const source = 'local text = "😀é"; local function first() end\r\nlocal function second() end';
  const root = makeParser().parse(source).rootNode;
  assert.equal(root.hasError, false);
  const functions = root.namedChildren.filter(node => node.type === 'local_fn_stmt');
  const keyword = functions[0].children.find(node => node.type === 'function');
  assert.equal(keyword.startIndex, source.indexOf('function'));
  assert.equal(keyword.startPosition.column, keyword.startIndex);
  assert.notEqual(keyword.startIndex, Buffer.byteLength(source.slice(0, keyword.startIndex)));
  assert.deepEqual(functions[1].startPosition, {row: 1, column: 0});
  assert.equal(functions[1].text, 'local function second() end');
});

test('scanner handles long identifiers and unsigned delimiter depths', () => {
  for (const length of [255, 256, 512, 4096]) {
    const name = 'a'.repeat(length);
    assert.equal(makeParser().parse(`local ${name} = 1; return ${name}`).rootNode.hasError, false);
  }
  for (const depth of [127, 128, 160, 255, 256, 300]) {
    const delimiter = '='.repeat(depth);
    for (const source of [
      `--[${delimiter}[ comment ]${delimiter}]\nlocal function value() end`,
      `local text = [${delimiter}[ string ]${delimiter}]\nlocal function value() end`,
    ]) {
      assert.equal(makeParser().parse(source).rootNode.hasError, false);
    }
  }
});

test('reused parser recovers after incomplete input', () => {
  const parser = makeParser();
  for (const source of ['--[=[ unfinished', 'local s = `text {', 'local s = "unfinished', 'local function f(']) {
    assert.equal(parser.parse(source).rootNode.hasError, true);
    assert.equal(parser.parse('local function complete() return 1 end').rootNode.hasError, false);
  }
});

test('incremental edits match a fresh parse across Unicode strings', () => {
  const parser = makeParser();
  const before = 'local value = [=[alpha]=]\nlocal function f() return value end';
  const start = before.indexOf('alpha');
  const replacement = 'β😀';
  const after = before.slice(0, start) + replacement + before.slice(start + 5);
  const oldTree = parser.parse(before);
  oldTree.edit({startIndex: start, oldEndIndex: start + 5, newEndIndex: start + replacement.length,
    startPosition: {row: 0, column: start}, oldEndPosition: {row: 0, column: start + 5},
    newEndPosition: {row: 0, column: start + replacement.length}});
  const incremental = parser.parse(after, oldTree);
  const fresh = makeParser().parse(after);
  assert.equal(incremental.rootNode.hasError, false);
  assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
  assert.equal(incremental.rootNode.endIndex, after.length);
});

test('independent worker parsers share no string-handler state', async () => {
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Parser = require(workerData.runtime);
    const parser = new Parser(); parser.setLanguage(require(workerData.language));
    for (let i=0; i<200; i++) {
      for (const source of workerData.sources) {
        if (parser.parse(source).rootNode.hasError) throw new Error('Unexpected parse error');
      }
    }
    parentPort.postMessage('ok');
  `;
  const sources = ['local s = "plain"', 'local s = `hello {1 + 2}`', 'local s = [=[long]=]'];
  await Promise.all(Array.from({length: 4}, () => new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {eval: true, workerData: {
      runtime: require.resolve('tree-sitter'), language: require.resolve('..'), sources,
    }});
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
  })));
});
