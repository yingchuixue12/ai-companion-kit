import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('scanner warns with filenames and labels without printing the matched values', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-check-scanner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'scripts', 'check.mjs');
  const lib = path.join(root, 'packages', 'companion', 'src');
  fs.mkdirSync(path.dirname(script));
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('./check.mjs', import.meta.url), script);
  const actualLib = new URL('../packages/companion/src/lib.js', import.meta.url).href;
  fs.writeFileSync(path.join(lib, 'lib.js'), `export * from ${JSON.stringify(actualLib)};`);

  const localPath = ['Z:', 'Users', 'synthetic-operator', 'notes.txt'].join('\\');
  const account = '0'.repeat(10);
  const key = 'sk-' + 'X'.repeat(24);
  fs.writeFileSync(path.join(root, 'ordinary.txt'), '只是有些疑问。');
  fs.writeFileSync(path.join(root, 'shapes.txt'), [localPath, account, key].join('\n'));

  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => assert.fail(`scanner exited with ${code}`));
  await import(pathToFileURL(script).href);

  const text = output.join('\n');
  assert.doesNotMatch(text, /ordinary\.txt.*命中/);
  for (const label of ['疑似本机绝对路径', '疑似 QQ 号（10~11 位数字）', '疑似 API key']) {
    assert.ok(output.some((line) => line.endsWith(`shapes.txt 命中「${label}」`)), label);
  }
  assert.match(text, /失败 0 · 警告 3/);
  for (const match of [localPath, account, key]) {
    assert.ok(!text.includes(match), 'scanner printed a matched value');
  }
});
