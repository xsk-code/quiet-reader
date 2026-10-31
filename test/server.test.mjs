import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = 'https://example.com/integration.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('API-only installation handles setup, text, optional vision, probes and private credentials without local Agents', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-server-api-'));
  let child, backend, portHolder, authFailure = false, failSecondChunk = false;
  const calls = [];
  try {
    backend = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        assert.equal(req.headers.authorization, 'Bearer integration-fixture-only');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'text-fixture' }, { id: 'vision-fixture' }] }));
        return;
      }
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); calls.push(input);
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer integration-fixture-only');
      if (authFailure) { res.writeHead(401); res.end('integration-fixture-only must never reach browser'); return; }
      const image = Array.isArray(input.messages[0].content);
      const prompt = image ? input.messages[0].content[0].text : input.messages[0].content;
      const probe = /connection test|test image/.test(prompt);
      if (failSecondChunk && /Beta sentence/.test(prompt)) { failSecondChunk = false; res.writeHead(401); res.end(); return; }
      if (/Alpha sentence|Beta sentence/.test(prompt)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: /Alpha sentence/.test(prompt) ? '# Long translated\n\nAlpha done.' : 'Beta done.' }, finish_reason: 'stop' }] })); return;
      }
      const text = probe ? 'OK' : image ? JSON.stringify({ status: 'done', kind: 'text', summary: '中文图', scene: { width: 100, height: 100, background: '#e7dfd4', elements: [{ type: 'text', text: '集成验证' }] } }) : `# 中文文章\n\n正文翻译已完成。\n\n![图](${source})`;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
    });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    portHolder = http.createServer(); portHolder.listen(0, '127.0.0.1'); await once(portHolder, 'listening');
    const port = portHolder.address().port; await new Promise(resolve => portHolder.close(resolve));
    const config = { textProvider: 'api', imageProvider: 'none', apiBaseURL: `http://127.0.0.1:${backend.address().port}/v1`, textModel: 'text-fixture', imageModel: '', imageApiBaseURL: '' };
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify(config));
    const env = { ...process.env, PORT: String(port), READER_DATA_DIR: directory, AGY_BIN: path.join(directory, 'no-agy'), CODEX_BIN: path.join(directory, 'no-codex'), READER_API_KEY: 'integration-fixture-only', READER_IMAGE_API_KEY: '' };
    for (const name of ['READER_TEXT_PROVIDER', 'READER_IMAGE_PROVIDER', 'READER_API_BASE_URL', 'READER_IMAGE_API_BASE_URL', 'READER_TEXT_MODEL', 'READER_IMAGE_MODEL']) env[name] = '';
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain startup output without printing environment or service data in test logs.
    child.stdout.resume(); child.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    const request = async (url, method = 'GET', body, headers) => {
      const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try { ready = (await request('/api/status')).status === 200; } catch {}
      if (ready) break; assert.equal(child.exitCode, null); await sleep(20);
    }
    assert(ready, 'isolated server did not start');
    const health = await request('/api/health');
    assert.equal(health.status, 200); assert.equal(health.body.ok, true); assert.match(health.body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(health.body.textReady, true); assert.equal(health.body.imageReady, false);
    // The browser extension may hand over one URL, but nothing else.
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const preflight = await fetch(base + '/api/import', { method: 'OPTIONS', headers: {
      Origin: extension, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), extension);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.equal((await fetch(base + '/api/setup', { method: 'OPTIONS', headers: { Origin: extension, 'Access-Control-Request-Method': 'GET' } })).status, 403);
    assert.equal((await fetch(base + '/api/setup', { headers: { Origin: extension } })).status, 403);
    assert.equal((await fetch(base + '/api/articles', { headers: { Origin: extension } })).status, 403);
    assert.equal((await fetch(base + '/api/import', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'POST' } })).status, 403);
    assert.equal((await fetch(base + '/api/health', { headers: { Origin: extension } })).status, 403);
    let report = (await request('/api/setup')).body;
    assert.equal(report.textReady, true); assert.equal(report.imageReady, false);
    assert(!JSON.stringify(report).includes('integration-fixture-only'));
    const savedKey = await request('/api/setup', 'PUT', { ...config, apiKey: 'ui-saved-key-fixture' });
    assert.equal(savedKey.status, 200, JSON.stringify(savedKey.body)); assert(!JSON.stringify(savedKey.body).includes('ui-saved-key-fixture'));
    assert(!(await readFile(path.join(directory, 'settings.json'), 'utf8')).includes('ui-saved-key-fixture'));
    assert((await readFile(path.join(directory, 'secrets.json'), 'utf8')).includes('ui-saved-key-fixture'));
    assert(!JSON.stringify((await request('/api/setup')).body).includes('ui-saved-key-fixture'));
    const models = await request('/api/setup/models', 'POST', { baseURL: config.apiBaseURL });
    assert.equal(models.status, 200); assert.deepEqual(models.body.models, ['text-fixture', 'vision-fixture']);
    assert(!JSON.stringify(models.body).includes('integration-fixture-only'));
    assert.equal((await request('/api/setup', 'GET', undefined, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await request('/api/setup', 'PUT', { unknownField: 'must-not-save' })).status, 400);
    assert.equal((await request('/api/setup/probe', 'POST', { kind: 'text' })).body.ok, true);
    const imported = await request('/api/import', 'POST', { content: `# Fixture\n\nAn article long enough to translate and preserve its illustration.\n\n![image](${source})`, provider: 'api' });
    assert.equal(imported.status, 202);
    let job;
    for (let index = 0; index < 100; index++) { job = (await request(`/api/jobs/${imported.body.id}`)).body; if (['done', 'error'].includes(job.status)) break; await sleep(20); }
    assert.equal(job.status, 'done');
    let article = (await request('/api/articles')).body[0];
    assert.equal(article.imageTranslation.status, 'disabled'); assert(article.translated.includes(source));
    const imageId = createHash('sha256').update(source).digest('hex').slice(0, 24);
    const imageDirectory = path.join(directory, 'articles', article.id, 'images', imageId);
    await mkdir(imageDirectory, { recursive: true }); await writeFile(path.join(imageDirectory, 'source.png'), png);
    await writeFile(path.join(imageDirectory, 'recognition.json'), JSON.stringify({ version: 1, source, sourceFile: 'source.png', hash: createHash('sha256').update(png).digest('hex'), output: 'invalid previous result' }));
    const configured = await request('/api/setup', 'PUT', { ...config, imageProvider: 'api', imageModel: 'vision-fixture' });
    assert.equal(configured.status, 200); assert.equal(configured.body.imageReady, true);
    assert.equal((await request(`/api/articles/${article.id}/images`, 'POST', { redraw: true })).status, 202);
    for (let index = 0; index < 100; index++) { article = (await request('/api/articles')).body[0]; if (['done', 'error'].includes(article.imageTranslation.status)) break; await sleep(20); }
    assert.equal(article.imageTranslation.status, 'done'); assert.match(article.translated, /translated\.svg/);
    const image = article.imageTranslation.items[0];
    const media = await fetch(base + image.url); assert.equal(media.status, 200); assert.match(media.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await media.text(), /集成验证/); assert(calls.some(input => input.model === 'vision-fixture'));
    assert((await readFile(path.join(imageDirectory, 'timings.json'), 'utf8')).includes('recognizingMs'));
    assert(!(await readFile(path.join(directory, 'settings.json'), 'utf8')).includes('integration-fixture-only'));
    let imageProbe;
    for (let index = 0; index < 50; index++) { imageProbe = await request('/api/setup/probe', 'POST', { kind: 'image' }); if (imageProbe.status === 200) break; await sleep(20); }
    assert.equal(imageProbe.body.ok, true);
    assert.equal(article.targetLanguage, 'zh-CN');
    assert(report.languages.some(language => language.code === 'en'));
    assert.equal((await request('/api/import', 'POST', { content: 'An article long enough to be accepted for translation.', targetLanguage: 'xx' })).status, 400);
    // A permanent failure on the second chunk keeps the first; the retry only pays for the rest.
    failSecondChunk = true;
    const longArticle = `# Long\n\n${'Alpha sentence. '.repeat(500)}\n\n${'Beta sentence. '.repeat(500)}`;
    const long = await request('/api/import', 'POST', { content: longArticle, provider: 'api', targetLanguage: 'en' });
    assert.equal(long.status, 202);
    for (let index = 0; index < 100; index++) { job = (await request(`/api/jobs/${long.body.id}`)).body; if (['done', 'error'].includes(job.status)) break; await sleep(20); }
    assert.equal(job.status, 'error'); assert.match(job.message, /已保存 1 \/ 2 段/);
    const textPrompts = () => calls.filter(input => typeof input.messages[0].content === 'string');
    assert(textPrompts().filter(input => /Alpha sentence/.test(input.messages[0].content)).every(input => /English/.test(input.messages[0].content)));
    const retried = await request(`/api/articles/${job.articleId}/translate`, 'POST', { provider: 'api', targetLanguage: 'en' });
    assert.equal(retried.status, 202);
    for (let index = 0; index < 100; index++) { job = (await request(`/api/jobs/${retried.body.id}`)).body; if (['done', 'error'].includes(job.status)) break; await sleep(20); }
    assert.equal(job.status, 'done', job.message);
    assert.equal(textPrompts().filter(input => /Alpha sentence/.test(input.messages[0].content)).length, 1);
    const longSaved = (await request('/api/articles')).body.find(item => item.id === job.articleId);
    assert.equal(longSaved.translated, '# Long translated\n\nAlpha done.\n\nBeta done.');
    assert.equal(longSaved.targetLanguage, 'en'); assert.equal(longSaved.translationDraft, null);
    // A handoff from the extension queues and finishes like any local import.
    const handoff = await fetch(base + '/api/import', { method: 'POST', headers: { Origin: extension, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'An article handed over by the browser extension and long enough to translate.', targetLanguage: 'en' }) });
    assert.equal(handoff.status, 202);
    assert.equal(handoff.headers.get('access-control-allow-origin'), extension);
    const handoffJob = await handoff.json();
    assert.match(handoffJob.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (let index = 0; index < 100; index++) { job = (await request(`/api/jobs/${handoffJob.id}`)).body; if (['done', 'error'].includes(job.status)) break; await sleep(20); }
    assert.equal(job.status, 'done', job.message);
    assert((await request('/api/articles')).body.some(item => item.id === job.articleId && item.status === 'ready'));
    const extensionRejected = await fetch(base + '/api/import', { method: 'POST', headers: { Origin: extension, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(extensionRejected.status, 400);
    assert.equal(extensionRejected.headers.get('access-control-allow-origin'), extension);
    authFailure = true;
    const rejected = await request('/api/setup/probe', 'POST', { kind: 'text' });
    assert.equal(rejected.status, 502); assert.equal(rejected.body.code, 'MODEL_HTTP'); assert.equal(rejected.body.upstreamStatus, 401);
    assert(!JSON.stringify(rejected.body).includes('integration-fixture-only'));
    authFailure = false;
    report = (await request('/api/setup', 'PUT', { ...config, textModel: '', imageProvider: 'none' })).body;
    assert.equal(report.textReady, false);
    const unconfigured = await request('/api/import', 'POST', { content: 'This article should not queue without a configured provider.' });
    assert.equal(unconfigured.status, 409); assert.equal(unconfigured.body.code, 'MODEL_NOT_CONFIGURED');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    if (backend) await new Promise(resolve => backend.close(resolve));
    if (portHolder?.listening) await new Promise(resolve => portHolder.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
