import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { handoffURL, readerJobURL, readerPendingURL } from '../extension/lib.mjs';
import { buildZip, packageExtension } from '../scripts/package-extension.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, 'extension');
const run = promisify(execFile);

function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, 'zip end record is missing');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, uncompressed);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('the extension stays a local-only MV3 handoff with no page access', async () => {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'contextMenus']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:4317/*', 'http://localhost:4317/*']);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  for (const size of [16, 32, 48, 128]) {
    const icon = await readFile(path.join(directory, manifest.icons[String(size)]));
    assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  await run(process.execPath, ['--check', path.join(directory, 'background.js')], { cwd: root });
  await run(process.execPath, ['--check', path.join(directory, 'lib.mjs')], { cwd: root });
});

test('handoff only accepts ordinary public page URLs and never the reader itself', () => {
  assert.equal(handoffURL('https://example.com/articles/1?q=2#part'), 'https://example.com/articles/1?q=2#part');
  assert.equal(handoffURL('http://example.com/'), 'http://example.com/');
  assert.equal(handoffURL(' https://example.com/trimmed '), 'https://example.com/trimmed');
  for (const value of ['', 'not a url', '/relative', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://extensions',
    'https://user:secret@example.com/', 'http://127.0.0.1:4317/', 'http://localhost:4317/reading']) {
    assert.equal(handoffURL(value), '', String(value));
  }
});

test('reader launch URLs validate job ids and encode the pending article address', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(readerJobURL(id), `http://127.0.0.1:4317/?job=${id}`);
  assert.equal(readerJobURL('../../api/setup'), '');
  assert.equal(readerJobURL('not-a-job'), '');
  assert.equal(readerPendingURL('https://example.com/a?x=1&y=2'),
    'http://127.0.0.1:4317/?pending=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2');
});

test('the extension package is deterministic and contains runtime files only', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'shiye-extension-zip-'));
  try {
    const first = await packageExtension({ out: path.join(temporary, 'first.zip') });
    const second = await packageExtension({ out: path.join(temporary, 'second.zip') });
    assert.equal(first.hash, second.hash);
    const entries = unzip(await readFile(first.target));
    assert.deepEqual([...entries.keys()].sort(),
      ['background.js', 'icons/icon128.png', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'lib.mjs', 'manifest.json']);
    for (const name of ['background.js', 'lib.mjs', 'manifest.json']) {
      assert.deepEqual(entries.get(name), await readFile(path.join(directory, name)));
    }
    for (const size of [16, 32, 48, 128]) {
      assert.equal(entries.get(`icons/icon${size}.png`).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    assert.equal(JSON.parse(entries.get('manifest.json')).version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
    assert.equal(entries.has('README.md'), false);
    assert.equal(entries.has('package.json'), false);
    assert.throws(() => buildZip([{ name: '../escape.js', data: Buffer.from('x') }]), /文件名无效/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
