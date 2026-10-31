import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelSettings, validateSettings, loadEnvironment } from '../lib/settings.mjs';
import { callCompletion, createModelRuntime, commandAvailable } from '../lib/providers.mjs';
import { translateArticle } from '../lib/translate.mjs';
import { translateImage } from '../lib/images.mjs';

const response = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const fixtureEnv = { READER_API_BASE_URL: 'https://models.example/v1', READER_TEXT_MODEL: 'text-fixture', READER_IMAGE_MODEL: 'vision-fixture', READER_API_KEY: 'test-only-credential' };

test('non-secret settings persist, environment takes priority and distinct image endpoints never inherit text credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-settings-'));
  try {
    const settings = await new ModelSettings(directory, fixtureEnv).init();
    await settings.save({ textProvider: 'api', imageProvider: 'api', apiBaseURL: 'https://saved.example/v1', textModel: 'saved' });
    assert.equal(settings.current().apiBaseURL, fixtureEnv.READER_API_BASE_URL);
    assert.equal(settings.public().apiKeyConfigured, true);
    assert(!JSON.stringify(settings.public()).includes(fixtureEnv.READER_API_KEY));
    assert(!(await readFile(settings.file, 'utf8')).includes(fixtureEnv.READER_API_KEY));
    assert.equal(settings.key('image'), fixtureEnv.READER_API_KEY);
    const separate = new ModelSettings(directory, { ...fixtureEnv, READER_IMAGE_API_BASE_URL: 'https://vision.example/v1' });
    assert.equal(separate.key('image'), '');
    separate.env = { ...separate.env, READER_IMAGE_API_KEY: 'image-test-only' };
    assert.equal(separate.key('image'), 'image-test-only');
    await assert.rejects(() => settings.save({ apiKey: 'must-not-save' }), /未知字段/);
    const reloaded = await new ModelSettings(directory, {}).init();
    assert.equal(reloaded.current().apiBaseURL, 'https://saved.example/v1');
    for (const apiBaseURL of ['http://remote.example/v1', 'https://user:pass@example.com', 'https://example.com/v1?key=value', 'file:///tmp/test']) assert.throws(() => validateSettings({ apiBaseURL }));
    assert.equal(validateSettings({ apiBaseURL: 'http://127.0.0.1:11434/v1/' }).apiBaseURL, 'http://127.0.0.1:11434/v1');
    await writeFile(settings.file, '{broken');
    await assert.rejects(() => new ModelSettings(directory, {}).init(), /原文件未被覆盖/);
    assert.equal(await readFile(settings.file, 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('.env loading keeps existing environment values and tolerates an absent file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-env-'));
  const previous = process.env.READER_TEST_SETTING;
  try {
    const filename = path.join(directory, '.env');
    await writeFile(filename, 'READER_TEST_SETTING=from-file\n');
    process.env.READER_TEST_SETTING = 'from-process'; loadEnvironment(filename);
    assert.equal(process.env.READER_TEST_SETTING, 'from-process');
    delete process.env.READER_TEST_SETTING; loadEnvironment(filename);
    assert.equal(process.env.READER_TEST_SETTING, 'from-file');
    loadEnvironment(path.join(directory, 'missing'));
  } finally {
    if (previous === undefined) delete process.env.READER_TEST_SETTING; else process.env.READER_TEST_SETTING = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('compatible text requests use configured endpoints without CLI tools and retain Markdown translation behavior', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-api-text-'));
  try {
    const settings = await new ModelSettings(directory, fixtureEnv).init();
    const runtime = createModelRuntime(settings, { findCommand: async () => false, agent: async () => { throw new Error('must not launch CLI'); }, fetcher: async (url, options) => {
      assert.equal(url, 'https://models.example/v1/chat/completions'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${fixtureEnv.READER_API_KEY}`);
      const input = JSON.parse(options.body); assert.equal(input.model, 'text-fixture'); assert.equal(input.stream, false);
      assert.match(input.messages[0].content, /保留 Markdown/); assert.equal(input.tools, undefined);
      return response('# 中文标题\n\n完整译文。');
    } });
    assert.equal((await runtime.describe()).textProvider, 'api');
    assert.equal(await translateArticle({ title: 'Title', original: 'A complete article.' }, 'api', directory, () => {}, runtime.run), '# 中文标题\n\n完整译文。');
    await assert.rejects(() => runtime.resolve('__proto__'), /尚未就绪/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image API receives actual base64 pixels and produces the same bounded SVG pipeline without filesystem tool instructions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-api-image-'));
  try {
    const settings = await new ModelSettings(directory, fixtureEnv).init();
    const runtime = createModelRuntime(settings, { findCommand: async () => false, fetcher: async (_url, options) => {
      const input = JSON.parse(options.body); assert.equal(input.model, 'vision-fixture');
      assert.equal(input.messages[0].content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
      assert.match(input.messages[0].content[0].text, /查看本次附带的图片/);
      assert(!input.messages[0].content[0].text.includes('read_file'));
      assert(!input.messages[0].content[0].text.includes(directory));
      return response(JSON.stringify({ status: 'done', kind: 'text', summary: '中文图', scene: { width: 100, height: 100, background: '#e7dfd4', elements: [{ type: 'text', x: 10, y: 30, text: '中文' }] } }));
    } });
    const result = await translateImage({ source: 'https://example.com/fixture.png' }, directory, { imageProvider: 'api', agent: runtime.run, download: async () => png });
    assert.equal(result.filename, 'translated.svg'); assert.equal(result.insight.scene.sourceSize.width, 1);
    assert.match(await readFile(path.join(directory, 'translated.svg'), 'utf8'), /#e7dfd4/);
    await assert.rejects(() => readFile(path.join(directory, '.agents', 'agents', 'quiet-reader-image.md')), { code: 'ENOENT' });
    assert.equal(result.timings.mode, 'model');
    await assert.rejects(() => runtime.run('api', 'text', directory, { image: true }), /图片内容/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing vision is independent of usable text and existing CLI adapters remain available', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-capabilities-'));
  try {
    const settings = await new ModelSettings(directory, { READER_API_BASE_URL: 'http://localhost:11434/v1', READER_TEXT_MODEL: 'local-text', READER_IMAGE_PROVIDER: 'none' }).init();
    const runtime = createModelRuntime(settings, { findCommand: async () => false });
    assert.equal((await runtime.describe()).textReady, true); assert.equal((await runtime.describe()).imageReady, false);
    assert.equal(await runtime.resolve(null, 'image'), 'none');
    await settings.save({ textProvider: 'codex', imageProvider: 'none' });
    let called = false;
    const cli = createModelRuntime(settings, { findCommand: async name => name === 'codex', agent: async provider => { assert.equal(provider, 'codex'); called = true; return '译文'; } });
    assert.equal(await cli.run('codex', 'translate', directory), '译文'); assert(called);
    assert.equal(await commandAvailable(process.execPath), true);
    assert.equal(await commandAvailable('reader-nonexistent-command', { PATH: directory }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP errors, malformed responses and transport failures never expose service bodies or credentials', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(() => callCompletion({ baseURL: 'https://example.com/v1', model: 'fixture', prompt: 'test', imageData: 'data:image/png;base64,AA==', fetcher: async () => new Response('private provider body', { status }) }), error => !error.message.includes('private provider body') && (status !== 429 || error.code === 'IMAGE_RATE_LIMIT'));
  }
  const options = { baseURL: 'https://example.com/v1', model: 'fixture', prompt: 'test' };
  await assert.rejects(() => callCompletion({ ...options, fetcher: async () => { throw Object.assign(new Error('test-only-credential'), { code: 'ECONNRESET' }); } }), error => error.code === 'MODEL_CONNECTION' && !error.message.includes('test-only-credential'));
  for (const value of ['not JSON', JSON.stringify({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }), JSON.stringify({ choices: [{ message: { content: '' } }] })]) {
    await assert.rejects(() => callCompletion({ ...options, fetcher: async () => new Response(value) }), error => error.code === 'MODEL_OUTPUT');
  }
  await assert.rejects(() => callCompletion({ ...options, timeout: 1, fetcher: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))) }), error => error.code === 'MODEL_TIMEOUT');
});

test('Windows command lookup skips .cmd/.bat shims and accepts .exe', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quiet-reader-win-command-'));
  try {
    await writeFile(path.join(directory, 'fake.cmd'), '');
    const env = { PATH: directory, PATHEXT: '.exe;.cmd' };
    assert.equal(await commandAvailable('fake', env, 'win32'), false);
    await writeFile(path.join(directory, 'fake.exe'), '');
    assert.equal(await commandAvailable('fake', env, 'win32'), true);
    assert.equal(await commandAvailable('fake.cmd', env, 'win32'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('default provider stays API and never silently falls back to a local agent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quiet-reader-default-provider-'));
  try {
    const settings = await new ModelSettings(directory, {}).init();
    const runtime = createModelRuntime(settings, { findCommand: async () => true });
    const report = await runtime.describe();
    assert.equal(report.textProvider, 'api');
    assert.equal(report.textReady, false);
    assert.equal(report.text.agy, true);
    assert.equal(report.imageProvider, 'api');
    await assert.rejects(() => runtime.resolve(null), error => error.code === 'MODEL_NOT_CONFIGURED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('API keys can be saved locally without entering settings.json or the browser', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quiet-reader-secrets-'));
  try {
    const settings = await new ModelSettings(directory, {}).init();
    await settings.save({ textProvider: 'api', imageProvider: 'api', apiBaseURL: 'https://text.example/v1', imageApiBaseURL: 'https://image.example/v1', textModel: 'text', imageModel: 'vision' });
    await settings.saveKeys({ apiKey: 'text-secret-fixture' });
    assert.equal(settings.key('text'), 'text-secret-fixture'); assert.equal(settings.key('image'), '');
    await settings.saveKeys({ imageApiKey: 'image-secret-fixture' });
    assert.equal(settings.key('image'), 'image-secret-fixture');
    assert.equal(settings.public().apiKeyConfigured, true); assert.equal(settings.public().imageApiKeyConfigured, true);
    assert(!(await readFile(path.join(directory, 'settings.json'), 'utf8')).includes('secret-fixture'));
    assert((await readFile(path.join(directory, 'secrets.json'), 'utf8')).includes('secret-fixture'));
    await settings.saveKeys({ apiKey: '' }); assert.equal(settings.key('text'), '');
    const env = await new ModelSettings(directory, { READER_API_KEY: 'env-key' }).init();
    assert.equal(env.key('text'), 'env-key'); assert.equal(env.public().apiKeyManagedByEnvironment, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
